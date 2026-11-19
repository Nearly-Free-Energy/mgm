import "server-only";

/**
 * What payments contributes to GUIs (src/lib/gui/surface.ts): navigation to
 * its pages, which are served outside the GUI contract (`legacy: true`), with
 * the labels the current chrome uses; and a billing period's online payment
 * attempts as the `payments.bill-attempts` view, a tab of billing's period
 * review, with Refresh status and the two reconciliations on each attempt.
 * A page that moves to a view keeps its nav id.
 *
 * `payments.bill-attempts` is a new page (…/[periodId]/payments) with no
 * page.tsx, so the catalog marks it `servedBy: "view"` and the host's
 * catch-all serves it. It replaces the legacy period page's payment history
 * dialog (src/components/payments/payment-history.tsx), which stays mounted
 * until #201's Deletes pull request (src/lib/billing/parity.ts).
 *
 * While Payments is off, the host leaves this tab out of the period review
 * and shows the view's own actions disabled with the gate's notice, although
 * the routes keep accepting them by design (their PaymentExemption entries in
 * src/lib/runtime/__tests__/route-rules.ts, and docs/payments-rollout.md:
 * history and verification stay available). The legacy dialog keeps them
 * reachable meanwhile; parity.ts's payments-while-off row holds the deletes
 * until that is decided. If the host comes to keep a plugin's exempt actions
 * enabled while it is off, revisit this paragraph.
 */
import type { Contribution } from "@/lib/gui/surface";
import { PAYMENTS_PLUGIN_NAME } from "@/lib/plugins/bundled";
import {
  RECONCILE_ATTEMPT_BODY_VERSION,
  REFRESH_ATTEMPT_BODY_VERSION,
  ReconcileAttemptBody,
  RefreshAttemptBody,
} from "./schemas";
import {
  loadBillAttempts,
  prepareAcceptReceipts,
  prepareRecordAdjustment,
  reconcileAvailable,
} from "./surface/bill-attempts";
import { BILL_ATTEMPTS_EXAMPLES } from "./surface/bill-attempts-examples";
import {
  ACCEPT_RECEIPTS_ACTION,
  BILL_ATTEMPTS_KEYS,
  BILL_PARAM,
  RECORD_ADJUSTMENT_ACTION,
  REFRESH_ATTEMPT_ACTION,
} from "./surface/bill-attempts-model";

export const PAYMENTS_SURFACE: Contribution = {
  plugin: PAYMENTS_PLUGIN_NAME,
  nav: [
    {
      id: "payments.org-accounts",
      title: "Payment accounts",
      icon: "accounts",
      group: "configure",
      order: 40,
      href: "/organizations/[id]/payments",
      needs: ["organization"],
      legacy: true,
    },
  ],
  views: [
    {
      id: "payments.bill-attempts",
      kind: "collection",
      path: "/microgrids/[id]/billing/[periodId]/payments",
      params: { id: "microgrid", periodId: "billingPeriod" },
      // No `entity`: with the period as its entity, the host would append
      // billing's targeted actions on a period (billing.delete-period) to
      // this view. If billing.delete-period becomes `targeted: false`, an
      // entity may be added.
      // The bill whose attempts are shown; without it, the period's bills.
      // The contract attaches a view to a view, not to one of its rows, so
      // the tab opens on the bills and each links to its own attempts.
      query: [BILL_PARAM],
      attach: { to: { view: "billing.period-review" }, order: 10, hint: "tab" },
      // No `agent`: never read by an assistant (#133, deny by default). It
      // carries tenants' names and merchant references.
      // Read through the person's own client and the capability's
      // listHistory (./surface/bill-attempts.ts); loads while Payments is
      // off, with the gate's notice. No refresh: Refresh status is a
      // person's to press, since it asks the provider.
      cost: "db",
      declares: { keys: BILL_ATTEMPTS_KEYS },
      examples: BILL_ATTEMPTS_EXAMPLES,
      load: loadBillAttempts,
    },
  ],
  // All three human-only (no assistant proposes a payment write) and
  // `targeted: false`: offered only where this view's loader links them, on
  // the attempts it shows, each reconciliation prefilled with its
  // resolution. No other view shows payment attempts; if one does, revisit.
  // Who may act is the routes' and the capability's to decide: any staff
  // member with access to the organization (./surface/bill-attempts.ts).
  actions: [
    // Asks the provider about an attempt already submitted and records only
    // what it verifies, never a figure a person enters: "write", not
    // "money", and not "external", which is contacting a person. The loader
    // offers it only on attempts with a tracking id.
    {
      ...REFRESH_ATTEMPT_ACTION,
      target: "paymentAttempt",
      input: RefreshAttemptBody,
      inputVersion: REFRESH_ATTEMPT_BODY_VERSION,
      method: "POST",
      path: "/api/payments/attempts/[id]/refresh",
      bind: { path: { id: "paymentAttempt" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    },
    // Records an amount from outside MGM, possibly negative, and marks the
    // bill paid: typed, the tenant's name, which the capability checks again.
    {
      ...RECORD_ADJUSTMENT_ACTION,
      target: "paymentAttempt",
      input: ReconcileAttemptBody,
      inputVersion: RECONCILE_ATTEMPT_BODY_VERSION,
      method: "POST",
      path: "/api/payments/attempts/[id]/reconcile",
      bind: { path: { id: "paymentAttempt" } },
      risk: "money",
      confirm: "typed",
      humanOnly: true,
      targeted: false,
      prepare: prepareRecordAdjustment,
      available: reconcileAvailable("record"),
    },
    // Accepts verified receipts that come to the bill exactly, and marks it
    // paid. Its form shows the optional amount, reference and notes too; the
    // capability refuses an amount.
    {
      ...ACCEPT_RECEIPTS_ACTION,
      target: "paymentAttempt",
      input: ReconcileAttemptBody,
      inputVersion: RECONCILE_ATTEMPT_BODY_VERSION,
      method: "POST",
      path: "/api/payments/attempts/[id]/reconcile",
      bind: { path: { id: "paymentAttempt" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
      prepare: prepareAcceptReceipts,
      available: reconcileAvailable("accept"),
    },
  ],
};
