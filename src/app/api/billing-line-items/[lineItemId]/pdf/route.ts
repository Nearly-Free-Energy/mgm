/**
 * GET /api/billing-line-items/[lineItemId]/pdf
 *
 * PDF1b (#203) — operator-facing one-click bill download. Renders a single
 * line item as a one-page consumer PDF (Aaron's NFE template), embedding
 * the stable `/pay` redirect URL.
 *
 * Per AC4 (refined 2026-04-29):
 *   - Auth gate first (401 on no session) — pattern matches BC1 / usage route.
 *   - Session-bound Supabase client (`@/lib/supabase/server`) — RLS via
 *     `user_can_access_microgrid()` is the access gate. Service-role is used
 *     only for the storage logo download.
 *   - Permission gate (`rolesCanAccessMicrogrid` on the row's org, with the
 *     role rows read alongside the row) — defense-in-depth after the row
 *     load.
 *     Production: RLS hides the row → 404 fires first; unit tests: row
 *     visible, role rows toggled to assert 403.
 *   - Embed the stable MGM `/pay` link when the Payments capability reports
 *     the community ready (or sandbox). Rendering never creates a checkout:
 *     the provider order is submitted when the customer follows the link.
 *     Otherwise proceed with `paymentRedirectUrl = null` (renderer omits the
 *     card).
 *   - Generate `invoice_number` on first render via `fn_next_invoice_number`
 *     + `formatInvoiceNumber`; persist to `billing_line_items.invoice_number`
 *     with an UPDATE that only matches while the bill has no number, and
 *     render the bill as that UPDATE returns it, not as first read: a
 *     regeneration that committed in between leaves its figures under the
 *     number. When the UPDATE matches no row (another download numbered the
 *     bill first) or fails with 23505 (UNIQUE violation), re-read the bill
 *     and render it with the number it has; never a number that was not
 *     stored.
 *   - Logo bytes via service-role `storage.from('invoice-logos').download(path)`
 *     (direct download, NOT signed URLs — service-role bypasses RLS).
 *   - Response: `application/pdf`, `Content-Disposition: attachment;
 *     filename="<invoiceNumber>.pdf"`, `Cache-Control: no-store`.
 *
 * Idempotency contract (AC4): two consecutive calls for the same lineItemId
 * return the same `invoice_number`, the same `pesapal_redirect_url`, and do
 * NOT increment the per-community-per-year counter or mint a new Pesapal
 * session. PDF3's row action depends on this.
 */

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { ZodError } from "zod";

import {
  getCurrentUserRoles,
  rolesCanAccessMicrogrid,
} from "@/lib/auth/access";
import { composePayments } from "@/lib/payments/compose";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

import { formatInvoiceNumber } from "@/lib/invoices/invoice-number";
import { renderInvoicePdf } from "@/lib/invoices/render";
import type {
  BillingLineItem,
  Community,
  Device,
  Tenant,
  Organization,
  RateSchedule,
} from "@/lib/types/domain";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres "unique_violation" — fires when two concurrent first-renders
// both pass the IS NULL guard on `invoice_number`.
const PG_UNIQUE_VIOLATION = "23505";

/**
 * The bill's own columns the renderer takes. Read with the joins below, and
 * again with the invoice number stored, so the PDF shows the bill as it is
 * under that number.
 */
