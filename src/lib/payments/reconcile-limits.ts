/**
 * The longest external reference and notes a reconciliation takes, after
 * trimming. ReconcileAttemptBody (./schemas.ts) refuses longer ones with 400
 * invalid_body, and its JSON Schema carries them as maxLength, so the kit's
 * form caps its inputs at them.
 */
export const RECONCILE_REFERENCE_MAX = 200;
export const RECONCILE_NOTES_MAX = 500;
