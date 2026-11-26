/**
 * Body schemas for payments' write actions. The routes under
 * src/app/api/payments/attempts/[id]/ parse with these, and PAYMENTS_SURFACE's
 * actions take their input from them, so the GUI form and the routes share
 * one definition (gui-surface.test.ts check 2 holds the two together).
 * A change to a schema's JSON Schema is a new input version: bump its
 * constant (schemas.test.ts pins each version's shape).
 *
 * Shape only. The rules that read more than one field, or the database,
 * stay in the capability (PaymentsCapability.reconcile in ./capability.ts)
 * and in fn_payment_reconcile, which check them whoever calls the route:
 * a completed adjustment's amount, reference, notes and typed name, and an
 * exact acceptance's lack of an amount. Each action's input is an object of
 * fields, so the host can clean a loader's prefill against it field by
 * field (cleanPrefill in src/lib/gui/host/server/merge.ts) and the kit can
 * draw it as a form; a route both reconciliations send to parses their
 * discriminated union.
 *
 * Client-safe: its only runtime import is zod. If it gains a server-only or
 * side-effecting runtime import, revisit, and revisit payments-route-
 * boundary.test.ts's zod entry, which allows the routes to load it.
 */
import { z } from "zod";
import { RECONCILE_NOTES_MAX, RECONCILE_REFERENCE_MAX } from "./reconcile-limits";

const bodyError = (issue: { code: string; keys?: string[] }) =>
  issue.code === "unrecognized_keys"
    ? `Unknown field: ${(issue.keys ?? []).join(", ")}`
    : "Request body must be an object";

/**
 * POST /api/payments/attempts/[id]/refresh. The attempt comes from the path;
 * the body is empty. Refreshing records only what the provider verifies,
 * never a figure a person enters.
 */
export const RefreshAttemptBody = z.strictObject({}, { error: bodyError });
export const REFRESH_ATTEMPT_BODY_VERSION = 1;

/** How a manager resolves an attempt that needs reconciliation (fn_payment_reconcile's `_action`). */
export const RECONCILE_ACTIONS = ["accept_exact", "record_external"] as const;
export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];

const CONFIRMATION = "confirmation must be { acknowledged: string[], typed?: string }.";
const ACTION = "action must be 'accept_exact' or 'record_external'.";

// The fields the two reconciliations share. Each call builds a new schema,
// so the two actions' inputs hold no zod object in common.
const resolution = <A extends ReconcileAction>(action: A) => z.literal(action, { error: ACTION }).meta({ title: "Resolution" });
const reference = () =>
  z
    .string({ error: "externalReference must be a string." })
    .trim()
    .max(RECONCILE_REFERENCE_MAX, { error: `externalReference must be ${RECONCILE_REFERENCE_MAX} characters or fewer.` });
const notes = () =>
  z
    .string({ error: "notes must be a string." })
    .trim()
    .max(RECONCILE_NOTES_MAX, { error: `notes must be ${RECONCILE_NOTES_MAX} characters or fewer.` });
const confirmation = () =>
  z
    .strictObject(
      {
        acknowledged: z
          .array(z.string({ error: CONFIRMATION }).max(64, { error: CONFIRMATION }), { error: CONFIRMATION })
          .max(20, { error: CONFIRMATION }),
        typed: z.string({ error: CONFIRMATION }).optional(),
      },
      { error: CONFIRMATION }
    )
    .optional();

/**
 * payments.accept-receipts: the verified receipts settle the bill exactly.
 * It takes no amount; a reference and notes are kept with the event if
 * given. `action` admits one value, so the kit's form sends it without
 * showing it (kit/action-form.tsx).
 */
export const AcceptReceiptsBody = z.strictObject(
  {
    action: resolution("accept_exact"),
    externalReference: reference().optional().meta({ title: "External reference" }),
    notes: notes().optional().meta({ title: "Notes" }),
    confirmation: confirmation(),
  },
  { error: bodyError }
);
export const ACCEPT_RECEIPTS_BODY_VERSION = 2;

