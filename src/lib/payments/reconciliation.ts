/**
 * reconciliation.ts — pure helpers for the Payments capability.
 *
 * Kept free of database, provider, and framework imports so the
 * checkout/notification/correction matrices are unit-testable. The
 * capability consumes these; `infrastructure/` owns persistence.
 */

export type AttemptStatus =
  | "pending"
  | "confirmation_pending"
  | "verified"
  | "failed"
  | "reversed"
  | "needs_reconciliation"
  | "resolved";

export interface AttemptLike {
  amount: number;
  currency: string;
  bill_revision_total: number;
  status: AttemptStatus;
}

export interface VerificationLike {
  amount?: number;
  currency?: string;
}

/**
 * Reuse rule: repeated clicks reuse the active attempt only when the bill
 * revision (amount + currency) is unchanged. Amount changes invalidate reuse
 * — a revised full-bill checkout may be issued before money is received.
 */
export function canReuseAttempt(
  attempt: AttemptLike,
  current: { amount: number; currency: string }
): boolean {
  if (
    attempt.status === "needs_reconciliation" ||
    attempt.status === "resolved"
  ) {
    return false;
  }
  return (
    Number(attempt.amount) === Number(current.amount) &&
    attempt.currency === current.currency &&
    Number(attempt.bill_revision_total) === Number(current.amount)
  );
}

/**
 * How long an open attempt with neither a tracking ID nor a checkout URL
 * blocks a new checkout. Such an attempt cannot be paid: the customer never
 * received a checkout URL. The window is meant to outlast the request that
 * created it. On Vercel the pay route's `maxDuration` (30 s) caps that
 * request; if that limit grows toward this window, lengthen it. Other
 * hosts (the container image) do not enforce `maxDuration`, and database
 * writes have no timeout of their own, so a slow request could still be
 * running after the window: the supersede write is therefore conditional
 * (`failUnlinkedAttempt`) and leaves an attempt that has since gained a
 * tracking ID or checkout URL alone.
 */
export const UNPAYABLE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * An open attempt that a new checkout may supersede: no tracking ID, no
 * checkout URL, and older than `UNPAYABLE_ATTEMPT_WINDOW_MS`. Attempts with
 * a tracking ID are never superseded, since the provider can still report
 * them paid.
 */
export function isSupersedableAttempt(
  attempt: {
    status: AttemptStatus;
    provider_tracking_id: string | null;
    checkout_url: string | null;
    created_at: string;
  },
  now: number
): boolean {
  if (attempt.status !== "pending" && attempt.status !== "confirmation_pending") return false;
  if (attempt.provider_tracking_id || attempt.checkout_url) return false;
  const created = Date.parse(attempt.created_at);
  return Number.isFinite(created) && now - created >= UNPAYABLE_ATTEMPT_WINDOW_MS;
}

/** A shortfall/overpayment/duplicate blocks further automated checkout. */
export function isBlockedForNewCheckout(attempts: AttemptLike[]): boolean {
  return attempts.some((a) => a.status === "needs_reconciliation");
}

/**
 * Compare a verified provider snapshot against the saved attempt.
 * Returns the mismatch kind so the caller can flag for reconciliation
 * instead of silently settling a changed bill.
 */
export function classifyVerification(input: {
  attemptAmount: number;
  attemptCurrency: string;
  verifiedAmount?: number;
  verifiedCurrency?: string;
  billCurrentTotal: number;
}): "exact" | "amount_mismatch" | "currency_mismatch" | "bill_revised" {
  if (
    input.verifiedCurrency &&
    input.verifiedCurrency !== input.attemptCurrency
  ) {
    return "currency_mismatch";
  }
  if (
    input.verifiedAmount !== undefined &&
    Number(input.verifiedAmount) !== Number(input.attemptAmount)
  ) {
    return "amount_mismatch";
  }
  if (Number(input.billCurrentTotal) !== Number(input.attemptAmount)) {
    return "bill_revised";
  }
  return "exact";
}

/** Difference shown to managers: received − current. Never discards payment. */
export function receiptDifference(received: number, currentTotal: number): number {
  return Number(received) - Number(currentTotal);
}

/**
 * Validate a notification receipt before recording payment. All four must
 * match the saved attempt: merchant reference (resolved by lookup), tracking
 * identity, amount and currency. Returns a machine-readable failure kind.
 */
export function validateReceiptAgainstAttempt(input: {
  attempt: { merchant_reference: string; provider_tracking_id: string | null; amount: number; currency: string };
  notification: { merchantReference: string; trackingId: string };
  verified: VerificationLike;
}): { ok: true } | { ok: false; kind: "forged_reference" | "tracking_mismatch" | "amount_mismatch" | "currency_mismatch" } {
  if (input.notification.merchantReference !== input.attempt.merchant_reference) {
    return { ok: false, kind: "forged_reference" };
  }
  // Tracking identity: first sighting binds the attempt; later sightings must match.
  if (
    input.attempt.provider_tracking_id &&
    input.attempt.provider_tracking_id !== input.notification.trackingId
  ) {
    return { ok: false, kind: "tracking_mismatch" };
  }
  if (
    input.verified.amount !== undefined &&
    Number(input.verified.amount) !== Number(input.attempt.amount)
  ) {
    return { ok: false, kind: "amount_mismatch" };
  }
  if (input.verified.currency && input.verified.currency !== input.attempt.currency) {
    return { ok: false, kind: "currency_mismatch" };
  }
  return { ok: true };
}

/** Transient failures retry with backoff; persistent ones surface. */
export function nextRetryDelaySeconds(attemptCount: number): number {
  const steps = [60, 300, 900, 3600];
  if (attemptCount < 0) return steps[0];
  return steps[Math.min(attemptCount, steps.length - 1)];
}
