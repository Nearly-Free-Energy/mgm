import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeBilling,
  type BillingResult,
} from "@/lib/billing/compose";
import { DeletePeriodBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json(body, { status });
}

/**
 * DELETE /api/billing-periods/[periodId] — delete a draft billing period
 * against the name the person typed (#201), as `billing.delete-period`.
 *
 * The body is DeletePeriodBody (src/lib/billing/schemas.ts). A DELETE often
 * has no body, so an empty one is read as `{}`: a request for the name to type.
 *   - no `confirmation`: 428 `billing_delete_confirmation_required`, naming
 *     the period to type. Nothing is deleted.
 *   - the wrong name typed: 428 `billing_delete_name_mismatch`.
 *   - a closed period, or one with payment activity: 409
 *     `billing_period_kept`. fn_billing_period_before_delete_guard is the
 *     authority on both; the capability maps its refusal.
 * On success the answer is 200 with the periods list as `href`, which the GUI
 * kit navigates to.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ periodId: string }> }
): Promise<NextResponse> {
  const { periodId } = await params;

  const empty = (await request.clone().text()).trim() === "";
  const parsed = empty
    ? ({ ok: true, data: DeletePeriodBody.parse({}) } as const)
    : await parseJsonBody(request, DeletePeriodBody);
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
    const result = await composed.data.billing.deletePeriod(periodId, parsed.data);
    if (!result.ok) return mapError(result);
    return NextResponse.json(
      {
        deleted: periodId,
        message: `Deleted the draft period ${result.data.name}.`,
        href: `/microgrids/${result.data.microgridId}/billing`,
      },
      { status: 200 }
    );
  } finally {
    await composed.data.dispose();
  }
}
