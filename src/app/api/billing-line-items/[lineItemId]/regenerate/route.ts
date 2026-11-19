import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { composeBilling, type BillingResult } from "@/lib/billing/compose";
import { REGENERATE_PAID_ACKNOWLEDGEMENT, RegenerateBillBody } from "@/lib/billing/schemas";
import { createFmt } from "@/lib/gui/fmt";
import { formatLocale } from "@/lib/locale";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * POST /api/billing-line-items/[lineItemId]/regenerate (#201)
 *
 * Regenerates one bill: the period review's per-bill action
 * (`billing.regenerate-bill`). A thin adapter over the same capability call
 * POST /api/billing/generate makes, for the bill's one tenant, so a per-row
 * control cannot become a whole-period run. It adds no billing logic.
 *
 * Body (RegenerateBillBody):
 *   { readings: "edge" }                              — from the meter; a
 *     manual bill is switched back to edge data
 *   { readings: "manual", start_kwh, end_kwh, reason? } — the readings given
 *   and, for a paid bill, confirmation: { acknowledged: [REGENERATE_PAID_ACKNOWLEDGEMENT] }:
 *   the acknowledgement billing.regenerate-bill's prepare asks for. This
 *   route refuses a paid bill without it, and a refunded bill outright, but
 *   only on its own requests: POST /api/billing/generate, which the legacy
 *   Regenerate dialogs and Refresh Readings call, rewrites a paid or
 *   refunded bill with no acknowledgement (generate.ts keeps the payment
 *   columns and refuses no payment status). There the paid-bill warning is
 *   the legacy dialog's own, on the client with POST
 *   /api/billing/regenerate-preview, and nothing on the server asks for it.
 *   If generation comes to refuse paid bills itself, say so here.
 *
 * Responses:
 *   200 → { lineItemId, totalAmount, previousTotalAmount, message } — both
 *         totals numbers (previousTotalAmount null for a new bill);
 *         message names the previous and new totals, in the microgrid's
 *         currency and the request's locale; the GUI host shows it as the
 *         action's result
 *   400 → { error, field?, code: "invalid_body" } (body, or a reading the
 *         mode does not take or lacks); { error, reason: "bad_request" } (id)
 *   401 → { error: "unauthorized" }
 *   404 → { error, reason: "not_found" } (bill, period or microgrid hidden by RLS)
 *   409 → { error, reason: "refunded" }, or { error, reason: <generation code> }
 *         when generation refused this tenant (GenerationErrorCode)
 *   428 → { error, reason: "paid_acknowledgement_required" } (a paid bill
 *         without the acknowledgement; nothing is written)
 *   500 → { error, reason: "unknown_error" } (the bill, its period or its
 *         microgrid could not be read, or nothing was written)
 *   and the capability's own refusals (plugin gate, organization scope).
 *
 * The legacy dialogs still call POST /api/billing/generate, which checks no
 * payment status (above).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json({ ...body, error: body.message }, { status });
}

const invalid = (error: string, field: string) =>
  NextResponse.json({ error, field, code: "invalid_body" }, { status: 400 });
const notFound = () => NextResponse.json({ error: "Billing line item not found.", reason: "not_found" }, { status: 404 });
/** A read that failed, with fixed copy: never the database's message. */
const readFailed = (error: string) => NextResponse.json({ error, reason: "unknown_error" }, { status: 500 });

