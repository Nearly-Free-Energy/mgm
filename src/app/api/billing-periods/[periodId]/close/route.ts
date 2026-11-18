import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeBilling,
  type BillingResult,
} from "@/lib/billing/compose";
import { ClosePeriodBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/billing-periods/[periodId]/close — close a billing period against
 * the totals the person reviewed (#201; first added for issue #5).
 *
 * The body is ClosePeriodBody (src/lib/billing/schemas.ts):
 *   - no `confirmation`: 428 `billing_close_confirmation_required`, with the
 *     `review` to confirm (totals, warnings, acknowledgements, the name to
 *     type, the digest). Nothing is written.
 *   - a `confirmation` whose digest is not the current totals' digest:
 *     409 `billing_period_totals_changed`, with the current `review`.
 *   - an acknowledgement missing or the wrong name typed: 428, with the
 *     `review`.
 * fn_close_billing_period checks the digest and acknowledgements again in the
 * same transaction as the status change. Corrections after closure stay
 * controlled and audited: usage edits reject closed periods (`period_closed`)
 * while regeneration is preserved with `period_was_closed` audit history.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ periodId: string }> }
): Promise<NextResponse> {
  const { periodId } = await params;

  const parsed = await parseJsonBody(request, ClosePeriodBody);
  if (!parsed.ok) return parsed.response;

  const supabase = await createClient();
  const { data: period } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id")
    .eq("id", periodId)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!period) {
    return NextResponse.json(
      { error: "Billing period not found.", code: "billing_period_not_found" },
      { status: 404 }
    );
  }
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", period.microgrid_id)
    .maybeSingle<{ id: string; communities: { org_id: string } }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Billing period not found.", code: "billing_period_not_found" },
      { status: 404 }
    );
  }

  const composed = await composeBilling({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.billing.closePeriod(periodId, parsed.data);
    if (!result.ok) return mapError(result);
    return NextResponse.json(
      { period: result.data.period, unresolved: result.data.unresolved },
      { status: 200 }
    );
  } finally {
    await composed.data.dispose();
  }
}
