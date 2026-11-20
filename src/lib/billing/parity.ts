/**
 * The billing parity table (#201): every control on today's legacy billing
 * period screens, and the contributed action or view link that replaces it.
 *
 * The legacy screens are the periods list (BillingPeriodList.tsx), the
 * period review (BillingTable.tsx and the menus, panels and dialogs it
 * renders) and the period history page, under
 * src/app/(gui)/microgrids/[id]/billing/. A screen's URL moves to the GUI
 * host only once none of its rows is pending, and the legacy components are
 * deleted only once no row is; parity.test.ts enforces both, and fails
 * while a row has no contribution and is not listed as pending there, so a
 * control cannot be lost on the way. Since "Serve the billing pages through
 * the GUI host" the host serves the periods list and the history, and
 * since "Serve period review through the GUI host" the review too (their
 * page.tsx files are gone); BillingPeriodList, AuditLogList and
 * BillingTable stay until the Deletes pull request.
 *
 * Out of the table, on purpose:
 *  - The rest of the microgrid layout's chrome on these pages (the
 *    Operations and Setup tabs, the breadcrumb, Edit microgrid and the
 *    timezone nudge): it belongs to the microgrid pages. The host serves
 *    every billing screen outside that layout, so they show the GUI's own
 *    dock and trail instead; the chrome stays on Setup. The Billing tab is
 *    billing's sub-navigation, which
 *    #201's Deletes item removes, so it is a row (billing-tab).
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
   * Added to #201 by the maintainer's decision on generating bills through
   * the GUI host: a narrow action on a route of its own whose body is only
   * the bound period, with manual readings left to the per-bill actions.
   */
  | "Generate a period's bills from meter data"
  /**
   * Added to #201 by the maintainer's decision on billing tenants with no
   * bill: a per-tenant action on a route of its own, offered from a section
   * of the period review listing the tenants not billed.
   */
  | "Bill a tenant with no bill from readings typed by hand"
  /**
   * Added to #201 by the maintainer's decision on payments-while-off: a GUI
   * host rule (whilePluginOff in src/lib/gui/surface.ts) that keeps a bill's
   * Payments tab and the actions whose routes accept them while Payments is
   * off available then.
   */
  | "Keep a bill's payments available while Payments is off"
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
   * The schema in the plugin's schemas module (src/lib/<plugin>/schemas.ts)
   * the route parses its body with, or null when the route has no JSON body
   * today; a route must parse a schema before its action can be contributed
   * (gui-surface.test.ts check 2).
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
  /**
   * Where it is today: the legacy components that draw it, which exist until
   * the Deletes pull request (parity.test.ts). A control that was on a
   * page.tsx the GUI host has replaced names the screen's remaining legacy
   * component, and says so.
   */
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
const FROM_METERS = "Generate a period's bills from meter data";
const FROM_READINGS = "Bill a tenant with no bill from readings typed by hand";
const WHILE_OFF = "Keep a bill's payments available while Payments is off";

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
    note: "The legacy screens delete through the same route, with the period's name typed in their confirm dialog, so they follow the plugin gate and give the capability's refusals in its fixed copy. The route deletes through fn_delete_draft_billing_period (migration 20261120130000) with the person's own client. Signed-in users hold no DELETE on billing_periods, and the function asks the billing plugin's gate itself, so a call that skips the route is refused while billing is off too.",
  },

  {
    id: "billing-tab",
    screen: "periods",
    control: "The Billing tab in the microgrid's tabs",
    legacy: "src/app/(gui)/microgrids/[id]/tab-nav.tsx",
    replacedBy: { kind: "nav", nav: "billing.periods" },
    pr: SERVE,
    note: "The nav entry opens the billing.periods view, which the host serves at the Billing tab's own path, so the tab lands on it too.",
  },

  // ── Period review ─────────────────────────────────────────────────────────
  {
    id: "generate-bills",
    screen: "period-review",
    control:
      "Generate (N tenants) and Refresh Readings in the pre-flight panel, for the tenants read from meters (the panel's Ready rows, and kept manual bills)",
    legacy: "src/components/billing/preflight-panel.tsx, src/components/BillingTable.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.generate-from-meters",
      target: "billingPeriod",
      method: "POST",
      route: "/api/billing-periods/[periodId]/generate-from-meters",
      risk: "money",
      confirm: "confirm",
      form: "GenerateFromMetersBody",
      view: "billing.period-review",
    },
    pr: FROM_METERS,
    note: "Meter data only, on a route of its own whose body is only the bound period, so the kit submits it with no form; the period review offers it as its header action (Generate bills from meter data before the first bill, Refresh readings from meters after) and as a draft's empty-state call to action. Differences from the panel: a closed period is refused; manual bills are kept as there; paid, invoiced and refunded bills are left as they are and their meters not read, where Refresh Readings rewrote them (regenerate-bill, with its acknowledgement, regenerates a paid bill); an existing bill is rewritten only if it is unchanged since the run read it (fn_regenerate_bill_with_audit), and one whose figures are already the meter's is not written, so a second run adds no audit rows. A bill with a pending payment link (link_generated) is rewritten, as Refresh Readings rewrote it, so its readings stay fresh: where its total changes, its Pesapal link is cleared (fn_record_line_item_with_audit) and an open checkout of it is set aside for reconciliation (fn_payment_bill_revision), so prepare counts those bills and warns of both, and the result says how many links stopped working. Prepare says how many tenants will be read from meters and how many bills are kept or left, and names the tenants whose meter cannot be read, by the reason the result gives (no meter, or a meter assignment gap): not billed if they have no bill, their bill left as it is if they have one; it cannot foresee a meter with no data. The result is counts in fixed copy (the host keeps only a message, of up to 300 characters, so past that it gives the not-billed and left counts as totals), never per-tenant errors; an existing bill whose meter could not be read counts as left as it was, not as not billed. Readings typed by hand for a tenant that has a bill come from regenerate-bill in manual mode, or record-usage on an unmetered draft bill with a starting reading; the panel's Override available toggle maps to regenerate-bill's Switch to manual entry after generating. The panel's starting-reading rows stay unreachable, as before (header). A tenant with no meter data gets no bill: billing.bill-from-readings bills them from readings typed by hand (bill-from-readings). The full-body billing.generate-bills on POST /api/billing/generate is no longer contributed; the route stays for the legacy panel. The run reads every page of the period's tenants and bills (and of the prior readings it starts meters from, in slices of the period and device lists, which travel in the read's URL), so a bill past PostgREST's max_rows is not taken for no bill; a read it cannot complete stops it with nothing written. It reads the period's status again after reading the meters and writes nothing if the period is no longer a draft. A tenant's first bill goes through fn_record_first_line_item_with_audit (migration 20261120130100), which inserts only while the period is a draft and the tenant has no bill, under the period's lock: a close committing after that second read refuses the insert, and a bill another write inserted for that tenant while the run read the meters (a manual reading on the legacy panel, a bill from readings (billing.bill-from-readings), or an overlapping run) is left as it is, counted as changed; neither is overwritten. The legacy panel's POST /api/billing/generate keeps upserting (fn_record_line_item_with_audit), overwriting a bill and accepting a closed period, until the legacy page is deleted.",
  },
  {
    id: "bill-from-readings",
    screen: "period-review",
    control:
      "The pre-flight panel's Needs manual entry rows (start and end readings for a tenant the meters cannot bill), and its result view's manual fallback after no_meter_reading or meter_assignment_continuity",
    legacy: "src/components/billing/preflight-panel.tsx",
    replacedBy: {
      kind: "action",
      plugin: "billing",
      action: "billing.bill-from-readings",
      target: "billingPeriod",
      method: "POST",
      route: "/api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings",
      risk: "money",
      confirm: "confirm",
      form: "BillFromReadingsBody",
      view: "billing.not-billed",
    },
    pr: FROM_READINGS,
    note: "Decided by the maintainer: after generating from meter data, a tenant with no meter for the period, an assignment gap, or no meter data has no bill, and regenerate-bill and record-usage both need one; writing a zero bill for them is not an option (#293, #339). billing.not-billed, a section of the period review titled Tenants not billed, lists every tenant of the microgrid with no bill for the period, before the first bill too, in name order, with why (meterCoverage's answer: no meter for the period, a meter assignment gap, or a meter with no bill from it yet, which a run from meter data reads but may find without data; in a closed period, which no run bills, a meter with no bill from it for the period), and offers Bill from readings on each while the period is a draft. Its form is the panel's row: start and end readings (end not below start, decimals kept to 3 places by the engine, no upper bound, as before) and an optional reason of up to 500 characters; its confirmation names the tenant, the period and what is known of the meter, and warns that a metered tenant's bill from readings is kept by later runs from meter data. Differences from the panel: one tenant per submit, on a route of its own through the same engine (POST /api/billing/generate's manual path, with the same tariff pin, rounding and audit row); a closed period is refused, and so is a tenant who already has a bill (regenerate-bill in manual mode changes it), where the panel's POST /api/billing/generate overwrote that bill and accepted a closed period; no seed readings, as before (header). The section also replaces the legacy page's banner of tenants not billed (BillingTable, #293), which named only tenants with no available meter, and only once the period had a bill; the banner shows information and is no control, so it has no row. The engine reads every page of the period's tenants and bills, so a bill past PostgREST's max_rows is not taken for no bill; a read it cannot complete stops it with nothing written. It reads the period's status again just before the insert and writes nothing if the period is no longer a draft. The bill's insert goes through fn_record_first_line_item_with_audit (migration 20261120130100), with the same columns, rounding and audit row as the panel's upsert, but only while the period is a draft and the tenant has no bill, under the period's lock: a close committing after that read refuses it (period_closed), and a bill another write inserted for that tenant after the engine read the period's bills (a run from meter data, the legacy panel, or a second submission of this action) is left as it is and the submission refused (has_bill).",
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
    note: "On its own route: on /api/billing/generate a per-bill action would carry its bill as a tenantIds prefill, which the kit cannot render (GenerateBillsBody's arrays), and available() cannot target a bill, so Regenerate would run the whole period. There is no preview: the legacy paid-bill preview (POST /api/billing/regenerate-preview) re-pins a draft period's tariff, which a prepare must not do, so prepare shows the current total, the legacy paid-bill warning as an acknowledgement the regenerate route requires (the legacy dialogs' generate path keeps it as a client-side warning only: /api/billing/generate checks no payment status); the route answers with the previous and new totals in its message, which the host passes on as the action's result and Gridtop's period review shows (a GUI that draws only failures does not). Unlike the legacy menu, which offers regenerating a bill in a closed period (\"Logged as audit revision\") and an invoiced bill through /api/billing/generate, the route refuses both, as it refuses a refunded bill (REGENERATE_REFUSAL_COPY), and the review shows the action disabled with that reason; correcting a closed or invoiced bill once the legacy screens are deleted is left to a later decision. A read that recomputes without writing is a follow-up. Regenerate selected is one regenerate-bill per selected row; a run over chosen tenants would need a contribution of its own, as generate-from-meters takes no tenants.",
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
    replacedBy: {
      kind: "link",
      view: "payments.payment-setup",
      href: "/communities/[id]/payment",
      via: { link: "payments.community-payment" },
    },
    pr: ATTEMPTS,
    note: "Decided in review of the send queue (#216) and built with a bill's payment attempts: payments contributes payments.payment-setup, a section of billing.send-queue showing the community's payment readiness, which carries the link to the community's Payment page. A section, not a tab, so the send queue lists it while Payments is off, with the gate's notice; its loader reads the community from the microgrid, since an attached view is given only its parent's path segments. As the legacy banner, it gives the link to a super admin and tells anyone else to ask one; turning payments on is advised to every role. The send queue keeps its own note, which explains why there are no links, without one.",
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
    note: "Offered on the close checklist's last step, which the period review's Close period link opens; prepare returns the route's own ceremony (closeCeremony), so the totals, warnings, acknowledgements, typed name and digest are the server's. Like the dialog, a 409 for totals that changed shows the new totals with a note (the action's prepareAgainOn), and the step is neutral. Differences from the legacy dialog: the host requires the typed name exactly, after trimming, where the route also ignores case and spacing; the GUI refuses a period with no bills or no pinned tariff, which the route would close; and Export CSV for URA is a link on the refreshed checklist once the period is closed, not a button in the dialog.",
  },
  {
    id: "payment-link",
    screen: "period-review",
    control: "Row menu Generate payment link and Regenerate payment link; a row banner's Retry after a failed link",
    legacy: "src/components/billing/row-actions-menu.tsx",
    replacedBy: { kind: "view", view: "billing.send-queue" },
    pr: SEND,
    note: "The send queue shows each bill's stable payment link, ready to copy, so Generate, Regenerate and Retry have nothing left to do. The url route has written nothing and called no provider since the stable link replaced per-checkout links (its UNGATED_WRITES entry in src/lib/runtime/__tests__/route-rules.ts says so), and an action result carries no URL a person could copy: invoke.ts keeps only a message and a same-site href, which the host opens, and opening …/pay starts a checkout. The queue offers a link only where checkout would accept it (no paid or refunded bill, no zero total, a tenant with an email or phone) and while readiness is ready or sandbox, as the legacy menu offered Generate only once payments were set up. If the link ever needs a write (a per-bill token, say), it becomes an action again. The url route's only caller is the legacy row menu; the Deletes pull request removes it, or keeps it, with its UNGATED_WRITES entry, its released route and its tests.",
  },
  {
    id: "payment-history",
    screen: "period-review",
    control: "Payment history on a row (opens the attempts dialog)",
    legacy: "src/components/payments/payment-history.tsx",
    replacedBy: { kind: "view", view: "payments.bill-attempts" },
    pr: ATTEMPTS,
    note: "The payments plugin's view of a bill's attempts (decided in review of #205), a tab of the period review titled Payments: it lists the period's bills, and ?bill=<id> shows one bill's attempts, receipts and balance (Bill, Received, Difference in the subtitle). There is no entry from a bill's row, one click more than the legacy row button: the contract attaches a view to a view, not to a row, and a billing row may not link a payments page (gui-surface.test.ts check 7). An attempt's failure message, which may hold a provider's raw response, becomes a fixed note from its failure code.",
  },
  {
    id: "payments-while-off",
    screen: "period-review",
    control: "Payment history, Refresh status and reconciliation while Payments is off (the row's dialog)",
    legacy: "src/components/payments/payment-history.tsx",
    replacedBy: { kind: "view", view: "payments.bill-attempts" },
    pr: WHILE_OFF,
    note: "Decided by the maintainer: keep the actions enabled. While Payments is off the period review still lists the Payments tab (attach.whilePluginOff: \"listed\"), which loads with the gate's notice, and Refresh status and both reconciliations stay enabled and preparable (whilePluginOff: \"enabled\" on payments.refresh-attempt, payments.record-adjustment and payments.accept-receipts), as the legacy dialog offers them, because their routes accept them then by design (their PaymentExemption entries in src/lib/runtime/__tests__/route-rules.ts; docs/payments-rollout.md keeps history and verification available). gui-surface.test.ts allows the action field only on a PaymentExemption route, and parity.test.ts keeps this row replaced only while the four declarations stand. Differences from the dialog: its own line that receipts remain available is replaced by the gate's notice, and Refresh status is offered only on attempts with a tracking id, as when Payments is on (refresh-attempt).",
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
      form: "RefreshAttemptBody",
      view: "payments.bill-attempts",
    },
    pr: ATTEMPTS,
    note: "Owned by the payments plugin; offered on its view of a bill's attempts, only on an attempt with a provider tracking id. The legacy dialog offered it on every attempt, and the capability refuses one without a tracking id (409, the unknown-outcome copy), which the view's row shows as its note instead.",
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
      form: "ReconcileAttemptBody",
      view: "payments.bill-attempts",
    },
    pr: ATTEMPTS,
    note: "Typed: it records an amount from outside MGM, possibly negative, and marks the bill paid. The person types the tenant's name, which the capability checks (428 without it or with another), so the legacy dialog asks for it too; prepare names the amount that settles the bill. The kit form shows the Resolution choice with its raw values, prefilled record_external. The route now refuses a reference over 200 characters or notes over 500 (ReconcileAttemptBody), where it used to cut notes to 500 and save them; the legacy dialog caps both inputs at those limits.",
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
      form: "ReconcileAttemptBody",
      view: "payments.bill-attempts",
    },
    pr: ATTEMPTS,
    note: "Offered on every attempt that needs reconciliation, unavailable with the reason when the received total is not exactly the bill, a checkout's outcome is unknown or receipts are in several currencies (available() mirrors fn_payment_reconcile). The kit form also shows the optional amount, reference and notes, prefilled accept_exact; the capability refuses an amount. The same reference and notes limits apply as to record-adjustment.",
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
    note: "Gridtop's renderer of the send queue (src/gui/gridtop/renderers/send-queue) draws Copy link on each bill that has a link, copying the ext's link; a GUI without that renderer shows the link cell as text a person can select.",
  },

  // ── Period history ────────────────────────────────────────────────────────
  {
    id: "back-to-period",
    screen: "period-history",
    control: "Back to period",
    // Back to period was on the history's page.tsx, which "Serve the billing
    // pages through the GUI host" deleted; AuditLogList is what remains of
    // that screen until the Deletes pull request.
    legacy: "src/components/billing/audit-log-list.tsx",
    replacedBy: { kind: "link", view: "billing.period-history", href: "/microgrids/[id]/billing/[periodId]", via: { link: "billing.back-to-period" } },
    pr: HISTORY,
    note: "The host's trail also links the period; it does not count.",
  },
  {
    id: "history-show-all",
    screen: "period-history",
    control: "Show all, when the history is filtered to one tenant",
    legacy: "src/components/billing/audit-log-list.tsx",
    replacedBy: { kind: "link", view: "billing.period-history", href: "/microgrids/[id]/billing/[periodId]/history", via: { link: "billing.history-show-all" } },
    pr: HISTORY,
    note: "Offered while the view is filtered by tenant_id. Latest changes (billing.history-latest), on a later page, has the same path and does not count.",
  },
];
