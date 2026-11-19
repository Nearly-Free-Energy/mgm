import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeBilling,
  type BillingResult,
} from "@/lib/billing/compose";
import { GenerateBillsBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  // Keep the route's `error` field for its existing clients while exposing
  // the capability's actionable message instead of a generic UI fallback.
  return NextResponse.json({ ...body, error: body.message }, { status });
}

/**
 * POST /api/billing/generate (#173, BC1)
 *
 * Body:
 *   billingPeriodId: string                                — required
 *   tenantIds?: string[]                                — optional
 *     - undefined → process every tenant on the period's microgrid
 *       (legacy bulk Refresh-Readings behavior)
 *     - []        → explicit no-op (writes nothing, returns empty arrays)
 *     - [uuid…]   → only those tenants are processed
 *   manualReadings?: Array<{
 *     tenantId: string;
 *     startKwh: number;
 *     endKwh: number;
 *     reason?: string;
 *   }>
 *     - implicitly adds each tenant to the processed set
 *     - skips the OpenEMS call for that tenant; uses startKwh/endKwh
 *       as provided; usage_kwh is server-derived (endKwh - startKwh)
 *   revertToEdgeTenantIds?: string[]
 *     - tenants whose current manual row may be replaced by an OpenEMS
 *       reading ("Switch back to edge data"); does not add them to the
 *       processed set, and may not repeat a manualReadings tenant
 *   seedReadings?: Array<{ deviceId, dialReadingKwh, readAt, startKwh }>
 *     - operator-supplied starting readings (#339); what is and is not
 *       checked is written on GenerateBillsBody
 *
 * Parsed with `GenerateBillsBody` (`@/lib/billing/schemas`); unknown keys,
 * at the top level or in a reading, are refused. A bad body answers
 * 400 { error: <message>, field?, code: "invalid_body" }.
 *
 * AC3 changes from the legacy route:
 *   - Closed periods are NOT rejected (Q4=B logs `period_was_closed: true`).
 *   - The bulk legacy delete-then-insert is REPLACED with UPSERT-preserve
 *     via fn_record_line_item_with_audit (preserves payment_status, paid_at,
 *     paid_by_user_id, payment_notes, pesapal_order_id, payment_failed_at,
 *     payment_refunded_at — and the payment_events history that would
 *     otherwise CASCADE away).
 *   - A tenant with reading_source='manual' currently, no manualReadings
 *     entry and not in revertToEdgeTenantIds is not rewritten (Q5). With
 *     tenantIds omitted it is listed in kept[]; named in tenantIds it
 *     is surfaced in errors[] with code='currently_manual'.
 *   - manualReadings for a tenant NOT in the period's microgrid → skipped
 *     + surfaced in errors[] with code='unknown_tenant'. Cross-microgrid
 *     attack defense.
 *
 * Auth (NEW): explicit getUser() gate before any business logic — today's
 * route relies entirely on RLS. Returning 401 explicitly gives BC2/BC3 a
 * predictable upstream signal.
 *
 * Release 3 (issue #5, review P1): the write itself runs through the billing
 * Cordis capability (composeBilling + generateBills), which enforces the
 * organization scope, the billing plugin gate, and effective-dated
 * meter-assignment coverage before the engine sees the request.
 *
 * Response:
 *   { lineItems: number; kept: Array<{ tenantId, tenantName }>;
 *     errors: Array<...> }
 */
export async function POST(request: NextRequest) {
  // Before the session check, so a malformed body answers 400 even without one.
  const body = await parseJsonBody(request, GenerateBillsBody);
  if (!body.ok) return body.response;
  const parsed = body.data;

  const supabase = await createClient();

  // Explicit auth gate (AC6). The legacy route relied on RLS only; this is
  // belt-and-suspenders so anonymous calls return 401, not 500-on-RLS.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Release 3 (issue #5, review P1): generation runs through the billing
  // Cordis capability — org-scoped, plugin-gated, and always enforcing
  // effective-dated meter-assignment coverage. The route resolves the
  // organization, composes the request-scoped billing context, and delegates
  // validation + writes; the engine is never called directly.
  const { data: period } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id")
    .eq("id", parsed.billingPeriodId)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!period) {
    return NextResponse.json({ error: "Billing period not found" }, { status: 404 });
  }
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", period.microgrid_id)
    .maybeSingle<{
      id: string;
      communities: { org_id: string } | { org_id: string }[];
    }>();
  const communities = microgrid?.communities;
  const orgId = Array.isArray(communities)
    ? communities[0]?.org_id
    : communities?.org_id;
  if (!orgId) {
    return NextResponse.json({ error: "Billing period not found" }, { status: 404 });
  }

  const composed = await composeBilling({ supabase, organizationId: orgId });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.billing.generateBills({
      billingPeriodId: parsed.billingPeriodId,
      tenantIds: parsed.tenantIds,
      manualReadings: parsed.manualReadings,
      revertToEdgeTenantIds: parsed.revertToEdgeTenantIds,
      seedReadings: parsed.seedReadings,
    });
    if (!result.ok) return mapError(result);

    // Shape the response: split written + errors.
    const lineItems = result.data.results.filter((r) => r.kind === "written").length;
    // Currently-manual tenants a bulk run left as they were. Not errors:
    // nothing was asked of them that did not happen.
    const kept = result.data.results
      .filter((r) => r.kind === "kept")
      .map((k) => ({ tenantId: k.tenantId, tenantName: k.tenantName }));
    const errors = result.data.results
      .filter((r) => r.kind === "error")
      .map((e) => ({
        tenantId: e.tenantId,
        tenantName: e.tenantName,
        error: e.error,
        code: e.code,
      }));

    return NextResponse.json({ lineItems, kept, errors });
  } finally {
    await composed.data.dispose();
  }
}
