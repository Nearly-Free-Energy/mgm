/**
 * The longest external reference and notes a reconciliation takes, after
 * trimming. ReconcileAttemptBody (./schemas.ts) refuses longer ones with 400
 * invalid_body, and the legacy Payment history dialog
 * (src/components/payments/payment-history.tsx) caps its inputs at them, so
 * a person cannot type what the route refuses. Kept apart from the schemas
 * so the dialog takes no validation library into the client bundle.
 */
export const RECONCILE_REFERENCE_MAX = 200;
export const RECONCILE_NOTES_MAX = 500;
