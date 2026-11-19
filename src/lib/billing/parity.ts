/**
 * The billing parity table (#201): every control on today's legacy billing
 * period screens, and the contributed action or view link that replaces it.
 *
 * The legacy screens are the periods list (BillingPeriodList.tsx), the
 * period review (BillingTable.tsx and the menus, panels and dialogs it
 * renders) and the period history page, under
 * src/app/(gui)/microgrids/[id]/billing/. #201 keeps them mounted until
 * every row here is contributed, then deletes them; parity.test.ts fails
 * while a row has no contribution and is not listed as pending there, so a
 * control cannot be lost on the way.
 *
 * Out of the table, on purpose:
 *  - The rest of the microgrid layout's chrome on these pages (the
 *    Operations and Setup tabs, the breadcrumb, Edit microgrid and the
 *    timezone nudge): it belongs to the microgrid pages and stays. The
 *    Billing tab is billing's sub-navigation, which #201's Deletes item
 *    removes, so it is a row (billing-tab).
 *  - Controls that only change what is on screen (opening the pre-flight
 *    panel, the create form, a dialog, a period picker's list) and the fields
 *    inside a form: they are the form of the action their submit maps to.
 *  - The pre-flight panel's starting-reading rows, which read
 *    /api/openems/energy: the period page never asks for a seed reading
 *    today (it passes no seedNeededByTenantId), so they cannot be reached.
 *  - The paid-bill poll, which refreshes the table on its own: a view's
 *    `live` refresh replaces it.
 * If one of these becomes a control on a billing screen, add a row.
 *
 * The inventory behind this table was taken on 18 November 2026 from the
 * components named in `legacy`. A control added to those screens later needs
 * a row here in the same change.
 */
import type { Confirm, EntityKind } from "@/lib/gui/contract";

/** The #201 pull request that contributes a row, in the issue's words. */
export type ParityPullRequest =
  | "Contribute billing periods and period creation as a view"
  | "Contribute period review, with targeted actions for each bill"
  | "Contribute a period's history"
  | "Contribute the close checklist on …/close"
  | "Contribute the send queue on …/send"
  | "Draw period review as a copy table in Gridtop"
  | "Serve the billing pages through the GUI host"
  /** Added to #201 in review (#205): the payments plugin's view of a bill's attempts. */
  | "Contribute a bill's payment attempts"
  /**
   * Nothing in #201 contributes it yet: it needs a decision before the
   * deletes. parity.test.ts keeps such a row pending whatever is contributed.
   */
  | "unscheduled";

export type ParityScreen = "periods" | "period-review" | "period-history";

export type ParityAction = {
  kind: "action";
  plugin: "billing" | "payments";
  /** The action id the plugin contributes. */
  action: `${"billing" | "payments"}.${string}`;
  target: EntityKind;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** The route as spelled under src/app/api, with its own segment names. */
  route: string;
  /** The contract derives the tone and the lowest confirmation from it (contribution-schema.ts). */
  risk: "write" | "money" | "external" | "destructive";
  confirm: Confirm;
  /**
   * The schema in src/lib/billing/schemas.ts the route parses its body with,
   * or null when the route has no JSON body today; a route must parse a
   * schema before its action can be contributed (gui-surface.test.ts check 2).
   */
  form: string | null;
  /** Set when the route does not exist yet, with what replaces today's call. */
  newRoute?: string;
  /** The view that offers it. */
  view: string;
};

export type ParityLink = {
  kind: "link";
  /** The view whose model carries the link. */
  view: string;
  /** A page under src/app/(gui) or a GET route under src/app/api. */
  href: string;
  download?: true;
};

/**
 * A clipboard control. Copying is the GUI's to draw, not an action or a link,
 * so nothing in a contribution shows it: the pull request that delivers it
 * removes the row from PENDING, and the test then requires its view.
 */
export type ParityCopy = {
  kind: "copy";
  view: string;
  what: string;
};

/** A control replaced by a whole contributed view. */
export type ParityView = {
  kind: "view";
  view: string;
};

/** Navigation replaced by a contributed nav entry that opens a view (not a legacy page). */
export type ParityNav = {
  kind: "nav";
  nav: string;
};

