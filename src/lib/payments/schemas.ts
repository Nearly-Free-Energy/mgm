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
 * exact acceptance's lack of an amount. The schemas stay unrefined objects,
 * so the host can clean a loader's prefill against them (cleanPrefill in
 * src/lib/gui/host/server/merge.ts omits fields from them) and the kit can
 * draw them as a form.
 *
 * Client-safe: its only runtime import is zod. If it gains a server-only or
 * side-effecting runtime import, revisit, and revisit payments-route-
 * boundary.test.ts's zod entry, which allows the routes to load it.
 */
import { z } from "zod";

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

/**
 * POST /api/payments/attempts/[id]/reconcile. The attempt comes from the path.
 *
 * - accept_exact: the verified receipts settle the bill exactly. It takes
 *   no amount; a reference and notes are kept with the event if given.
 * - record_external: a collection or refund completed outside MGM, with
 *   the amount (negative for a refund), a reference and notes, and the
 *   tenant's name typed in `confirmation` (the host's Confirmation,
 *   src/lib/gui/contract.ts, sent with a typed action).
 *
 * `typed` has no length limit: the capability compares it with
 * tenants.display_name, which has none either (TEXT); if display_name gets
 * a limit, cap typed at it. There is no digest, because prepare returns
 * none; if it comes to, add one with a version bump.
 */
export const ReconcileAttemptBody = z.strictObject(
  {
    action: z
      .enum(RECONCILE_ACTIONS, { error: "action must be 'accept_exact' or 'record_external'." })
      .meta({ title: "Resolution" }),
    // z.number() refuses NaN and Infinity (zod 4).
    externalAmount: z
      .number({ error: "externalAmount must be a number." })
      .optional()
      .meta({ title: "External amount (negative for a refund)" }),
    externalReference: z
      .string({ error: "externalReference must be a string." })
      .trim()
      .max(200, { error: "externalReference must be 200 characters or fewer." })
      .optional()
      .meta({ title: "External reference" }),
    notes: z
      .string({ error: "notes must be a string." })
      .trim()
      .max(500, { error: "notes must be 500 characters or fewer." })
      .optional()
      .meta({ title: "Notes" }),
    confirmation: z
      .strictObject(
        {
          acknowledged: z
            .array(z.string({ error: CONFIRMATION }).max(64, { error: CONFIRMATION }), { error: CONFIRMATION })
            .max(20, { error: CONFIRMATION }),
          typed: z.string({ error: CONFIRMATION }).optional(),
        },
        { error: CONFIRMATION }
      )
      .optional(),
  },
  { error: bodyError }
);
export const RECONCILE_ATTEMPT_BODY_VERSION = 1;
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
