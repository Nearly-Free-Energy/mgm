/**
 * PATCH /api/billing-line-items/[lineItemId]/payment-status
 *
 * Manual mark-paid / mark-unpaid for a single billing_line_items row.
 * Phase B (#157) widens the body whitelist: super_admins may set 'failed' /
 * 'refunded' (reconciliation-class actions). All transitions go through the
 * authoritative SQL state machine `fn_apply_payment_event` (migrations 00027
 * (enum) + 00028 (rest))
 * which appends an audit row to `payment_events` automatically.
 *
 * Path chain:
 *   lineItem → billing_periods(microgrid_id, start_date, end_date)
 *            → microgrids(id) → tenants(display_name)
 *
 * Permission:
 *   - super_admin AND org_manager may trigger 'unpaid' / 'paid' transitions
 *     (operational reconciliation).
 *   - super_admin ONLY may trigger 'failed' / 'refunded' (reconciliation
 *     actions; org_managers are gated to avoid accidental terminal states).
 *
 * Body:
 *   { status: 'unpaid' | 'paid' | 'failed' | 'refunded', notes?: string (≤500 chars),
 *     confirmation?: { acknowledged: string[], typed?: string } }
 *   Notes are trimmed server-side; empty string after trim → stored as NULL.
 *   Parsed with `LineItemPaymentStatusBody` (`@/lib/billing/schemas`);
 *   unknown keys are refused.
 *   'link_generated' is NOT a manual body input — that state is set by the
 *   link generation route only. Manual transitions OUT of 'link_generated'
 *   are still admitted (operator may cancel a pending link).
 *   A refund is final, so 'refunded' needs `confirmation.typed`: the
 *   tenant's display name, compared trimmed on both sides. This route is the
 *   authority on it (ADR-006), whatever sent the request: the GUI host sends
 *   it for billing.mark-refunded, whose prepare names the same tenant
 *   (src/lib/billing/surface/period-review.ts).
 *   Every other status ignores `confirmation`.
 *
 * Response:
 *   200 → { status: 'success', line_item: <updated row with all payment cols> }
 *   400 → { error, field?, code: 'invalid_body' } (body)
 *         { error, reason: 'no_op' | 'invalid_transition' }
 *   401 → { error, reason: 'session_expired' }
 *   403 → { error, reason: 'forbidden' | 'super_admin_required' }
 *   404 → { error, reason: 'not_found' }
 *   428 → { error, reason: 'refund_name_required' | 'refund_name_mismatch' }
 *         (a refund without the tenant's name typed, or with another)
 *   500 → { error, reason: 'invariant_violation' | 'unknown_error' }
 *
 * Structured logging:
 *   Logs `payment.manual_mark` with notes_present: boolean.
 *   Raw notes are NEVER logged — they may contain PII / receipt references.
 *   No scrubSecretValues needed: this route touches no credentials.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import {
  currentUserCanAccessMicrogrid,
  currentUserIsSuperAdmin,
} from "@/lib/auth/access";
import {
  assertValidManualTransition,
  PaymentTransitionError,
  type PaymentStatus,
} from "@/lib/payments/state";
import { LineItemPaymentStatusBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses gated to super_admin only (reconciliation-class). */
const SUPER_ADMIN_ONLY_STATUSES: readonly PaymentStatus[] = ["failed", "refunded"];

/**
 * A refund's typed-name refusals: fixed copy, never the name itself. The
 * required one names Mark as refunded because the step that sent the
 * request may have had no name field: the GUI's confirm-level payment
 * actions (Mark as unpaid, Mark as paid …) share this route, and their form
 * lets a person switch the status to refunded, but the host sends them no
 * confirmation (sendsConfirmation in src/lib/gui/host/client/invoke.ts). If
 * those steps come to ask for the name, the copy can just ask for it.
 */
const REFUND_NAME_REFUSALS = {
  required: { error: "A refund needs the tenant's name typed: use Mark as refunded.", reason: "refund_name_required" },
  mismatch: { error: "The name typed does not match this bill's tenant.", reason: "refund_name_mismatch" },
} as const;

// ── Scope type (query result) ─────────────────────────────────────────────────

type LineItemScopeRow = {
  id: string;
  payment_status: string;
  billing_period_id: string;
  billing_periods:
    | {
        id: string;
        microgrid_id: string;
        start_date: string;
        end_date: string;
      }
    | null;
  tenants: { display_name: string } | { display_name: string }[] | null;
};

