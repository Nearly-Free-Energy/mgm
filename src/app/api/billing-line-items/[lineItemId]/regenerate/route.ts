import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { composeBilling, type BillingResult } from "@/lib/billing/compose";
import { RegenerateBillBody } from "@/lib/billing/schemas";
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
 *
 * Responses:
 *   200 → { lineItemId, totalAmount, previousTotalAmount }
 *   400 → { error, field?, code: "invalid_body" } (body, or a reading the
 *         mode does not take or lacks); { error, reason: "bad_request" } (id)
 *   401 → { error: "unauthorized" }
 *   404 → { error, reason: "not_found" } (bill, period or microgrid hidden by RLS)
 *   409 → { error, reason: "refunded" }, or { error, reason: <generation code> }
 *         when generation refused this tenant (GenerationErrorCode)
 *   500 → { error, reason: "unknown_error" }
 *   and the capability's own refusals (plugin gate, organization scope).
 *
 * The legacy dialogs still call POST /api/billing/generate.
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
  if (billError) {
    return NextResponse.json({ error: "Failed to look up billing line item.", reason: "unknown_error" }, { status: 500 });
  }
  if (!bill) return notFound();

  // The organization, as POST /api/billing/generate resolves it.
  const { data: period } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id")
    .eq("id", bill.billing_period_id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!period) return notFound();
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", period.microgrid_id)
    .maybeSingle<{ id: string; communities: { org_id: string } | { org_id: string }[] }>();
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
      return NextResponse.json({
        lineItemId: mine.lineItem.id,
        totalAmount: mine.lineItem.total_amount,
        previousTotalAmount: mine.previousTotalAmount,
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