export type ParityRow = {
  id: string;
  screen: ParityScreen;
  /** The control as labelled today; several controls doing one thing share a row. */
  control: string;
  /** Where it is today. */
  legacy: string;
  replacedBy: ParityAction | ParityLink | ParityCopy | ParityView | ParityNav;
  pr: ParityPullRequest;
  note?: string;
};

const PERIODS = "Contribute billing periods and period creation as a view";
const REVIEW = "Contribute period review, with targeted actions for each bill";
const HISTORY = "Contribute a period's history";
const CLOSE = "Contribute the close checklist on …/close";
const SEND = "Contribute the send queue on …/send";
const GRIDTOP = "Draw period review as a copy table in Gridtop";
const SERVE = "Serve the billing pages through the GUI host";
const ATTEMPTS = "Contribute a bill's payment attempts";

export const BILLING_PARITY: readonly ParityRow[] = [
  // ── Periods list ──────────────────────────────────────────────────────────
  {
    id: "create-period",
    screen: "periods",
    control: "Create Period (form submit, from + New period or + Create period)",
    legacy: "src/components/BillingPeriodList.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.create-period",
      target: "microgrid",
      method: "POST",
      route: "/api/billing-periods",
      risk: "write",
      confirm: "none",
      form: "CreatePeriodBody",
      view: "billing.periods",
    },
    pr: PERIODS,
  },
  {
    id: "open-period",
    screen: "periods",
    control: "A period in the period picker; View on a period row",
    legacy: "src/components/BillingPeriodList.tsx, src/components/ui/period-picker.tsx",
    replacedBy: { kind: "link", view: "billing.periods", href: "/microgrids/[id]/billing/[periodId]" },
    pr: PERIODS,
  },
  {
    id: "delete-period",
    screen: "periods",
    control: "Delete on a period row, and Delete in the period header (draft only)",
    legacy: "src/components/BillingPeriodList.tsx, src/components/BillingTable.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.delete-period",
      target: "billingPeriod",
      method: "DELETE",
      route: "/api/billing-periods/[periodId]",
      // A DELETE needs typed or ceremony confirmation (contribution-schema.ts).
      risk: "destructive",
      confirm: "typed",
      form: "DeletePeriodBody",
      view: "billing.periods",
    },
    pr: PERIODS,
    note: "The legacy screens still delete through PostgREST with the browser's own client, with no typed name and no plugin gate, until they are deleted.",
  },

  {
    id: "billing-tab",
    screen: "periods",
    control: "The Billing tab in the microgrid's tabs",
    legacy: "src/app/(gui)/microgrids/[id]/tab-nav.tsx",
    replacedBy: { kind: "nav", nav: "billing.periods" },
    pr: SERVE,
    note: "Today the nav entry is legacy: true and points at the legacy page; it is contributed when it opens the view.",
  },

  // ── Period review ─────────────────────────────────────────────────────────
  {
    id: "generate-bills",
    screen: "period-review",
    control: "Generate (N tenants) in the pre-flight panel (opened by Generate / Refresh Readings)",
    legacy: "src/components/billing/preflight-panel.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.generate-bills",
      target: "billingPeriod",
      method: "POST",
      route: "/api/billing/generate",
      risk: "money",
      confirm: "confirm",
      form: "GenerateBillsBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
  },
  {
    id: "regenerate-bill",
    screen: "period-review",
    control:
      "Regenerate selected bills; row menu Regenerate from edge data, Switch back to edge data and Re-enter manual readings; a row banner's Retry after a failed generation",
    legacy: "src/components/BillingTable.tsx, src/components/billing/row-actions-menu.tsx, src/components/billing/regenerate-row-dialog.tsx, src/components/billing/regenerate-multi-dialog.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.regenerate-bill",
      target: "lineItem",
      method: "POST",
      route: "/api/billing/generate",
      risk: "money",
      confirm: "confirm",
      form: "GenerateBillsBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
    note: "A paid bill is previewed first (POST /api/billing/regenerate-preview, PreviewBillsBody); that preview becomes the action's prepare.",
  },
  {
    id: "record-usage",
    screen: "period-review",
    control: "The Usage (kWh) and End (kWh) cells on a manual row",
    legacy: "src/components/billing/manual-usage-cell.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.record-usage",
      target: "lineItem",
      method: "PATCH",
      route: "/api/billing-line-items/[lineItemId]/usage",
      risk: "money",
      confirm: "none",
      form: "LineItemUsageBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
  },
  {
    id: "mark-paid",
    screen: "period-review",
    control: "Row menu Mark as paid… (with notes)",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.mark-paid",
      target: "lineItem",
      method: "PATCH",
      route: "/api/billing-line-items/[lineItemId]/payment-status",
      risk: "money",
      confirm: "confirm",
      form: "LineItemPaymentStatusBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
  },
  {
    id: "mark-unpaid",
    screen: "period-review",
    control: "Row menu Mark as unpaid",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.mark-unpaid",
      target: "lineItem",
      method: "PATCH",
      route: "/api/billing-line-items/[lineItemId]/payment-status",
      risk: "money",
      confirm: "none",
      form: "LineItemPaymentStatusBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
  },
  {
    id: "mark-refunded",
    screen: "period-review",
    control: "Row menu Mark as refunded… (with notes)",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.mark-refunded",
      target: "lineItem",
      method: "PATCH",
      route: "/api/billing-line-items/[lineItemId]/payment-status",
      risk: "money",
      confirm: "typed",
      form: "LineItemPaymentStatusBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
    note: "Typed: a refund is final (no change leads out of refunded).",
  },
  {
    id: "mark-failed",
    screen: "period-review",
    control: "Row menu Mark as failed",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.mark-failed",
      target: "lineItem",
      method: "PATCH",
      route: "/api/billing-line-items/[lineItemId]/payment-status",
      risk: "money",
      confirm: "confirm",
      form: "LineItemPaymentStatusBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
  },
  {
    id: "cancel-payment-link",
    screen: "period-review",
    control: "Row menu Cancel pending link",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.cancel-payment-link",
      target: "lineItem",
      method: "PATCH",
      route: "/api/billing-line-items/[lineItemId]/payment-status",
      risk: "money",
      confirm: "confirm",
      form: "LineItemPaymentStatusBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
  },
  {
    id: "download-bill",
    screen: "period-review",
    control: "Row menu Download bill (PDF)",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: {
      kind: "link",
      view: "billing.period-review",
      href: "/api/billing-line-items/[lineItemId]/pdf",
      download: true,
    },
    pr: REVIEW,
  },
  {
    id: "export-csv",
    screen: "period-review",
    control: "Export CSV in the period header; Export CSV for URA in the closed dialog",
    legacy: "src/components/BillingTable.tsx, src/components/ui/close-period-dialog.tsx",
    replacedBy: {
      kind: "link",
      view: "billing.period-review",
      href: "/api/billing-periods/[periodId]/export-csv",
      download: true,
    },
    pr: REVIEW,
  },
  {
    id: "view-history",
    screen: "period-review",
    control: "View history in the period header; row menu View history (filtered to the tenant)",
    legacy: "src/components/BillingTable.tsx, src/components/billing/row-actions-menu.tsx",
    replacedBy: { kind: "link", view: "billing.period-review", href: "/microgrids/[id]/billing/[periodId]/history" },
    pr: REVIEW,
  },
  {
    id: "view-tenant",
    screen: "period-review",
    control: "Row menu View tenant",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: { kind: "link", view: "billing.period-review", href: "/microgrids/[id]/setup/tenants/[tenantId]" },
    pr: REVIEW,
  },
  {
    id: "payment-setup",
    screen: "period-review",
    control: "Go to Payment tab, in the banner shown when online payments are not set up",
    legacy: "src/components/BillingTable.tsx",
    replacedBy: { kind: "link", view: "billing.period-review", href: "/communities/[id]/payment" },
    pr: REVIEW,
  },
  {
    id: "close-period",
    screen: "period-review",
    control: "Close Period, through the close dialog's confirmation step",
    legacy: "src/components/BillingTable.tsx, src/components/ui/close-period-dialog.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.close-period",
      target: "billingPeriod",
      method: "POST",
      route: "/api/billing-periods/[periodId]/close",
      risk: "money",
      confirm: "ceremony",
      form: "ClosePeriodBody",
      view: "billing.close-checklist",
    },
    pr: CLOSE,
  },
  {
    id: "payment-link",
    screen: "period-review",
    control: "Row menu Generate payment link and Regenerate payment link; a row banner's Retry after a failed link",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: {
      kind: "action",
      plugin: "payments",
      action: "payments.payment-link",
      target: "lineItem",
      method: "POST",
      route: "/api/billing-line-items/[lineItemId]/url",
      risk: "external",
      confirm: "confirm",
      form: null,
      view: "billing.send-queue",
    },
    pr: SEND,
    note: "The route reads no body although its client sends { force }; it needs a body schema (an empty one) before the action can be contributed.",
  },
  {
    id: "payment-history",
    screen: "period-review",
    control: "Payment history on a row (opens the attempts dialog)",
    legacy: "src/components/payments/payment-history.tsx",
    replacedBy: { kind: "view", view: "payments.bill-attempts" },
    pr: ATTEMPTS,
    note: "The payments plugin's view of a bill's attempts, attached to period review; decided in review of #205.",
  },

  {
    id: "refresh-attempt",
    screen: "period-review",
    control: "Refresh status, per attempt in the payment history dialog",
    legacy: "src/components/payments/payment-history.tsx",
    replacedBy: {
      kind: "action",
      plugin: "payments",
      action: "payments.refresh-attempt",
      target: "paymentAttempt",
      method: "POST",
      route: "/api/payments/attempts/[id]/refresh",
      risk: "write",
      confirm: "none",
      form: null,
      view: "payments.bill-attempts",
    },
    pr: ATTEMPTS,
    note: "Owned by the payments plugin; offered on its view of a bill's attempts.",
  },
  {
    id: "record-adjustment",
    screen: "period-review",
    control: "Record completed adjustment (form), in the payment history dialog",
    legacy: "src/components/payments/payment-history.tsx",
    replacedBy: {
      kind: "action",
      plugin: "payments",
      action: "payments.record-adjustment",
      target: "paymentAttempt",
      method: "POST",
      route: "/api/payments/attempts/[id]/reconcile",
      risk: "money",
      confirm: "typed",
      form: null,
      view: "payments.bill-attempts",
    },
    pr: ATTEMPTS,
    note: "Owned by the payments plugin, whose reconcile route validates its body by hand; it needs a schema before it can be contributed. Typed: it records an amount from outside MGM, possibly negative.",
  },
  {
    id: "accept-receipts",
    screen: "period-review",
    control: "Accept exact receipts, in the payment history dialog",
    legacy: "src/components/payments/payment-history.tsx",
    replacedBy: {
      kind: "action",
      plugin: "payments",
      action: "payments.accept-receipts",
      target: "paymentAttempt",
      method: "POST",
      route: "/api/payments/attempts/[id]/reconcile",
      risk: "money",
      confirm: "confirm",
      form: null,
      view: "payments.bill-attempts",
    },
    pr: ATTEMPTS,
    note: "Owned by the payments plugin; offered on its view of a bill's attempts.",
  },

  {
    id: "copy-cells",
    screen: "period-review",
    control: "Copy on a cell of the bills table, and the Copy buttons on the totals (the URA paste workflow)",
    legacy: "src/components/BillingTable.tsx",
    replacedBy: { kind: "copy", view: "billing.period-review", what: "each cell's bare figure, and each total" },
    pr: GRIDTOP,
  },
  {
    id: "copy-payment-link",
    screen: "period-review",
    control: "Copy link in the payment-link popover; row menu Copy payment link",
    legacy: "src/components/billing/payment-link-popover.tsx, src/components/billing/row-actions-menu.tsx",
    replacedBy: { kind: "copy", view: "billing.send-queue", what: "a bill's payment link" },
    pr: SEND,
  },

  // ── Period history ────────────────────────────────────────────────────────
  {
    id: "back-to-period",
    screen: "period-history",
    control: "Back to period",
    legacy: "src/app/(gui)/microgrids/[id]/billing/[periodId]/history/page.tsx",
    replacedBy: { kind: "link", view: "billing.period-history", href: "/microgrids/[id]/billing/[periodId]" },
    pr: HISTORY,
  },
  {
    id: "history-show-all",
    screen: "period-history",
    control: "Show all, when the history is filtered to one tenant",
    legacy: "src/app/(gui)/microgrids/[id]/billing/[periodId]/history/page.tsx",
    replacedBy: { kind: "link", view: "billing.period-history", href: "/microgrids/[id]/billing/[periodId]/history" },
    pr: HISTORY,
  },
];
