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
  /**
   * What in the view's model carries it: the LinkRef with this id (in the
   * model's links or a row's), a row's own href ("row"), or an EntityRef's
   * href ("entity"). Never the host's trail, which links every view's
   * parents. Unset while nothing is decided: the row stays pending.
   */
  via?: { link: string } | "row" | "entity";
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
    replacedBy: { kind: "link", view: "billing.periods", href: "/microgrids/[id]/billing/[periodId]", via: "row" },
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
    // Waits for a GUI's form, which no #201 pull request names yet.
    pr: "unscheduled",
    note: "Pending: contributed with no prepare and no prefill (GenerateBillsBody is refined) and `targeted: false`, but offered by no view, since no interface can submit it. The kit cannot render its tenant arrays, so its form is NO_FORM until a GUI registers its own (GuiPlugin.forms, keyed billing.generate-bills) to replace the pre-flight panel; parity.test.ts keeps an action without a form pending. The route answers 200 with per-tenant errors[], which only such a form can show. Once one exists, the period review offers it as its header action and its empty state's call to action.",
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
      route: "/api/billing-line-items/[lineItemId]/regenerate",
      risk: "money",
      // A ceremony: a paid bill's regeneration is acknowledged, and this route
      // requires it; the legacy path, POST /api/billing/generate, does not.
      confirm: "ceremony",
      form: "RegenerateBillBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
    note: "On its own route: on /api/billing/generate a per-bill action could carry only { billingPeriodId }, since GenerateBillsBody is refined (a tenant prefill is dropped), the kit cannot render its arrays and available() cannot target a bill, so Regenerate would run the whole period. There is no preview: the legacy paid-bill preview (POST /api/billing/regenerate-preview) re-pins a draft period's tariff, which a prepare must not do, so prepare shows the current total, the legacy paid-bill warning as an acknowledgement the regenerate route requires (the legacy dialogs' generate path keeps it as a client-side warning only: /api/billing/generate checks no payment status); the route answers with the previous and new totals, which the host shows as the result. Unlike the legacy menu, which offers regenerating a bill in a closed period (\"Logged as audit revision\") and an invoiced bill through /api/billing/generate, the route refuses both, as it refuses a refunded bill (REGENERATE_REFUSAL_COPY), and the review shows the action disabled with that reason; correcting a closed or invoiced bill once the legacy screens are deleted is left to a later decision. A read that recomputes without writing is a follow-up. Regenerate selected is one regenerate-bill per selected row, or generate-bills with tenantIds through a GUI's own form.",
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
    note: "Offered only where the usage route accepts it: a draft, an unmetered bill with no meter assigned in the period, and a starting reading. The legacy Switch to manual entry, which makes a metered draft row's cells editable and then gets 409 device_linked, maps to regenerate-bill in manual mode.",
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
      // One click in legacy; here a confirmation step like its siblings,
      // since every action on the shared payment-status route confirms.
      confirm: "confirm",
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
      via: { link: "billing.download-bill" },
    },
    pr: REVIEW,
    note: "The GET allocates an invoice number on a bill's first download (the pdf route), so this link writes once, as the legacy menu's download does.",
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
      via: { link: "billing.export-csv" },
    },
    pr: REVIEW,
  },
  {
    id: "view-history",
    screen: "period-review",
    control: "View history in the period header; row menu View history (filtered to the tenant)",
    legacy: "src/components/BillingTable.tsx, src/components/billing/row-actions-menu.tsx",
    replacedBy: { kind: "link", view: "billing.period-review", href: "/microgrids/[id]/billing/[periodId]/history", via: { link: "billing.view-history" } },
    pr: REVIEW,
  },
  {
    id: "view-tenant",
    screen: "period-review",
    control: "Row menu View tenant",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: { kind: "link", view: "billing.period-review", href: "/microgrids/[id]/setup/tenants/[tenantId]", via: "entity" },
    pr: REVIEW,
    note: "Carried as each row's tenant EntityRef (the tenant cell and row.related), with the href the host gives a tenant, not as a LinkRef: the page is community management's, and a view may link only to its own plugin's pages (gui-surface.test.ts check 7).",
  },
  {
    id: "payment-setup",
    screen: "period-review",
    control: "Go to Payment tab, in the banner shown when online payments are not set up",
    legacy: "src/components/BillingTable.tsx",
    replacedBy: { kind: "link", view: "billing.send-queue", href: "/communities/[id]/payment" },
    pr: SEND,
    note: "Moved to the send queue, which contributes payment links: the banner explains why none can be made. A billing loader can neither set a notice (host-filled) nor link to payments' page (check 7), so it needs payments' own contribution, such as a super-admin nav entry or the reason payment-link's available() gives.",
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
    note: "Copies the figures from the billing.period-review@1 ext: kWh to 3 dp as the CSV export writes it, and money in the currency's minor unit, which matches the CSV (csv-export.ts rounds every amount to a whole number) only for a currency with none, such as UGX; if the CSV's rounding changes, revisit. A bill's readings and usage are shown to 3 dp, as legacy shows them (`digits` on Fmt.energy); the totals to 1 dp, as legacy's grand total row.",
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
    replacedBy: { kind: "link", view: "billing.period-history", href: "/microgrids/[id]/billing/[periodId]", via: { link: "billing.back-to-period" } },
    pr: HISTORY,
    note: "The host's trail also links the period; it does not count.",
  },
  {
    id: "history-show-all",
    screen: "period-history",
    control: "Show all, when the history is filtered to one tenant",
    legacy: "src/app/(gui)/microgrids/[id]/billing/[periodId]/history/page.tsx",
    replacedBy: { kind: "link", view: "billing.period-history", href: "/microgrids/[id]/billing/[periodId]/history", via: { link: "billing.history-show-all" } },
    pr: HISTORY,
    note: "Offered while the view is filtered by tenant_id. Latest changes (billing.history-latest), on a later page, has the same path and does not count.",
  },
];