// ── Handler ───────────────────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<NextResponse> {
  const { lineItemId } = await params;

  // UUID guard.
  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "Invalid line item id — expected UUID.", reason: "bad_request" },
      { status: 400 },
    );
  }

  // 1. Parse + validate body. notes comes back trimmed, or null when empty.
  const body = await parseJsonBody(request, LineItemPaymentStatusBody);
  if (!body.ok) return body.response;
  const parsed = body.data;

  const supabase = await createClient();

  // 2. Resolve lineItem → period + tenant in one query.
  //    RLS applies: RLS-hidden row surfaces as null → 404.
  const { data: scoped, error: scopedErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      payment_status,
      billing_period_id,
      billing_periods!inner (
        id,
        microgrid_id,
        start_date,
        end_date
      ),
      tenants!inner (
        display_name
      )
    `,
    )
    .eq("id", lineItemId)
    .maybeSingle<LineItemScopeRow>();

  if (scopedErr) {
    return NextResponse.json(
      { error: "Failed to look up billing line item.", reason: "unknown_error" },
      { status: 500 },
    );
  }
  if (!scoped) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  // PostgREST may return joined singletons as single-element arrays; normalize.
  const period = Array.isArray(scoped.billing_periods)
    ? scoped.billing_periods[0]
    : scoped.billing_periods;

  if (!period) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  const microgridId = period.microgrid_id;

  // 3. Permission gate.
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      { error: "You do not have permission to update this line item.", reason: "forbidden" },
      { status: 403 },
    );
  }

  // 3a. Release 3 (issue #5): manual payments fail closed while billing is disabled.
  const billingGate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "microgrid", id: microgridId },
    method: "PATCH",
  });
  if (billingGate) return billingGate;

  // 3b. Super-admin gate for reconciliation-class statuses.
  if (SUPER_ADMIN_ONLY_STATUSES.includes(parsed.status)) {
    const isSuper = await currentUserIsSuperAdmin(supabase);
    if (!isSuper) {
      return NextResponse.json(
        {
          error:
            "Only super admins can mark a bill as failed or refunded — this is a reconciliation action.",
          reason: "super_admin_required",
        },
        { status: 403 },
      );
    }
  }

  // 3c. Resolve actor user ONCE — used for both the audit trail and the log.
  //     Single fetch avoids the double-getUser() pattern and guarantees the
  //     same identity is written to the DB and emitted to logs.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorUserId: string | null = user?.id ?? null;

  // 4. State transition validation (TS-side pre-flight; DB function is the
  //    authoritative re-validator under row lock).
  const currentStatus = scoped.payment_status as PaymentStatus;
  try {
    assertValidManualTransition(currentStatus, parsed.status);
  } catch (err) {
    if (err instanceof PaymentTransitionError) {
      const message =
        err.reason === "no_op"
          ? "Bill is already in that state."
          : "That status change is not allowed for manual edits.";
      return NextResponse.json(
        { error: message, reason: err.reason },
        { status: 400 },
      );
    }
    throw err;
  }

  // 4a. A refund is final: the person must have typed the tenant's name.
  //     A tenant whose name cannot be read cannot be confirmed this way.
  if (parsed.status === "refunded") {
    const tenant = Array.isArray(scoped.tenants) ? scoped.tenants[0] : scoped.tenants;
    const expected = (tenant?.display_name ?? "").trim();
    const typed = parsed.confirmation?.typed?.trim() ?? "";
    if (typed === "") {
      return NextResponse.json(REFUND_NAME_REFUSALS.required, { status: 428 });
    }
    if (expected === "" || typed !== expected) {
      return NextResponse.json(REFUND_NAME_REFUSALS.mismatch, { status: 428 });
    }
  }

  // 5. Session guard: the manual-mark route is operator-only and the audit
  //    row MUST attribute to a human user. Required for ALL transitions
  //    (not just paid/refunded) because #250's
  //    `payment_events_actor_consistency` CHECK rejects `actor_kind='human'
  //    + actor_user_id IS NULL`, and this route always writes the human
  //    actor_kind (IPN goes through src/app/api/payments/ipn/route.ts which
  //    writes actor_kind='system').
  //
  //    In practice currentUserCanAccessMicrogrid() above (line 172) already
  //    requires a session, so actorUserId should be non-null here — this is
  //    a belt-and-suspenders re-check that surfaces the right error to the
  //    UI rather than a 500 on the DB CHECK violation.
  if (!actorUserId) {
    return NextResponse.json(
      { error: "Session expired. Please reload and try again.", reason: "session_expired" },
      { status: 401 },
    );
  }

  // 6. Apply via the authoritative state-machine RPC.
  //    `_raw_payload` carries the operator's free-text note through to the
  //    SECURITY DEFINER function so the note is persisted atomically with the
  //    state transition (no second RLS-bound UPDATE that could be silently
  //    denied). Convention:
  //      - notes provided                  → { payment_notes: <trimmed> }
  //                                          (function copies into payment_notes)
  //      - transitioning to 'unpaid'       → { payment_notes: null }
  //                                          (function clears payment_notes;
  //                                          attribution stays consistent with
  //                                          paid_at / paid_by_user_id, which
  //                                          the function also clears)
  //      - neither                         → null (key absent → leave column
  //                                          unchanged inside the function)
  //    The audit row in `payment_events.raw_payload` retains the same shape,
  //    so the operator's note is captured in the audit trail too.
  let rawPayload: Record<string, unknown> | null = null;
  if (parsed.notes !== null) {
    rawPayload = { payment_notes: parsed.notes };
  } else if (parsed.status === "unpaid") {
    rawPayload = { payment_notes: null };
  }

  const { data: updated, error: rpcErr } = await supabase.rpc(
    "fn_apply_payment_event",
    {
      _line_item_id: lineItemId,
      _to_status: parsed.status,
      _source: "manual",
      _actor_user_id: actorUserId,
      _raw_payload: rawPayload,
    },
  );

  if (rpcErr) {
    const msg = rpcErr.message ?? "";
    // The SQL function uses RAISE EXCEPTION with prefixes 'invalid_transition'
    // / 'invalid_source' / 'transition_conflict' / 'line_item_not_found'.
    // These should not normally surface (TS pre-flight catches them), but
    // races / direct-DB writes can produce them.
    const isInvalid = msg.includes("invalid_transition");
    const isNotFound = msg.includes("line_item_not_found");
    const isConflict = msg.includes("transition_conflict");
    const isCheckViolation = rpcErr.code === "23514";

    console.error(
      JSON.stringify({
        event: "payment.manual_mark.error",
        line_item_id: lineItemId,
        microgrid_id: microgridId,
        from_status: currentStatus,
        to_status: parsed.status,
        reason: isInvalid
          ? "invalid_transition"
          : isNotFound
            ? "not_found"
            : isConflict
              ? "transition_conflict"
              : isCheckViolation
                ? "invariant_violation"
                : "unknown_error",
        pg_code: rpcErr.code,
        at: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      {
        error: isInvalid
          ? "That status change is not allowed for manual edits."
          : isNotFound
            ? "Billing line item not found."
            : isConflict
              ? "The bill state changed during your edit. Please refresh and try again."
              : isCheckViolation
                ? "Internal constraint violation. Contact support."
                : "Failed to update payment status.",
        reason: isInvalid
          ? "invalid_transition"
          : isNotFound
            ? "not_found"
            : isConflict
              ? "transition_conflict"
              : isCheckViolation
                ? "invariant_violation"
                : "unknown_error",
      },
      {
        status: isInvalid
          ? 400
          : isNotFound
            ? 404
            : isConflict
              ? 409
              : 500,
      },
    );
  }

  if (!updated) {
    return NextResponse.json(
      { error: "Failed to update payment status.", reason: "unknown_error" },
      { status: 500 },
    );
  }

  // 7. Structured log.
  //
  // IMPORTANT: raw `notes` text is NEVER logged — it may contain PII or
  // receipt references (e.g. "M-Pesa receipt #KJ3F456", customer name).
  // We log `notes_present: boolean` only so the log pipeline can audit
  // usage frequency without surfacing customer data.
  console.info(
    JSON.stringify({
      event: "payment.manual_mark",
      line_item_id: lineItemId,
      microgrid_id: microgridId,
      actor_user_id: actorUserId,
      from_status: currentStatus,
      to_status: parsed.status,
      notes_present: parsed.notes !== null,
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({ status: "success", line_item: updated });
}
