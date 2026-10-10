/**
 * POST /api/payments/attempts/[id]/refresh
 *
 * Manager "Refresh payment status" action: server-side re-verification of
 * one attempt via GetTransactionStatus. Validates merchant reference,
 * tracking identity, amount and currency before recording payment.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { composePayments } from "@/lib/payments/compose";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: attemptId } = await params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json(
      { error: "Invalid attempt id — expected UUID.", reason: "bad_request" },
      { status: 400 }
    );
  }
  // Resolve the owning org with the service client (RLS-independent lookup),
  // then compose with the caller session so org scope is enforced.
  const service = createServiceClient();
  const { data: attempt } = await service
    .from("payment_attempts")
    .select("id, org_id")
    .eq("id", attemptId)
    .maybeSingle<{ id: string; org_id: string }>();
  if (!attempt) {
    return NextResponse.json(
      { error: "Payment attempt not found.", reason: "not_found" },
      { status: 404 }
    );
  }
  const supabase = await createClient();
  const composed = await composePayments({
    supabase,
    organizationId: attempt.org_id,
  });
  if (!composed.ok) {
    return NextResponse.json(
      { error: composed.message, reason: composed.code },
      { status: composed.status }
    );
  }
  try {
    const refreshed = await composed.data.payments.refreshPaymentStatus(attemptId);
    if (!refreshed.ok) {
      return NextResponse.json(
        { error: refreshed.message, reason: refreshed.code },
        { status: refreshed.status }
      );
    }
    return NextResponse.json(refreshed.data);
  } finally {
    await composed.data.dispose();
  }
}
