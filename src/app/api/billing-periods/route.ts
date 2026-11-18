import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeBilling,
  type BillingResult,
} from "@/lib/billing/compose";
import { CreatePeriodBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

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
 * The body is parsed with `CreatePeriodBody` (`@/lib/billing/schemas`)
 * before anything else, so a malformed body answers 400 even for a
 * microgrid the caller cannot see or a disabled plugin. Unknown keys are
 * refused.
 *
 * Released billing mutations route through the billing Cordis capability:
 * the route resolves the organization, composes the request-scoped billing
 * context (auth + plugin gate), and delegates the write.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJsonBody(request, CreatePeriodBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const microgridId = body.microgrid_id;

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
    // `href`: the GUI kit opens the new period, as the legacy list does.
    return NextResponse.json(
      { period: result.data, href: `/microgrids/${microgridId}/billing/${result.data.id}` },
      { status: 201 }
    );
  } finally {
    await composed.data.dispose();
  }
}
