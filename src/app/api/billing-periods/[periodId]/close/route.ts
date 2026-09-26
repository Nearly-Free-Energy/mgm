import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeBilling,
  type BillingResult,
} from "@/lib/billing/compose";

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/billing-periods/[periodId]/close — operator Close Period action
 * (issue #5).
 *
 * Closing is an explicit operator gesture, never automatic. The response
 * carries the unresolved-household summary: when households have no bill in
 * the period, the first call returns 409 `billing_unresolved_households`
 * and the operator must confirm explicitly (`{ confirmed: true }`) to close
 * anyway. Corrections after closure stay controlled and audited: usage edits
 * reject closed periods (`period_closed`) while regeneration is preserved
 * with `period_was_closed` audit history.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ periodId: string }> }
): Promise<NextResponse> {
  const { periodId } = await params;

  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

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
    const result = await composed.data.billing.closePeriod(periodId, body);
    if (!result.ok) return mapError(result);
    return NextResponse.json(
      { period: result.data.period, unresolved: result.data.unresolved },
      { status: 200 }
    );
  } finally {
    await composed.data.dispose();
  }
}
