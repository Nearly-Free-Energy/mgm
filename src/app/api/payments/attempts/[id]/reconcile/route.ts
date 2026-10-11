/**
 * POST /api/payments/attempts/[id]/reconcile
 *
 * Audited manager reconciliation for a `needs_reconciliation` attempt:
 * - { action: "accept_exact" } — accept as exact settlement.
 * - { action: "record_external", externalReference, notes } — record an
 *   externally completed balance collection/refund with reference + notes.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { composePayments } from "@/lib/payments/compose";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: attemptId } = await params;
  if (!UUID_RE.test(attemptId)) {
    return NextResponse.json(
      { error: "Invalid attempt id — expected UUID.", reason: "bad_request" },
      { status: 400 }
    );
  }
  const body = (await request.json().catch(() => ({}))) as unknown;
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
    const reconciled = await composed.data.payments.reconcile(attemptId, body);
    if (!reconciled.ok) {
      return NextResponse.json(
        { error: reconciled.message, reason: reconciled.code },
        { status: reconciled.status }
      );
    }
    return NextResponse.json(reconciled.data);
  } finally {
    await composed.data.dispose();
  }
}