type BillRow = {
  id: string;
  tenant_id: string;
  billing_period_id: string;
  reading_source: "edge" | "manual" | null;
  payment_status: string;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<NextResponse> {
  const { lineItemId } = await params;
  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json({ error: "Invalid line item id — expected UUID.", reason: "bad_request" }, { status: 400 });
  }

  // Before the session check, as on the other bill routes: a malformed body answers 400 whoever sends it.
  const body = await parseJsonBody(request, RegenerateBillBody);
  if (!body.ok) return body.response;
  const parsed = body.data;

  // Which readings each mode takes. The schema stays flat (no refinement) so
  // the GUI host can check a prefill against it; the mode rules live here.
  if (parsed.readings === "edge") {
    const given = (["start_kwh", "end_kwh", "reason"] as const).find((k) => parsed[k] !== undefined);
    if (given) return invalid("Readings are taken from the meter in edge mode", given);
  } else {
    if (parsed.start_kwh === undefined) return invalid("start_kwh is required for manual readings", "start_kwh");
    if (parsed.end_kwh === undefined) return invalid("end_kwh is required for manual readings", "end_kwh");
    if (parsed.end_kwh < parsed.start_kwh) return invalid("end_kwh must be greater than or equal to start_kwh", "end_kwh");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Read through the person's own client: a bill RLS hides is a 404.
  const { data: bill, error: billError } = await supabase
    .from("billing_line_items")
    .select("id, tenant_id, billing_period_id, reading_source, payment_status")
    .eq("id", lineItemId)
    .maybeSingle<BillRow>();
  if (billError) return readFailed("Failed to look up billing line item.");
  if (!bill) return notFound();

  // The organization, as POST /api/billing/generate resolves it. A failed
  // read is not a missing row: it answers 500, as the bill's own read does.
  const { data: period, error: periodError } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id")
    .eq("id", bill.billing_period_id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (periodError) return readFailed("Failed to look up the bill's billing period.");
  if (!period) return notFound();
  const { data: microgrid, error: microgridError } = await supabase
    .from("microgrids")
    .select("id, currency, communities!inner(org_id)")
    .eq("id", period.microgrid_id)
    .maybeSingle<{ id: string; currency: string | null; communities: { org_id: string } | { org_id: string }[] }>();
  if (microgridError) return readFailed("Failed to look up the bill's microgrid.");
  const communities = microgrid?.communities;
  const orgId = Array.isArray(communities) ? communities[0]?.org_id : communities?.org_id;
  if (!orgId) return notFound();

  // Organization scope and the billing plugin gate.
  const composed = await composeBilling({ supabase, organizationId: orgId });
  if (!composed.ok) return mapError(composed);

  try {
    // Refunding then re-billing reads as data corruption; the legacy menu hides it too.
    if (bill.payment_status === "refunded") {
      return NextResponse.json({ error: "A refunded bill cannot be regenerated.", reason: "refunded" }, { status: 409 });
    }
    // Regenerating a paid bill changes what was paid for: the person ticks
    // that they know it is paid, as billing.regenerate-bill's prepare asks.
    if (bill.payment_status === "paid" && !parsed.confirmation?.acknowledged.includes(REGENERATE_PAID_ACKNOWLEDGEMENT)) {
      return NextResponse.json(
        {
          error: "This bill is marked paid. Confirm that you want to regenerate it anyway.",
          reason: "paid_acknowledgement_required",
        },
        { status: 428 },
      );
    }

    const tenantId = bill.tenant_id;
    const result = await composed.data.billing.generateBills(
      parsed.readings === "edge"
        ? {
            billingPeriodId: period.id,
            tenantIds: [tenantId],
            // Without this a manual bill is kept as it is (generate's Q5).
            revertToEdgeTenantIds: bill.reading_source === "manual" ? [tenantId] : undefined,
          }
        : {
            billingPeriodId: period.id,
            tenantIds: [tenantId],
            manualReadings: [
              { tenantId, startKwh: parsed.start_kwh, endKwh: parsed.end_kwh, ...(parsed.reason ? { reason: parsed.reason } : {}) },
            ],
          },
    );
    if (!result.ok) return mapError(result);

    const mine = result.data.results.find((r) => r.tenantId === tenantId);
    if (mine?.kind === "written") {
      const fmt = createFmt({ locale: formatLocale(request.headers.get("accept-language")) });
      const currency = microgrid?.currency ?? "UGX";
      const now = fmt.money(Number(mine.lineItem.total_amount), currency).text;
      const message =
        mine.previousTotalAmount === null
          ? `Regenerated the bill. Its total is now ${now}.`
          : `Regenerated the bill. Its total was ${fmt.money(Number(mine.previousTotalAmount), currency).text} and is now ${now}.`;
      return NextResponse.json({
        lineItemId: mine.lineItem.id,
        // A NUMERIC column, which can arrive as a string: answered as a number.
        totalAmount: Number(mine.lineItem.total_amount),
        previousTotalAmount: mine.previousTotalAmount,
        message,
      });
    }
    if (mine?.kind === "error") {
      return NextResponse.json({ error: mine.error, reason: mine.code }, { status: 409 });
    }
    return NextResponse.json({ error: "The bill was not regenerated.", reason: "unknown_error" }, { status: 500 });
  } finally {
    await composed.data.dispose();
  }
}
