/**
 * POST /api/payments/attempts/[id]/reconcile
 *
 * Audited manager reconciliation for a `needs_reconciliation` attempt
 * (payments.record-adjustment and payments.accept-receipts). The body is
 * ReconcileAttemptBody (src/lib/payments/schemas.ts):
 * - { action: "accept_exact", externalReference?, notes? } — accept the
 *   verified receipts as exact settlement; it takes no amount.
 * - { action: "record_external", externalAmount, externalReference, notes,
 *   confirmation: { acknowledged: [], typed } } — record a collection or
 *   refund (negative amount) completed outside MGM, with the tenant's name
 *   typed.
 *
 * Answers:
 *   400 { error, field?, code: "invalid_body" } — the body does not parse,
 *       before the attempt is looked up, a reference over 200 characters
 *       or notes over 500 (after trimming; RECONCILE_REFERENCE_MAX and
 *       RECONCILE_NOTES_MAX in src/lib/payments/reconcile-limits.ts)
 *       included. Notes used to be cut to 500 and saved; now they are
 *       refused;
 *   400 { error, reason } — a completed adjustment without its amount,
 *       reference or notes, or an exact acceptance with an amount;
 *   401 without a live session; 404 for an attempt that does not exist;
 *   403 for another organization's attempt, or an actor
 *       fn_payment_reconcile refuses;
 *   409 — the attempt needs no reconciliation, the bill has a checkout with
 *       an unknown outcome or receipts in several currencies, the receipts
 *       are not exact, or the adjustment does not settle the bill exactly;
 *   428 { reason: "payments_reconcile_name_required" |
 *       "payments_reconcile_name_mismatch" } — a completed adjustment
 *       without the tenant's name typed, or with another.
 * Every refusal is fixed copy (RECONCILE_COPY), never a database message.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { composePayments } from "@/lib/payments/compose";
import { ReconcileAttemptBody } from "@/lib/payments/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

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
  const supabase = await createClient();
  // The lookup below runs on the service role, so confirm the session with
  // Supabase Auth first: middleware only verifies the token's signature,
  // which a session signed out elsewhere still passes. composePayments asks
  // Auth again; if the lookup moves after it, this check can go.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // The same answer composePayments gives a missing session.
    return NextResponse.json(
      { error: "Authentication required.", reason: "payments_unauthenticated" },
      { status: 401 }
    );
  }
  const parsed = await parseJsonBody(request, ReconcileAttemptBody);
  if (!parsed.ok) return parsed.response;
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
    const reconciled = await composed.data.payments.reconcile(attemptId, parsed.data);
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
