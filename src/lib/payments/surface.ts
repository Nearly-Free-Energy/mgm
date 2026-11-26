import "server-only";

/**
 * What payments contributes to GUIs (src/lib/gui/surface.ts): navigation to
 * its pages, which are served outside the GUI contract (`legacy: true`), with
 * the labels the current chrome uses; and a billing period's online payment
 * attempts as the `payments.bill-attempts` view, a tab of billing's period
 * review, with Refresh status and the two reconciliations on each attempt.
 * A page that moves to a view keeps its nav id. And the community's payment
 * readiness as the `payments.payment-setup` view, a section of billing's
 * send queue, which carries the link to the community's Payment page.
 *
 * `payments.bill-attempts` is a new page (…/[periodId]/payments) with no
 * page.tsx, so the catalog marks it `servedBy: "view"` and the host's
 * catch-all serves it. It replaced the legacy period page's payment history
 * dialog, deleted with the legacy billing screens (src/lib/billing/parity.ts).
 *
 * While Payments is off, the host still lists this tab on the period review
 * (attach.whilePluginOff: "listed") and loads it with the gate's notice, and
 * keeps Refresh status and both reconciliations enabled and preparable
 * (whilePluginOff: "enabled"), as the legacy dialog offered them, because
 * their routes accept them then by design: each is a PaymentExemption in
 * src/lib/runtime/__tests__/route-rules.ts, and docs/payments-rollout.md
 * keeps history and verification available while Payments is off.
 * gui-surface.test.ts allows the fields only while that holds, and only on
 * the three actions its WHILE_OFF_ACTIONS list pins, so another payments
 * action (a payment link, say) is never offered while Payments is off; if a
 * route's exemption goes, drop its actions' field and their entries
 * (parity.ts, payments-while-off).
 *
 * `payments.payment-setup` is a new page too (…/[periodId]/payment-setup),
 * served the same way. It replaces the legacy period page's banner shown
 * when online payments are not set up (parity.ts, payment-setup). It is a
 * section, not a tab, because the host lists a disabled plugin's sections
 * with the gate's notice, and Payments being off is one of the states it
 * explains. If the host comes to hide a disabled plugin's sections too,
 * revisit.
 *
 * Its watchers report what needs a manager in payments: `payments.reconcile`,
 * each period with attempts held for reconciliation (critical when one
 * reached Pesapal, otherwise a warning), and `payments.failed`, each period
 * with failures in the last week on bills still to be paid, each leading to
 * the period's payments, or to the bill when only one is concerned; and
 * `payments.not-submitted`, each community where three or more checkouts in
 * the last day never reached Pesapal, leading to its payment setup. Each
 * composes the capability, so it has a longer budget than the host's
 * default. While Payments is off the host still runs `payments.reconcile`
 * (whilePluginOff: "checked"), since the reconcile route accepts
 * reconciliation then (its PaymentExemption), and skips `payments.failed`
 * and `payments.not-submitted`: no customer can pay online then, so a
 * failure is no longer something to follow up.
 */
import type { Contribution } from "@/lib/gui/surface";
import { PAYMENTS_PLUGIN_NAME } from "@/lib/plugins/bundled";
import {
  ACCEPT_RECEIPTS_BODY_VERSION,
  AcceptReceiptsBody,
  RECORD_ADJUSTMENT_BODY_VERSION,
  REFRESH_ATTEMPT_BODY_VERSION,
  RecordAdjustmentBody,
  RefreshAttemptBody,
} from "./schemas";
import {
  loadBillAttempts,
  prepareAcceptReceipts,
  prepareRecordAdjustment,
  reconcileAvailable,
} from "./surface/bill-attempts";
import { loadFailedSignals, loadNotSubmittedSignals, loadReconcileSignals } from "./surface/attention-signals";
import { FAILED_EXAMPLES, NOT_SUBMITTED_EXAMPLES, RECONCILE_EXAMPLES } from "./surface/attention-signals-examples";
import { FAILED_SIGNAL, NOT_SUBMITTED_SIGNAL, RECONCILE_SIGNAL } from "./surface/attention-signals-model";
import { BILL_ATTEMPTS_EXAMPLES } from "./surface/bill-attempts-examples";
import { loadPaymentSetup } from "./surface/payment-setup";
import { PAYMENT_SETUP_EXAMPLES } from "./surface/payment-setup-examples";
import { PAYMENT_SETUP_KEYS, PAYMENT_SETUP_VIEW } from "./surface/payment-setup-model";
import {
  ACCEPT_RECEIPTS_ACTION,
  BILL_ATTEMPTS_KEYS,
  BILL_PARAM,
  RECORD_ADJUSTMENT_ACTION,
  REFRESH_ATTEMPT_ACTION,
} from "./surface/bill-attempts-model";

