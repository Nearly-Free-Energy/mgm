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
 *  - The microgrid layout's chrome on these pages (the Operations, Billing
 *    and Setup tabs, the breadcrumb, Edit microgrid and the timezone nudge):
 *    it belongs to the microgrid pages and is not deleted with billing's.
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
  /** Nothing in #201 contributes it yet: it needs a decision before the deletes. */
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

export type ParityRow = {
  id: string;
  screen: ParityScreen;
  /** The control as labelled today; several controls doing one thing share a row. */
  control: string;
  /** Where it is today. */
  legacy: string;
  replacedBy: ParityAction | ParityLink;
  pr: ParityPullRequest;
  note?: string;
};

const PERIODS = "Contribute billing periods and period creation as a view";
const REVIEW = "Contribute period review, with targeted actions for each bill";
const HISTORY = "Contribute a period's history";
const CLOSE = "Contribute the close checklist on …/close";
const SEND = "Contribute the send queue on …/send";

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
      confirm: "typed",
      form: "DeletePeriodBody",
      view: "billing.periods",
    },
    pr: PERIODS,
    note: "The legacy screens still delete through PostgREST with the browser's own client, with no typed name and no plugin gate, until they are deleted.",
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
      confirm: "confirm",
      form: "GenerateBillsBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
    note: "Contributed with no prepare and no prefill (GenerateBillsBody is refined) and `targeted: false`. The kit cannot render its arrays, so its form is NO_FORM until a GUI registers its own (GuiPlugin.forms, keyed billing.generate-bills) to replace the pre-flight panel; the route answers 200 with per-tenant errors[], which only such a form can show.",
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
      confirm: "confirm",
      form: "RegenerateBillBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
    note:
      "On its own route: on /api/billing/generate a per-bill action could carry only { billingPeriodId }, since GenerateBillsBody is refined (a tenant prefill is dropped), the kit cannot render its arrays and available() cannot target a bill, so Regenerate would run the whole period. " +
      "There is no preview: the legacy paid-bill preview (POST /api/billing/regenerate-preview) re-pins a draft period's tariff, which a prepare must not do, so prepare shows the current total and the legacy warnings; a read that recomputes without writing is a follow-up. " +
      "Regenerate selected is one regenerate-bill per selected row, or generate-bills with tenantIds through a GUI's own form.",
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
      confirm: "confirm",
      form: "LineItemPaymentStatusBody",
      view: "billing.period-review",
    },
    pr: REVIEW,
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
      confirm: "none",
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
    replacedBy: { kind: "link", view: "billing.period-review", href: "/api/payments/attempts" },
    pr: "unscheduled",
    note: "Payments' attempts for a bill have no view yet, and no #201 pull request contributes one.",
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
      confirm: "none",
      form: null,
      view: "billing.period-review",
    },
    pr: "unscheduled",
    note: "Owned by the payments plugin; no #201 pull request contributes it.",
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
      confirm: "confirm",
      form: null,
      view: "billing.period-review",
    },
    pr: "unscheduled",
    note: "Owned by the payments plugin, whose route validates its body by hand; no #201 pull request contributes it.",
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
      confirm: "confirm",
      form: null,
      view: "billing.period-review",
    },
    pr: "unscheduled",
    note: "Owned by the payments plugin; no #201 pull request contributes it.",
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
