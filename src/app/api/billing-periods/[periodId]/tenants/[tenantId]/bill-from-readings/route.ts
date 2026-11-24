import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { composeBilling, type BillingResult } from "@/lib/billing/compose";
import { BILL_FROM_READINGS_COPY, BillFromReadingsBody } from "@/lib/billing/schemas";
import { createFmt } from "@/lib/gui/fmt";
import { formatLocale } from "@/lib/locale";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings (#201)
 *
 * Bills one tenant who has no bill in a draft period from the start and end
 * readings typed by hand: the period review's `billing.bill-from-readings`,
 * offered on each row of its Tenants not billed section
 * (src/lib/billing/surface/not-billed.ts). A thin adapter over the billing
 * capability (BillingCapability.billFromReadings), which runs the same
 * engine as BillingCapability.generateBills, with that tenant's manual
 * reading (newBillOnly in src/lib/billing/generate.ts). It adds no billing logic:
 * the same tariff pin, rounding and audit row. Unlike the deleted legacy
 * pre-flight panel's manual rows, it bills one tenant per request, and
 * refuses a closed period and a tenant who already has a bill (whose bill is
 * changed by regenerating it, POST
 * /api/billing-line-items/[lineItemId]/regenerate), where the panel's route
 * overwrote the bill and accepted a closed period.
 *
 * The engine reads the period's status again just before the insert and
 * refuses, writing nothing, if it closed meanwhile. The insert goes through
 * fn_record_first_line_item_with_audit (migration 20261120130100), which
 * writes only while the period is a draft and the tenant has no bill, under
 * the period's lock: a close committing after that read is refused
 * (period_closed), and so is a bill another write inserted for that tenant
 * after the engine read the period's bills (a run from meter data, a manual
 * reading through generateBills, or a second submission of this action),
 * which is left as it is (has_bill). Nothing is written either way.
 *
 * Body (BillFromReadingsBody): { start_kwh, end_kwh, reason? }, kWh of 0 or
 * more, end_kwh not below start_kwh; reason up to 500 characters, trimmed.
 *
 * Responses:
 *   201 → { lineItemId, tenantId, usageKwh, totalAmount, message } — the
 *         bill written; message names the tenant, the usage and the total,
 *         in the microgrid's currency and the request's locale, within the
 *         300 characters the GUI host keeps (invoke.ts)
 *   400 → { error, field?, code: "invalid_body" } (body, or readings that go
 *         backwards); { error, reason: "bad_request" } (an id)
 *   401 → { error: "unauthorized" }
 *   404 → { error, reason: "not_found" } (period or microgrid hidden by RLS:
 *         another organization's, or a tenant-only account's);
 *         { error, reason: "tenant_not_found" } (tenant hidden by RLS)
 *   409 → { error, reason: "period_closed" } (nothing written);
 *         { error, reason: "tenant_not_on_microgrid" };
 *         { error, reason: "has_bill" } (the tenant has a bill, found here,
 *         by the engine's own read or at the insert; nothing written);
 *         { error, reason: "no_tariff" } (no rate schedule to pin);
 *         { error, reason: "tariff_changed" } (nothing written)
 *   500 → { error, reason: "unknown_error" }
 *   and the capability's own refusals (plugin gate, organization scope),
 *   with their fixed copy. Every refusal is fixed copy, never a database's
 *   message.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest tenant name the success message carries, so it stays within the host's 300 characters. */
const MAX_NAME = 80;
const READINGS_INVALID = "The readings are not valid: each is a number of 0 or more, and the end reading is not below the start reading.";

const notFound = () => NextResponse.json({ error: "Billing period not found.", reason: "not_found" }, { status: 404 });
const refuse = (status: number, error: string, reason: string) => NextResponse.json({ error, reason }, { status });
const invalid = (error: string, field?: string) =>
  NextResponse.json({ error, ...(field ? { field } : {}), code: "invalid_body" }, { status: 400 });
const failed = () => refuse(500, BILL_FROM_READINGS_COPY.failed, "unknown_error");

/**
 * The capability's refusals whose message is fixed copy of its own
 * (composeBilling and BillingCapability), passed on as they are. Anything
 * else from it, or from the engine, is mapped to this route's copy below; if
 * the capability adds a refusal with fixed copy, it may be listed here.
 */
const CAPABILITY_REFUSALS = new Set([
  "billing_disabled",
  "billing_gate_unavailable",
  "billing_forbidden",
  "billing_scope_mismatch",
  "billing_unauthenticated",
  "billing_invalid_org",
  "billing_invalid_period",
  "billing_invalid_tenant",
]);

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  if (CAPABILITY_REFUSALS.has(error.code)) {
    return NextResponse.json({ error: error.message, code: error.code, ...(error.reason ? { reason: error.reason } : {}) }, { status: error.status });
  }
  if (error.code === "billing_period_closed") return refuse(409, BILL_FROM_READINGS_COPY.closed, "period_closed");
  if (error.code === "RATE_SCHEDULE_UNPINNED") return refuse(409, BILL_FROM_READINGS_COPY.noTariff, "no_tariff");
  // GenerateBillsBody's refusal of the readings, which this route checked first.
  if (error.code === "billing_invalid_body") return invalid(READINGS_INVALID);
  if (error.status === 404) return notFound();
  return failed();
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ periodId: string; tenantId: string }> },
): Promise<NextResponse> {
  const { periodId, tenantId } = await params;
  if (!UUID_RE.test(periodId)) {
    return NextResponse.json({ error: "Invalid billing period id — expected UUID.", reason: "bad_request" }, { status: 400 });
  }
  if (!UUID_RE.test(tenantId)) {
    return NextResponse.json({ error: "Invalid tenant id — expected UUID.", reason: "bad_request" }, { status: 400 });
  }

  // Before the session check, as on the other billing routes: a malformed body answers 400 whoever sends it.
  const body = await parseJsonBody(request, BillFromReadingsBody);
  if (!body.ok) return body.response;
  const readings = body.data;
  // The schema stays flat (no refinement) so the GUI host can check a
  // prefill against it; the order of the readings is checked here, as the
  // regenerate route checks it.
  if (readings.end_kwh < readings.start_kwh) return invalid("end_kwh must be greater than or equal to start_kwh", "end_kwh");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Read through the person's own client: a period RLS hides is a 404. A
  // failed read is not a missing row: it answers 500.
  const { data: period, error: periodError } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id, status")
    .eq("id", periodId)
    .maybeSingle<{ id: string; microgrid_id: string; status: string }>();
  if (periodError) return failed();
  if (!period) return notFound();
  const { data: microgrid, error: microgridError } = await supabase
    .from("microgrids")
    .select("id, currency, communities!inner(org_id)")
    .eq("id", period.microgrid_id)
    .maybeSingle<{ id: string; currency: string | null; communities: { org_id: string } | { org_id: string }[] }>();
  if (microgridError) return failed();
  const communities = microgrid?.communities;
  const orgId = Array.isArray(communities) ? communities[0]?.org_id : communities?.org_id;
  if (!orgId) return notFound();

  // Organization scope and the billing plugin gate.
  const composed = await composeBilling({ supabase, organizationId: orgId });
  if (!composed.ok) return mapError(composed);

  try {
    // What this route refuses, in this order: billing.bill-from-readings'
    // availability and prepare explain the same refusals in the same order
    // (src/lib/billing/surface/not-billed.ts). The engine checks the period
    // and the tenant's bill again, last before the write.
    if (period.status !== "draft") return refuse(409, BILL_FROM_READINGS_COPY.closed, "period_closed");

    // Another organization's tenant is hidden by RLS: a 404 like a missing one.
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, display_name, microgrid_id")
      .eq("id", tenantId)
      .maybeSingle<{ id: string; display_name: string; microgrid_id: string }>();
    if (tenantError) return failed();
    if (!tenant) return refuse(404, BILL_FROM_READINGS_COPY.tenantNotFound, "tenant_not_found");
    if (tenant.microgrid_id !== period.microgrid_id) return refuse(409, BILL_FROM_READINGS_COPY.otherMicrogrid, "tenant_not_on_microgrid");

    const { data: bill, error: billError } = await supabase
      .from("billing_line_items")
      .select("id")
      .eq("billing_period_id", period.id)
      .eq("tenant_id", tenant.id)
      .maybeSingle<{ id: string }>();
    if (billError) return failed();
    if (bill) return refuse(409, BILL_FROM_READINGS_COPY.hasBill, "has_bill");

    const result = await composed.data.billing.billFromReadings(period.id, tenant.id, {
      startKwh: readings.start_kwh,
      endKwh: readings.end_kwh,
      ...(readings.reason ? { reason: readings.reason } : {}),
    });
    if (!result.ok) return mapError(result);

    // The engine's per-tenant text is never passed on: a failed write's
    // carries the database's message.
    const mine = result.data.results.find((r) => r.tenantId === tenant.id);
    if (mine?.kind === "written") {
      const fmt = createFmt({ locale: formatLocale(request.headers.get("accept-language")) });
      const currency = microgrid?.currency ?? "UGX";
      const usageKwh = Number(mine.lineItem.usage_kwh);
      const totalAmount = Number(mine.lineItem.total_amount);
      const name = tenant.display_name.length > MAX_NAME ? `${tenant.display_name.slice(0, MAX_NAME - 1)}…` : tenant.display_name;
      return NextResponse.json(
        {
          lineItemId: mine.lineItem.id,
          tenantId: tenant.id,
          // NUMERIC columns, which can arrive as strings: answered as numbers.
          usageKwh,
          totalAmount,
          message: `Billed ${name} from the readings entered: ${fmt.energy(usageKwh * 1000, { digits: 3 }).text}. The bill's total is ${fmt.money(totalAmount, currency).text}.`,
        },
        { status: 201 },
      );
    }
    if (mine?.kind === "error") {
      switch (mine.code) {
        case "bill_exists":
          return refuse(409, BILL_FROM_READINGS_COPY.hasBill, "has_bill");
        // The period closed after the engine's last read of its status, and
        // the insert found it closed under the period's lock.
        case "period_closed":
          return refuse(409, BILL_FROM_READINGS_COPY.closed, "period_closed");
        case "unknown_tenant":
          return refuse(409, BILL_FROM_READINGS_COPY.otherMicrogrid, "tenant_not_on_microgrid");
        case "tariff_changed":
          return refuse(409, BILL_FROM_READINGS_COPY.tariffChanged, "tariff_changed");
        case "invalid_manual_reading":
          return invalid(READINGS_INVALID);
      }
    }
    return failed();
  } finally {
    await composed.data.dispose();
  }
}