/**
 * Each payments watcher's budget: composePayments checks the session and the
 * roles before the capability's reads and the bills', so the host's default
 * 1.5 s is tight on a cold path.
 */
const ATTENTION_BUDGET_MS = 3_000;

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
      // Listed while Payments is off: the loader reads only through RLS and
      // listHistory, which runs while Payments is off (LOADER_READS and
      // capability-gating.test.ts, checked by gui-surface.test.ts).
      attach: { to: { view: "billing.period-review" }, order: 10, hint: "tab", whilePluginOff: "listed" },
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
    {
      id: PAYMENT_SETUP_VIEW,
      kind: "record",
      path: "/microgrids/[id]/billing/[periodId]/payment-setup",
      params: { id: "microgrid", periodId: "billingPeriod" },
      // No `entity`: with the period as its entity, the host would append
      // billing's targeted actions on a period (billing.delete-period) to
      // this view, as for payments.bill-attempts.
      // A section of the send queue, where a manager finds no links to send
      // when payments are not set up; listed there while Payments is off.
      attach: { to: { view: "billing.send-queue" }, order: 10, hint: "section" },
      // No `agent`: never read by an assistant (#133, deny by default).
      // Read through the person's own client and the capability's
      // getReadiness (./surface/payment-setup.ts), which asks no provider;
      // loads while Payments is off, with the gate's notice. No refresh:
      // setup changes only on the community's Payment page, which a person
      // leaves this page to visit.
      cost: "db",
      declares: { keys: PAYMENT_SETUP_KEYS },
      examples: PAYMENT_SETUP_EXAMPLES,
      load: loadPaymentSetup,
    },
  ],
  // All three human-only (no assistant proposes a payment write) and
  // `targeted: false`: offered only where this view's loader links them, on
  // the attempts it shows; each reconciliation's input fixes its
  // resolution (../schemas.ts). No other view shows payment attempts; if one does, revisit.
  // Who may act is the routes' and the capability's to decide: any staff
  // member with access to the organization (./surface/bill-attempts.ts).
  // All three stay enabled while Payments is off (whilePluginOff), since
  // their routes are the PaymentExemptions "POST
  // /api/payments/attempts/[id]/refresh" and "POST
  // /api/payments/attempts/[id]/reconcile" in
  // src/lib/runtime/__tests__/route-rules.ts; if one goes, drop the field
  // from its actions.
  // Every action here is repeat "safe": src/lib/gui/__tests__/repeat.db.test.ts
  // sends each twice to its route. If it fails for one, that one is not safe.
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
      repeat: "safe",
      targeted: false,
      whilePluginOff: "enabled",
    },
    // Records an amount from outside MGM, possibly negative, and marks the
    // bill paid: typed, the tenant's name, which the capability checks again.
    {
      ...RECORD_ADJUSTMENT_ACTION,
      target: "paymentAttempt",
      input: RecordAdjustmentBody,
      inputVersion: RECORD_ADJUSTMENT_BODY_VERSION,
      method: "POST",
      path: "/api/payments/attempts/[id]/reconcile",
      bind: { path: { id: "paymentAttempt" } },
      risk: "money",
      confirm: "typed",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
      prepare: prepareRecordAdjustment,
      available: reconcileAvailable("record"),
      whilePluginOff: "enabled",
    },
    // Accepts verified receipts that come to the bill exactly, and marks it
    // paid. Its form shows only the optional reference and notes; its input
    // has no amount field (./schemas.ts).
    {
      ...ACCEPT_RECEIPTS_ACTION,
      target: "paymentAttempt",
      input: AcceptReceiptsBody,
      inputVersion: ACCEPT_RECEIPTS_BODY_VERSION,
      method: "POST",
      path: "/api/payments/attempts/[id]/reconcile",
      bind: { path: { id: "paymentAttempt" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
      repeat: "safe",
      targeted: false,
      prepare: prepareAcceptReceipts,
      available: reconcileAvailable("accept"),
      whilePluginOff: "enabled",
    },
  ],
  signals: [
    // Reconciliation stays available while Payments is off (docs/payments-rollout.md), so held attempts are still reported then.
    { id: RECONCILE_SIGNAL, budgetMs: ATTENTION_BUDGET_MS, load: loadReconcileSignals, examples: RECONCILE_EXAMPLES, whilePluginOff: "checked" },
    { id: FAILED_SIGNAL, budgetMs: ATTENTION_BUDGET_MS, load: loadFailedSignals, examples: FAILED_EXAMPLES },
    // Hidden while Payments is off, as failures are: no checkout is started then, so none can fail to reach Pesapal.
    { id: NOT_SUBMITTED_SIGNAL, budgetMs: ATTENTION_BUDGET_MS, load: loadNotSubmittedSignals, examples: NOT_SUBMITTED_EXAMPLES },
  ],
};