/**
 * payments.record-adjustment: a collection or refund completed outside MGM,
 * with the amount, a reference and notes, and the tenant's name typed in
 * `confirmation` (the host's Confirmation, src/lib/gui/contract.ts, sent
 * with a typed action). `externalAmount` is in the currency's major units,
 * as a bill's total_amount is (fn_payment_reconcile adds it to the
 * received total and compares that with the bill), not in the minor units
 * the period review copies.
 */
export const RecordAdjustmentBody = z.strictObject(
  {
    action: resolution("record_external"),
    // z.number() refuses NaN and Infinity (zod 4).
    externalAmount: z.number({ error: "externalAmount must be a number." }).meta({
      title: "External amount (negative for a refund)",
      description: "In the currency's major units, as the bill's total: 2500 for UGX 2,500, 12.5 for USD 12.50.",
    }),
    externalReference: reference()
      .min(1, { error: "externalReference is required." })
      .meta({ title: "External reference" }),
    notes: notes().min(1, { error: "notes are required." }).meta({ title: "Notes" }),
    confirmation: confirmation(),
  },
  { error: bodyError }
);
export const RECORD_ADJUSTMENT_BODY_VERSION = 2;

/**
 * POST /api/payments/attempts/[id]/reconcile, which both actions above send
 * to: one of them, told apart by `action`. The attempt comes from the path.
 * The route parses with this, and gui-surface.test.ts check 2 accepts each
 * action's input as one of its options.
 *
 * A reference over RECONCILE_REFERENCE_MAX characters or notes over
 * RECONCILE_NOTES_MAX (./reconcile-limits.ts), after trimming, are refused.
 * Before these schemas the route took any reference and cut notes to 500
 * characters (PaymentsCapability.reconcile still cuts them, for callers
 * other than the route); refusing says so instead of saving less than was
 * typed. `typed` has no length limit: the capability compares it with
 * tenants.display_name, which has none either (TEXT); if display_name gets
 * a limit, cap typed at it. There is no digest, because prepare returns
 * none; if it comes to, add one with a version bump.
 *
 * Version 1 was one object for both, whose form showed the raw Resolution
 * choice, and an amount on Accept that had to stay blank (#218, #287).
 */
export const ReconcileAttemptBody = z.discriminatedUnion("action", [AcceptReceiptsBody, RecordAdjustmentBody], {
  error: (issue) => (issue.code === "invalid_union" ? ACTION : "Request body must be an object"),
});
export type ReconcileAttemptInput = z.output<typeof ReconcileAttemptBody>;

/**
 * Fixed copy for reconciliation's refusals and the reasons its actions are
 * unavailable, shared by the capability and the GUI surface, so a person
 * reads the same sentence from the route and from the view. Never a
 * database message.
 */
export const RECONCILE_COPY = {
  notNeeded: "This attempt does not need reconciliation.",
  unknownOutcome:
    "A checkout for this bill has an unknown outcome: investigate its reference with the provider before reconciling.",
  mixed: "This bill's receipts are in more than one currency: investigate them with the provider before reconciling.",
  notExact: "The verified receipts do not come to exactly the current bill: record a completed adjustment instead.",
  adjustmentFields: "An external amount, reference, and notes are required for a completed adjustment.",
  adjustmentInexact: "The amount must bring the received total to exactly the current bill, with a reference and notes.",
  acceptNoAmount: "Accepting exact receipts takes no amount: record a completed adjustment instead.",
  nameRequired: "Recording a completed adjustment needs the tenant's name typed: use Record completed adjustment.",
  nameMismatch: "The name typed does not match this bill's tenant.",
  forbidden: "Not authorized to act on this organization.",
  unavailable: "Could not reconcile this attempt right now.",
} as const;