const BILL_COLUMNS = `
      id,
      created_at,
      device_id,
      end_kwh,
      entered_at,
      entered_by_user_id,
      tenant_id,
      invoice_number,
      manual_reason,
      paid_at,
      paid_by_user_id,
      payment_failed_at,
      payment_notes,
      payment_refunded_at,
      payment_status,
      pesapal_order_id,
      pesapal_redirect_url,
      reading_source,
      short_slug,
      start_kwh,
      tier_breakdown,
      total_amount,
      usage_kwh,
      updated_at,
      billing_period_id`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<NextResponse> {
  const { lineItemId } = await params;

  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "Invalid line item id — expected UUID.", reason: "bad_request" },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // 1. Auth gate (BC1 AC6 pattern).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized.", reason: "unauthorized" },
      { status: 401 },
    );
  }

  // 2. Resolve line item + scope joins. RLS hides cross-org rows → 404.
  //    The shape of this select is the union of all fields the renderer
  //    needs PLUS the IDs needed for downstream queries (org_id, microgrid_id,
  //    rate-schedule lookup, tenant-device join). The caller's role rows
  //    for step 3 load alongside it, for the user read above.
  const scopedRead = supabase
    .from("billing_line_items")
    .select(
      `${BILL_COLUMNS},
      billing_periods!inner (
        id,
        microgrid_id,
        start_date,
        end_date,
        timezone,
        rate_schedule_id,
        microgrids!inner (
          id,
          community_id,
          currency,
          communities!inner (
            id,
            invoice_config,
            invoice_prefix,
            name,
            org_id,
            payment_provider,
            payment_provider_config,
            payment_last_configured_at,
            organizations!inner (
              id,
              name,
              created_at
            )
          )
        )
      ),
      tenants!inner (
        id,
        account_number,
        address_city,
        address_country,
        address_line1,
        address_line2,
        address_postal_code,
        address_region,
        created_at,
        customer_type,
        display_name,
        geography_notes,
        meter_serial,
        meter_type,
        microgrid_id,
        primary_email,
        primary_phone,
        unit_label
      )
    `,
    )
    .eq("id", lineItemId)
    .maybeSingle();
  const [{ data: scopedRaw, error: scopedErr }, roles] = await Promise.all([
    scopedRead,
    getCurrentUserRoles(supabase, user),
  ]);

  if (scopedErr) {
    return NextResponse.json(
      {
        error: `Failed to look up line item: ${scopedErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 },
    );
  }
  if (!scopedRaw) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  // PostgREST may return joined !inner singletons either as objects or as
  // single-element arrays depending on the rest version. Normalize.
  const scoped = scopedRaw as unknown as Record<string, unknown>;
  const period = unwrap(scoped.billing_periods);
  const microgrid = period ? unwrap(period.microgrids) : null;
  const community = microgrid ? unwrap(microgrid.communities) : null;
  const organization = community ? unwrap(community.organizations) : null;
  const tenant = unwrap(scoped.tenants);

  if (!period || !microgrid || !community || !organization || !tenant) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  const microgridId = period.microgrid_id as string;
  const communityId = microgrid.community_id as string;

  // 3. Defense-in-depth permission check. Tests exercise this branch with
  //    a mocked-visible row; production would have already 404'd via RLS.
  //    The row's microgrid → community join has already resolved the org,
  //    so this decides with currentUserCanAccessMicrogrid's own predicate
  //    instead of having that helper look the org up again.
  if (!rolesCanAccessMicrogrid(roles, community.org_id as string)) {
    return NextResponse.json(
      {
        error: "You do not have permission to download this bill.",
        reason: "forbidden",
      },
      { status: 403 },
    );
  }

  // Steps 6-9 read the meter, the pinned tariff, the "entered by" name and
  // the logo. They need only the row above and write nothing, so they start
  // now and load while the payment link and invoice number resolve; each
  // result is still checked at its own step, in the original order, so a
  // request gets the same response as when they ran one after another.
  const meterDeviceRead = readMeterDevice(supabase, tenant.id as string);
  const pinnedScheduleId = period.rate_schedule_id as string | null;
  const rateScheduleRead = pinnedScheduleId
    ? Promise.resolve(
        supabase
          .from("rate_schedules")
          .select(
            "id, created_at, microgrid_id, service_charge, service_charge_description, tax_rate, tiers",
          )
          .eq("id", pinnedScheduleId)
          .eq("microgrid_id", microgridId)
          .maybeSingle(),
      )
    : null;
  const enteredByUserNameRead = readEnteredByUserName(supabase, scoped);
  const logoDownload = downloadInvoiceLogo(community);
  // Each read is awaited at its own step, which still sees its failure (the
  // logo's is logged at step 9). A request can end before then, by returning
  // early or because the payment link step throws; the no-op catches stop a
  // read that failed meanwhile counting as an unhandled rejection.
  meterDeviceRead.catch(() => {});
  rateScheduleRead?.catch(() => {});
  enteredByUserNameRead.catch(() => {});
  logoDownload.catch(() => {});

  // Invoice rendering never creates a checkout. Embed only a stable MGM
  // link; provider submission happens when the customer follows that link.
  let paymentRedirectUrl: string | null = null;
  if (isReleasedRoute(`/api/billing-line-items/${lineItemId}/pay`)) {
    const composed = await composePayments({ supabase, organizationId: community.org_id as string, allowDisabled: true });
    if (composed.ok) {
      try {
        const ready = await composed.data.payments.getReadiness(communityId);
        if (ready.ok && ["ready", "sandbox"].includes(ready.data.state)) {
          const link = await composed.data.payments.stablePaymentLink(lineItemId);
          if (link.ok) paymentRedirectUrl = link.data.url;
        }
      } finally { await composed.data.dispose(); }
    }
  }

  // 5. Resolve / generate invoice number. `bill` is the bill the PDF shows:
  //    the one read above when it already had a number, else the one stored
  //    with the number this request or a concurrent one gave it.
  let bill: Record<string, unknown> = scoped;
  let invoiceNumber = (scoped.invoice_number as string | null) ?? null;
  if (!invoiceNumber) {
    const prefix = community.invoice_prefix as string | null;
    if (!prefix) {
      return NextResponse.json(
        {
          error:
            "Cannot generate bill — community has no invoice prefix configured.",
          reason: "missing_invoice_prefix",
        },
        { status: 422 },
      );
    }
    const year = new Date().getUTCFullYear();
    const { data: counter, error: counterErr } = await supabase.rpc(
      "fn_next_invoice_number",
      { p_community_id: communityId, p_year: year },
    );
    if (counterErr || counter == null) {
      return NextResponse.json(
        {
          error:
            "Failed to allocate invoice number. Please try again or contact support.",
          reason: "invoice_number_allocation_failed",
          details: counterErr?.message ?? null,
        },
        { status: 500 },
      );
    }
    const allocated = formatInvoiceNumber(prefix, year, counter as number);

    // The UPDATE takes the bill's row lock. A per-bill regeneration
    // (fn_regenerate_bill_with_audit) refuses a bill that has a number, so
    // one that commits first leaves its figures here, and this UPDATE, which
    // waited for it, stores the number on them. The row it returns is that
    // bill, which is the one the PDF shows; the bill read in step 2 can have
    // another total (20261119090000_regenerate_bill_expected_state.sql).
    const { data: stored, error: updateErr } = await supabase
      .from("billing_line_items")
      .update({ invoice_number: allocated })
      .eq("id", lineItemId)
      .is("invoice_number", null)
      .select(BILL_COLUMNS)
      .maybeSingle();

    if (updateErr && updateErr.code !== PG_UNIQUE_VIOLATION) {
      return NextResponse.json(
        {
          error: `Failed to persist invoice number: ${updateErr.message}`,
          reason: "invoice_number_persist_failed",
        },
        { status: 500 },
      );
    }
    if (!updateErr && stored) {
      bill = stored as unknown as Record<string, unknown>;
      invoiceNumber = allocated;
    } else {
      // Another download numbered the bill first: the UPDATE matched no row,
      // or 23505 when both reached the same number. Show the bill as it is
      // under the number it has. The orphaned counter increment is
      // acceptable per AC4's race note.
      const { data: refreshed, error: refreshErr } = await supabase
        .from("billing_line_items")
        .select(BILL_COLUMNS)
        .eq("id", lineItemId)
        .maybeSingle();
      const refreshedRow = refreshed as unknown as Record<string, unknown> | null;
      const refreshedNumber = (refreshedRow?.invoice_number as string | null | undefined) ?? null;
      if (refreshErr || !refreshedRow || !refreshedNumber) {
        return NextResponse.json(
          {
            error:
              "Failed to persist invoice number after concurrent race.",
            reason: "invoice_number_race_unresolved",
          },
          { status: 500 },
        );
      }
      bill = refreshedRow;
      invoiceNumber = refreshedNumber;
    }
  }

  // 6. Resolve meter device (first consumption_meter by created_at, ASC).
  const meterDevice = await meterDeviceRead;

  // 7. Render only the tariff that was used to calculate this period.
  if (!rateScheduleRead) {
    return NextResponse.json(
      { error: "This billed period needs historical tariff reconciliation.", reason: "rate_schedule_unpinned" },
      { status: 409 },
    );
  }
  const { data: rateScheduleRow } = await rateScheduleRead;

  if (!rateScheduleRow) {
    return NextResponse.json(
      {
        error: "This period's pinned rate schedule could not be loaded.",
        reason: "pinned_rate_schedule_unavailable",
      },
      { status: 422 },
    );
  }

  // 8. Resolve "entered by" display name (BC1 — manual readings). Read
  //    again when the bill shown is not the one read in step 2 and its
  //    reading was entered by someone else, or is no longer manual.
  const enteredByUserName =
    bill.entered_by_user_id === scoped.entered_by_user_id && bill.reading_source === scoped.reading_source
      ? await enteredByUserNameRead
      : await readEnteredByUserName(supabase, bill);

  // 9. Logo download via SERVICE ROLE (RLS bypass; renderer takes a Buffer).
  let logoBytes: Buffer | null = null;
  try {
    const download = await logoDownload;
    if (download) {
      const { data: blob, error: dlErr } = download;
      if (dlErr) {
        // Continue without a logo — an unbranded bill is better than no bill.
        console.warn(
          JSON.stringify(
            scrubSecretValues(
              {
                event: "pdf.logo_download_failed",
                line_item_id: lineItemId,
                community_id: communityId,
                err_message: dlErr.message,
                at: new Date().toISOString(),
              },
              {},
            ),
          ),
        );
      } else if (blob) {
        const arrayBuf = await blob.arrayBuffer();
        logoBytes = Buffer.from(arrayBuf);
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify(
        scrubSecretValues(
          {
            event: "pdf.logo_download_threw",
            line_item_id: lineItemId,
            community_id: communityId,
            err_message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          },
          {},
        ),
      ),
    );
  }

  // 10. Build the renderer input bag and call the pure renderer.
  const lineItem: BillingLineItem = {
    id: bill.id as string,
    billing_period_id: bill.billing_period_id as string,
    created_at: bill.created_at as string,
    updated_at: bill.updated_at as string,
    device_id: bill.device_id as string | null,
    end_kwh: bill.end_kwh as number | null,
    entered_at: bill.entered_at as string | null,
    entered_by_user_id: bill.entered_by_user_id as string | null,
    tenant_id: bill.tenant_id as string,
    invoice_number: invoiceNumber,
    manual_reason: bill.manual_reason as string | null,
    paid_at: bill.paid_at as string | null,
    paid_by_user_id: bill.paid_by_user_id as string | null,
    payment_failed_at: bill.payment_failed_at as string | null,
    payment_notes: bill.payment_notes as string | null,
    payment_refunded_at: bill.payment_refunded_at as string | null,
    payment_status: bill.payment_status as BillingLineItem["payment_status"],
    pesapal_order_id: bill.pesapal_order_id as string | null,
    pesapal_redirect_url: (bill.pesapal_redirect_url as string | null) ?? null,
    reading_source: bill.reading_source as BillingLineItem["reading_source"],
    short_slug: (bill.short_slug as string | null) ?? null,
    start_kwh: bill.start_kwh as number | null,
    tier_breakdown: (bill.tier_breakdown as unknown as BillingLineItem["tier_breakdown"]) ?? [],
    total_amount: bill.total_amount as number,
    usage_kwh: bill.usage_kwh as number | null,
  };

  // By this point invoiceNumber is guaranteed non-null (we either read a
  // pre-existing one OR generated + persisted a new one above). The TS
  // narrowing is lost across the various refinement branches, so we
  // re-assert here for the renderer's input bag.
  if (!invoiceNumber) {
    return NextResponse.json(
      {
        error:
          "Internal error: invoice number unresolved at render time.",
        reason: "invoice_number_unresolved",
      },
      { status: 500 },
    );
  }
  const finalInvoiceNumber: string = invoiceNumber;

  let pdfBuf: Buffer;
  try {
    pdfBuf = await renderInvoicePdf({
      lineItem,
      tenant: tenant as unknown as Tenant,
      community: community as unknown as Community,
      organization: organization as unknown as Organization,
      ratesSchedule: rateScheduleRow as unknown as RateSchedule,
      paymentRedirectUrl,
      invoiceNumber: finalInvoiceNumber,
      logoBytes,
      meterDevice,
      enteredByUserName,
      currency: (microgrid.currency as string | null) ?? null,
      billingPeriodStart: period.start_date as string | null,
      billingPeriodEnd: period.end_date as string | null,
      // #358 — the immutable per-period stamp (NOT microgrids.timezone).
      billingPeriodTimezone: period.timezone as string | null,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        {
          error: "Invalid invoice configuration.",
          reason: "invalid_invoice_config",
          issues: err.issues,
        },
        { status: 422 },
      );
    }
    console.error(
      JSON.stringify(
        scrubSecretValues(
          {
            event: "pdf.render_failed",
            line_item_id: lineItemId,
            community_id: communityId,
            err_message: err instanceof Error ? err.message : String(err),
            at: new Date().toISOString(),
          },
          {},
        ),
      ),
    );
    return NextResponse.json(
      {
        error: "Failed to render PDF.",
        reason: "render_failed",
      },
      { status: 500 },
    );
  }

  return new NextResponse(new Uint8Array(pdfBuf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${finalInvoiceNumber}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * PostgREST may return a joined `!inner` relation as either `T` or `T[]`
 * depending on the version + relation cardinality. Normalize to `T | null`.
 */
function unwrap<T = Record<string, unknown>>(
  candidate: unknown,
): (T & Record<string, unknown>) | null {
  if (candidate == null) return null;
  if (Array.isArray(candidate)) {
    return (candidate[0] ?? null) as (T & Record<string, unknown>) | null;
  }
  return candidate as T & Record<string, unknown>;
}

/** Step 6: the tenant's first consumption_meter device by created_at, ASC. */
async function readMeterDevice(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<Device | null> {
  const { data: meterRows } = await supabase
    .from("tenant_devices")
    .select(
      `
      device_id,
      devices!inner (
        id,
        config,
        created_at,
        device_type,
        edge_id,
        name,
        openems_component_id
      )
    `,
    )
    .eq("tenant_id", tenantId)
    .eq("devices.device_type", "consumption_meter")
    .order("created_at", { ascending: true })
    .limit(1);

  if (meterRows && meterRows.length > 0) {
    const dev = unwrap((meterRows[0] as Record<string, unknown>).devices);
    if (dev) return dev as unknown as Device;
  }
  return null;
}

/**
 * Step 8: the "entered by" display name (BC1 — manual readings).
 *
 * #269: the prior `user_directory` view was replaced by the
 * `fn_list_visible_users` RPC. The old select asked for a
 * `display_name` column that never existed on the view (returned
 * null silently); we drop it from the projection here. The RPC's
 * visibility predicate is identical to the view's WHERE clause, so
 * an RLS-hidden actor still surfaces as an empty row set → null name.
 */
async function readEnteredByUserName(
  supabase: SupabaseClient,
  scoped: Record<string, unknown>,
): Promise<string | null> {
  const enteredById = scoped.entered_by_user_id as string | null;
  if (!enteredById || scoped.reading_source !== "manual") return null;

  const { data: dirRows } = await supabase.rpc("fn_list_visible_users", {
    _target_user_ids: [enteredById],
  });
  const dirRow = dirRows?.[0];
  if (!dirRow) return null;
  const composed = [dirRow.first_name, dirRow.last_name]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(" ")
    .trim();
  return (
    (composed.length > 0 ? composed : null) ??
    (dirRow.email as string | null) ??
    null
  );
}

/**
 * Step 9: start the service-role download of the community's invoice logo,
 * or resolve null when no logo is configured. The caller handles the
 * download error, or a throw, by rendering without a logo.
 */
async function downloadInvoiceLogo(community: Record<string, unknown>) {
  const invoiceConfigRaw = community.invoice_config as Record<string, unknown> | null;
  const branding = (invoiceConfigRaw?.branding ?? {}) as Record<string, unknown>;
  const logoPath = branding.logo_storage_path as string | null;
  if (!logoPath || logoPath.trim().length === 0) return null;
  const svc = createServiceClient();
  return svc.storage.from("invoice-logos").download(logoPath);
}
