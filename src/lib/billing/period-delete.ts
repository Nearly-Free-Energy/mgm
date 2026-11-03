/**
 * period-delete.ts — client copy for deleting a billing period.
 *
 * Only draft periods with no payment activity can be deleted. The database
 * enforces that with a BEFORE DELETE trigger on billing_periods
 * (migration 20261103090100, fn_billing_period_before_delete_guard), which
 * refuses with SQLSTATE 23514, a message starting `billing_period_kept`, and
 * DETAIL `closed` or `payment_activity`. If that migration changes its code,
 * message prefix or DETAIL values, update `isPeriodKeptError` to match; if
 * it changes which line items count as payment activity, update
 * `lineItemHasRecordedPayment`.
 */

/** What a confirmed delete removes, shown in the confirm dialog. */
export const DELETE_DRAFT_PERIOD_DESCRIPTION =
  "This permanently removes the draft period, its generated bills and its history entries. Periods with recorded payments are kept.";

export const PERIOD_KEPT_CLOSED_MESSAGE =
  "This period is closed, so it is kept as the billing record and cannot be deleted.";

export const PERIOD_KEPT_PAYMENTS_MESSAGE =
  "This period has recorded payments, so it is kept with its payment records and cannot be deleted.";

/**
 * True when a line item carries a recorded payment the trigger counts: a
 * payment_status other than 'unpaid', or paid_at set. Payment attempts and
 * payment events also keep a period, but the client does not load them, so
 * a refused delete can still happen and `periodDeleteErrorMessage` covers it.
 */
export function lineItemHasRecordedPayment(item: {
  payment_status: string;
  paid_at?: string | null;
}): boolean {
  return item.payment_status !== "unpaid" || (item.paid_at ?? null) !== null;
}

/** The shape of a PostgREST error as supabase-js returns it. */
export interface PeriodDeleteError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export function isPeriodKeptError(error: PeriodDeleteError): boolean {
  return (
    error.code === "23514" &&
    typeof error.message === "string" &&
    error.message.startsWith("billing_period_kept")
  );
}

/** The message to show when a delete is refused or fails. */
export function periodDeleteErrorMessage(error: PeriodDeleteError): string {
  if (isPeriodKeptError(error)) {
    return error.details === "closed"
      ? PERIOD_KEPT_CLOSED_MESSAGE
      : PERIOD_KEPT_PAYMENTS_MESSAGE;
  }
  return error.message || "Could not delete the period.";
}
