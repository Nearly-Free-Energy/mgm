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
 * POST /api/billing-periods — manually create a billing period (issue #5).
 *
 * Billing periods are manual: the operator triggers creation per microgrid.
 * The period timezone is stamped once from the microgrid and never
 * re-derived, so regenerating after a microgrid timezone change reproduces
 * the identical window.
 *
 * Released billing mutations route through the billing Cordis capability:
 * the route resolves the organization, composes the request-scoped billing
 * context (auth + plugin gate), and delegates validation + writes.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const microgridId =
    typeof body.microgrid_id === "string" ? body.microgrid_id : "";
  const supabase = await createClient();
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", microgridId)
    .maybeSingle<{ id: string; communities: { org_id: string } }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Microgrid not found.", code: "billing_invalid_microgrid" },
      { status: 404 }
    );
  }

  const composed = await composeBilling({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.billing.createPeriod({
      microgrid_id: microgridId,
      start_date: body.start_date,
      end_date: body.end_date,
    });
    if (!result.ok) return mapError(result);
    return NextResponse.json({ period: result.data }, { status: 201 });
  } finally {
    await composed.data.dispose();
  }
}
