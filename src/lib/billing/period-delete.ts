/**
 * period-delete.ts — the copy for deleting a billing period, and the call the
 * legacy clients make. Every delete goes through DELETE
 * /api/billing-periods/[periodId] (BillingCapability.deletePeriod, behind the
 * billing plugin gate): the legacy periods list and period page call it with
 * `deleteDraftPeriodThroughRoute` below, with the period's name typed, and the
 * `billing.delete-period` prepare step (./surface/periods.ts) offers the same
 * route through the GUI host. The capability also refuses a period that
 * imported pilot data (pilot_import_batches.billing_period_id, SQLSTATE
 * 23503), which no message here covers.
 *
 * Only draft periods with no payment activity can be deleted. The database
 * enforces that with a BEFORE DELETE trigger on billing_periods
 * (fn_billing_period_before_delete_guard, last issued by migration
 * 20261103160000), which refuses with SQLSTATE 23514, a message starting
 * `billing_period_kept`, and DETAIL `closed` or `payment_activity`. The
 * guards that 20261103160000 adds for bills and for organization, community
 * and microgrid deletes refuse the same way. If those migrations change the
 * code, message prefix or DETAIL values, update `isPeriodKeptError` and
 * `periodDeleteErrorMessage` to match; if they change which line items count
 * as payment activity, update `lineItemHasRecordedPayment`.
 *
 * Client-safe: imports nothing.
 */

/** What a confirmed delete removes, shown in the confirm dialog. */
export const DELETE_DRAFT_PERIOD_DESCRIPTION =
  "This permanently removes the draft period, its generated bills and its history entries. Periods with recorded payments are kept.";

export const PERIOD_KEPT_CLOSED_MESSAGE =
  "This period is closed, so it is kept as the billing record and cannot be deleted.";

export const PERIOD_KEPT_PAYMENTS_MESSAGE =
  "This period has recorded payments, so it is kept with its payment records and cannot be deleted.";

/** For a refusal whose DETAIL names neither reason above. */
export const PERIOD_KEPT_MESSAGE =
  "This period is kept as part of the billing record and cannot be deleted.";

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
    if (error.details === "closed") return PERIOD_KEPT_CLOSED_MESSAGE;
    if (error.details === "payment_activity") return PERIOD_KEPT_PAYMENTS_MESSAGE;
    return PERIOD_KEPT_MESSAGE;
  }
  return error.message || "Could not delete the period.";
}

/** The label of the field where the period's name is typed to delete it. */
export const DELETE_PERIOD_TYPED_LABEL = "Type the period's name to delete it";

/** For a delete that failed with no message from the route (a network error). */
export const PERIOD_DELETE_FAILED_MESSAGE = "Could not delete the period.";

/**
 * Deletes a draft period through DELETE /api/billing-periods/[periodId], with
 * `typed` as the name the person typed. Resolves on 200; otherwise throws an
 * Error carrying the route's message, which is fixed copy
 * (BillingCapability.deletePeriod: PERIOD_KEPT_*, the plugin gate's refusal, a
 * name that does not match), so a ConfirmDialog can show it as it is.
 */
export async function deleteDraftPeriodThroughRoute(periodId: string, typed: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/billing-periods/${encodeURIComponent(periodId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: { acknowledged: [], typed } }),
    });
  } catch {
    throw new Error(PERIOD_DELETE_FAILED_MESSAGE);
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  const message =
    typeof body.message === "string" && body.message
      ? body.message
      : typeof body.error === "string" && body.error
        ? body.error
        : PERIOD_DELETE_FAILED_MESSAGE;
  throw new Error(message);
}
