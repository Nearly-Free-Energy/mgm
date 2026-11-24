import "server-only";

/**
 * What billing contributes to GUIs (src/lib/gui/surface.ts): navigation,
 * with the labels the current chrome uses, to its billing periods view and
 * to its pages served outside the GUI contract (`legacy: true`); a
 * microgrid's billing periods as the `billing.periods` view, with creating
 * a period and deleting a draft; one period's bills as the
 * `billing.period-review` view, with generating its bills from meter data
 * and the actions on each bill; one period's audit history as the
 * `billing.period-history` view, reached from the review's View history
 * links; a draft period's close checklist as the `billing.close-checklist`
 * view, reached from the review's Close period link, with the close itself
 * (`billing.close-period`, the server's close ceremony); a period's bills
 * with each one's stable payment link, for the manager to copy and share
 * (the page sends nothing), as the
 * `billing.send-queue` view, reached from the review's Payment links link;
 * the tenants with no bill for a period, and why, as the
 * `billing.not-billed` view, a section of the review, with billing each of
 * them from readings typed by hand (`billing.bill-from-readings`); and the
 * savings as the `billing.savings` view, shown under the Operations day,
 * with the writes that change what it counts; and each microgrid's newest
 * period as the `billing.current-periods` view, a tile on Today (org.today)
 * and a page of its own at /billing, which the catalog serves by the view
 * (`servedBy: "view"`). A page that moves to a view
 * keeps its nav id. The watcher, `billing.period-due`, reports each draft
 * period whose last day has passed, leading to its close checklist, or to
 * its review while it has no bills.
 *
 * `billing.periods`, `billing.period-review` and `billing.period-history`
 * have the Billing pages' own paths. The catalog serves all three paths by
 * their views (`servedBy: "view"`), so the host's catch-all renders them,
 * and the Billing nav entry opens `billing.periods`. The review took its
 * URL from the legacy page once no period-review row of
 * src/lib/billing/parity.ts was pending; parity.test.ts would have kept it
 * there otherwise.
 * `billing.close-checklist`, `billing.send-queue` and `billing.not-billed`
 * are new pages (…/[periodId]/close, …/[periodId]/send and
 * …/[periodId]/not-billed) with no page.tsx, so the catalog marks them
 * `servedBy: "view"` and the host's catch-all serves them.
 */
import type { ActionDef, Contribution } from "@/lib/gui/surface";
import { BILLING_PLUGIN_NAME } from "@/lib/plugins/bundled";
import {
  ADD_GRID_TARIFF_BODY_VERSION,
  AddGridTariffBody,
  BILL_FROM_READINGS_BODY_VERSION,
  BillFromReadingsBody,
  CLOSE_PERIOD_BODY_VERSION,
  ClosePeriodBody,
  CREATE_PERIOD_BODY_VERSION,
  CreatePeriodBody,
  DELETE_PERIOD_BODY_VERSION,
  DeletePeriodBody,
  GENERATE_FROM_METERS_BODY_VERSION,
  GenerateFromMetersBody,
  LINE_ITEM_PAYMENT_STATUS_BODY_VERSION,
  LINE_ITEM_USAGE_BODY_VERSION,
  LineItemPaymentStatusBody,
  LineItemUsageBody,
  REGENERATE_BILL_BODY_VERSION,
  RegenerateBillBody,
  SAVE_SAVINGS_SETTINGS_BODY_VERSION,
  SaveSavingsSettingsBody,
} from "./schemas";
import { closePeriodAvailable, loadCloseChecklist, prepareClosePeriod } from "./surface/close-checklist";
import { loadCurrentPeriods } from "./surface/current-periods";
import { CURRENT_PERIODS_EXAMPLES } from "./surface/current-periods-examples";
import { CURRENT_PERIODS_KEYS, CURRENT_PERIODS_VIEW } from "./surface/current-periods-model";
import { CLOSE_CHECKLIST_EXAMPLES } from "./surface/close-checklist-examples";
import { CLOSE_CHECKLIST_STEPS, CLOSE_PERIOD_ACTION } from "./surface/close-checklist-model";
import { SAVINGS_EXAMPLES } from "./surface/examples";
import {
  generateFromMetersAvailable,
  loadPeriodReview,
  prepareCancelPaymentLink,
  prepareGenerateFromMeters,
  prepareMarkFailed,
  prepareMarkPaid,
  prepareMarkRefunded,
  prepareMarkUnpaid,
  prepareRegenerateBill,
  prepareRecordUsage,
  recordUsageAvailable,
  regenerateBillAvailable,
} from "./surface/period-review";
import { billFromReadingsAvailable, loadNotBilled, prepareBillFromReadings } from "./surface/not-billed";
import { NOT_BILLED_EXAMPLES } from "./surface/not-billed-examples";
import { BILL_FROM_READINGS_ACTION, NOT_BILLED_KEYS, NOT_BILLED_VIEW } from "./surface/not-billed-model";
import { loadPeriodDue } from "./surface/period-due";
import { PERIOD_DUE_EXAMPLES } from "./surface/period-due-examples";
import { PERIOD_DUE_SIGNAL } from "./surface/period-due-model";
import { loadPeriodHistory } from "./surface/period-history";
import { PERIOD_HISTORY_EXAMPLES } from "./surface/period-history-examples";
import { PERIOD_HISTORY_KEYS } from "./surface/period-history-model";
import { PERIOD_REVIEW_EXAMPLES } from "./surface/period-review-examples";
import { PeriodReviewExt } from "./surface/period-review-ext";
import { loadSendQueue } from "./surface/send-queue";
import { SEND_QUEUE_EXAMPLES } from "./surface/send-queue-examples";
import { SendQueueExt } from "./surface/send-queue-ext";
import { SEND_QUEUE_EXT_SCHEMA, SEND_QUEUE_KEYS } from "./surface/send-queue-model";
import {
  CANCEL_PAYMENT_LINK_ACTION,
  GENERATE_FROM_METERS_ACTION,
  MARK_FAILED_ACTION,
  MARK_PAID_ACTION,
  MARK_REFUNDED_ACTION,
  MARK_UNPAID_ACTION,
  PERIOD_REVIEW_EXT_SCHEMA,
  PERIOD_REVIEW_KEYS,
  PERIOD_REVIEW_PREFIXES,
  RECORD_USAGE_ACTION,
  REGENERATE_BILL_ACTION,
} from "./surface/period-review-model";
import { deletePeriodAvailable, loadPeriods, prepareDeletePeriod } from "./surface/periods";
import { PERIODS_EXAMPLES } from "./surface/periods-examples";
import { CREATE_PERIOD_ACTION, DELETE_PERIOD_ACTION, PERIODS_KEYS } from "./surface/periods-model";
import { loadSavings } from "./surface/savings";
import { SavingsExt } from "./surface/savings-ext";
import { GRID_TARIFF_ADD_ACTION, SAVINGS_EXT_SCHEMA, SAVINGS_KEYS, SAVINGS_SETTINGS_ACTION } from "./surface/savings-model";

export const BILLING_SURFACE: Contribution = {
  plugin: BILLING_PLUGIN_NAME,
  nav: [
    // Opens the billing.periods view, which serves the Billing pages' own path.
    {
      id: "billing.periods",
      title: "Billing",
      icon: "billing",
      group: "money",
      order: 10,
      view: "billing.periods",
    },
    {
      id: "billing.tariff",
      title: "Rate Schedule",
      icon: "tariff",
      group: "configure",
      order: 10,
      href: "/microgrids/[id]/setup/rates",
      needs: ["microgrid"],
      legacy: true,
    },
    {
      id: "billing.invoice-branding",
      title: "Invoice branding",
      icon: "branding",
      group: "configure",
      order: 30,
      href: "/communities/[id]/invoice",
      needs: ["community"],
      legacy: true,
    },
  ],
  views: [
    {
      id: "billing.periods",
      kind: "collection",
      path: "/microgrids/[id]/billing",
      params: { id: "microgrid" },
      entity: "id",
      // Read through the person's own client; still loads while billing is
      // off, with the gate's notice and create disabled.
      cost: "db",
      declares: { keys: PERIODS_KEYS },
      examples: PERIODS_EXAMPLES,
      load: loadPeriods,
    },
    {
      id: "billing.period-review",
      kind: "collection",
      path: "/microgrids/[id]/billing/[periodId]",
      params: { id: "microgrid", periodId: "billingPeriod" },
      entity: "periodId",
      // Read through the person's own client; still loads while billing is
      // off, with the gate's notice and every action disabled. The refresh
      // replaces the legacy page's 30-second paid-bill poll (parity.ts).
      cost: "db",
      live: { refreshSeconds: 30, staleAfterSeconds: 120 },
      declares: { keys: PERIOD_REVIEW_KEYS, prefixes: PERIOD_REVIEW_PREFIXES },
      // The figures a person copies, as plain numbers, for a GUI that
      // draws the bills as a copy table (Gridtop's, in
      // src/gui/gridtop/renderers/period-review).
      ext: { schema: PERIOD_REVIEW_EXT_SCHEMA, zod: PeriodReviewExt },
      examples: PERIOD_REVIEW_EXAMPLES,
      load: loadPeriodReview,
    },
    {
      id: NOT_BILLED_VIEW,
      kind: "collection",
      path: "/microgrids/[id]/billing/[periodId]/not-billed",
      params: { id: "microgrid", periodId: "billingPeriod" },
      // No `entity`: its rows are tenants, and with the period as its entity
      // the host would append other plugins' targeted actions on a period.
      // A section of the period review, under its bills, where the legacy
      // page's banner of tenants not billed sat (#293); a section, not a
      // tab, so the review lists it while billing is off, with the gate's
      // notice (attachedViews in src/lib/gui/host/server/view.ts keeps a
      // disabled plugin's sections and drops its tabs; if that changes,
      // revisit).
      attach: { to: { view: "billing.period-review" }, order: 10, hint: "section" },
      // No `agent`: it names tenants, and no assistant reads billing views.
      // Read through the person's own client (./surface/not-billed.ts); loads
      // while billing is off, with the gate's notice and Bill from readings
      // disabled. No refresh of its own: the review's reloads its sections
      // (Gridtop's section list, src/gui/gridtop/shell/section-list.tsx,
      // loads a section again whenever the page's model is a new one; if it
      // stops, or another GUI draws sections without doing so, revisit).
      cost: "db",
      declares: { keys: NOT_BILLED_KEYS },
      examples: NOT_BILLED_EXAMPLES,
      load: loadNotBilled,
    },
    {
      id: "billing.period-history",
      kind: "collection",
      path: "/microgrids/[id]/billing/[periodId]/history",
      params: { id: "microgrid", periodId: "billingPeriod" },
      entity: "periodId",
      // The tenant the period review's row links filter to, and the page's
      // cursor (HISTORY_TENANT_PARAM and HISTORY_CURSOR_PARAM in
      // ./surface/period-history-model.ts).
      query: ["tenant_id", "before"],
      // Read through the person's own client; still loads while billing is
      // off, with the gate's notice. No actions and no refresh: a log only
      // grows, and the newest entries are a link away.
      cost: "db",
      declares: { keys: PERIOD_HISTORY_KEYS },
      examples: PERIOD_HISTORY_EXAMPLES,
      load: loadPeriodHistory,
    },
    {
      id: "billing.close-checklist",
      kind: "flow",
      path: "/microgrids/[id]/billing/[periodId]/close",
      params: { id: "microgrid", periodId: "billingPeriod" },
      entity: "periodId",
      // Read through the person's own client; still loads while billing is
      // off, with the gate's notice and Close disabled. No refresh: the
      // close's own confirmation reads the totals again.
      cost: "db",
      // The step ids. keysOf (src/lib/gui/host/server/contribution-schema.ts)
      // checks no flow body today; if it comes to, these are what it finds.
      declares: { keys: CLOSE_CHECKLIST_STEPS },
      examples: CLOSE_CHECKLIST_EXAMPLES,
      load: loadCloseChecklist,
    },
    {
      id: "billing.send-queue",
      kind: "collection",
      path: "/microgrids/[id]/billing/[periodId]/send",
      params: { id: "microgrid", periodId: "billingPeriod" },
      entity: "periodId",
      // No `agent`: never read by an assistant. Each link lets whoever holds
      // it start a checkout for the bill, since the line-item id is the
      // link's only access token (src/app/api/billing-line-items/[lineItemId]/pay/route.ts);
      // if links stop being bearer links, revisit.
      // Read through the person's own client, with the community's payment
      // readiness from the Payments capability (./surface/send-queue.ts);
      // still loads while billing is off, with the gate's notice. The
      // refresh replaces the legacy page's 30-second paid-bill poll here too.
      // No actions: handing out a stable link writes nothing, so there is
      // nothing to generate (parity.ts, payment-link).
      cost: "db",
      live: { refreshSeconds: 30, staleAfterSeconds: 120 },
      declares: { keys: SEND_QUEUE_KEYS },
      // Each bill's link again, the readiness note in full and the line
      // saying nothing is sent from the page, for a GUI that offers the link
      // to copy (Gridtop's, in
      // src/gui/gridtop/renderers/send-queue).
      ext: { schema: SEND_QUEUE_EXT_SCHEMA, zod: SendQueueExt },
      examples: SEND_QUEUE_EXAMPLES,
      load: loadSendQueue,
    },
    {
      id: "billing.savings",
      kind: "metrics",
      path: "/microgrids/[id]/operations/savings",
      params: { id: "microgrid" },
      entity: "id",
      // The day the Operations view shows, which the host passes on.
      query: ["date"],
      attach: { to: { view: "metering.site-day" }, order: 20, hint: "section" },
      // Reads up to a year of days from OpenEMS: refused while billing is
      // off, and never polled.
      cost: "vendor",
      declares: { keys: SAVINGS_KEYS },
      ext: { schema: SAVINGS_EXT_SCHEMA, zod: SavingsExt },
      examples: SAVINGS_EXAMPLES,
      load: loadSavings,
    },
    {
      id: CURRENT_PERIODS_VIEW,
      kind: "collection",
      path: "/billing",
      params: {},
      // A tile on Today: the host lists it with ?org= set to Today's
      // organization (attachedViews in src/lib/gui/host/server/view.ts) and
      // leaves it out while billing is off for it. No `agent`.
      attach: { to: { view: "org.today" }, order: 10, hint: "tile" },
      // Read through the person's own client (./surface/current-periods.ts);
      // on its own page it loads while billing is off, with the gate's notice.
      cost: "db",
      declares: { keys: CURRENT_PERIODS_KEYS },
      examples: CURRENT_PERIODS_EXAMPLES,
      load: loadCurrentPeriods,
    },
  ],
  // Both human-only: no assistant proposes them (decision 6 on #115).
  // Deleting a tariff version is not contributed (decision 6): it stays on
  // the Rates page. A DELETE would need typed or ceremony confirmation and a
  // prepare step.
  // Both `targeted: false`: offered only by the savings view, whose loader
  // prefills them with the stored settings and the newest tariff's bands
  // (savingsActions in ./surface/savings-model.ts). Appended to another
  // plugin's view of the microgrid they would open empty, and the settings
  // PUT replaces the whole row, so saving would clear both stored dates. If
  // the host's prepare comes to supply starting values, or the route stops
  // replacing the row, revisit.
  actions: [
    // Human-only, as no assistant proposes a period yet (#201).
    // `targeted: false`: offered only by billing.periods, which the host now
    // serves at the Billing path. Appended to another plugin's view of the
    // microgrid (metering.site-day) it would open an empty date form there
    // (the starting dates are billing.periods' own prefill, which an
    // appended action does not carry), away from the periods it adds to. If
    // the host's prepare comes to supply starting dates, revisit.
    {
      ...CREATE_PERIOD_ACTION,
      target: "microgrid",
      input: CreatePeriodBody,
      inputVersion: CREATE_PERIOD_BODY_VERSION,
      method: "POST",
      path: "/api/billing-periods",
      bind: { body: { microgrid_id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    },
    // A DELETE: typed confirmation, the period's name, from prepare.
    {
      ...DELETE_PERIOD_ACTION,
      target: "billingPeriod",
      input: DeletePeriodBody,
      inputVersion: DELETE_PERIOD_BODY_VERSION,
      method: "DELETE",
      path: "/api/billing-periods/[periodId]",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "destructive",
      confirm: "typed",
      humanOnly: true,
      prepare: prepareDeletePeriod,
      available: deletePeriodAvailable,
    },
    // Closing a period, against the totals the person reviewed (#201). A
    // ceremony: prepare returns the close route's own ceremony
    // (closeCeremony over fn_billing_period_close_review), so the totals,
    // warnings, acknowledgements, typed name and digest are the server's,
    // and the route checks them again. The host sends the confirmation in
    // ClosePeriodBody's `confirmation`, which no form shows.
    // `targeted: false`: offered only on the close checklist's last step,
    // after the steps that explain its warnings. Appended to another
    // plugin's view of a period (payments.bill-attempts, say) it would offer
    // Close out of that context; serving the billing pages through the host
    // does not change that. If the checklist's explanations move into the
    // ceremony itself, revisit.
    {
      ...CLOSE_PERIOD_ACTION,
      target: "billingPeriod",
      input: ClosePeriodBody,
      inputVersion: CLOSE_PERIOD_BODY_VERSION,
      method: "POST",
      path: "/api/billing-periods/[periodId]/close",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "money",
      confirm: "ceremony",
      humanOnly: true,
      targeted: false,
      prepare: prepareClosePeriod,
      available: closePeriodAvailable,
      // The route's 409 for a digest that no longer matches the totals
      // (totalsChanged in ./capability.ts): the host prepares the close
      // again and shows the new totals, with CLOSE_REFUSAL_COPY.totalsChanged
      // as its note. If the route renames the code, change it here.
      prepareAgainOn: ["billing_period_totals_changed"],
    },
    // ── The period review's actions ──
    // All human-only (no assistant proposes a billing write yet) and money:
    // each changes what a tenant is billed or what they owe.
    //
    // Generating a draft period's bills from meter data, on a route of its
    // own whose body is only the bound period, so the kit submits it with
    // no form. The period review offers it as its header action and as its
    // empty state's call to action. Readings typed by hand are not part of
    // it: a bill's are entered with regenerate-bill (manual) or record-usage
    // below, and a tenant with no meter data gets no bill, whom
    // bill-from-readings below bills (parity.ts, generate-bills and
    // bill-from-readings). Confirm, not ceremony: there
    // is nothing to acknowledge, since the run leaves manual, invoiced, paid
    // and refunded bills as they are; prepare says how many tenants it reads
    // and who has no meter. `targeted: false`: appended to another view of a
    // period (the history, the close checklist, the send queue, a payments
    // view) it would generate away from the bills it changes, and only the
    // review shows the result once it refreshes.
    // The full-body billing.generate-bills (GenerateBillsBody on POST
    // /api/billing/generate) is no longer contributed: no interface could
    // submit it, and that route regenerated closed periods' and paid or
    // invoiced bills, which the review refuses bill by bill. The route went
    // with the legacy pre-flight panel (#201's Deletes).
    {
      ...GENERATE_FROM_METERS_ACTION,
      target: "billingPeriod",
      input: GenerateFromMetersBody,
      inputVersion: GENERATE_FROM_METERS_BODY_VERSION,
      method: "POST",
      path: "/api/billing-periods/[periodId]/generate-from-meters",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
      prepare: prepareGenerateFromMeters,
      available: generateFromMetersAvailable,
    },
    // A first bill for one tenant with no bill, from readings typed by hand,
    // on a route of its own whose path names the period and the tenant, so
    // the body is only what a person types (BillFromReadingsBody). Offered
    // on each row of billing.not-billed while the period is a draft; a
    // tenant who has a bill is refused (regenerate-bill changes that bill).
    // Target billingPeriod, so available() can say whether the period is a
    // draft; which tenants have no bill is the loader's to say, and
    // prepare's and the route's to check again. Confirm, not ceremony:
    // nothing to acknowledge, and prepare cannot show the total, as it runs
    // once before the form (src/lib/gui/host/client/action-host.tsx; if the
    // host comes to prepare again with the form's values, revisit); it
    // names the tenant, the period and the meter, and warns for a metered
    // tenant. `targeted: false`: appended to
    // another view of a period it could not bind the tenant.
    {
      ...BILL_FROM_READINGS_ACTION,
      target: "billingPeriod",
      input: BillFromReadingsBody,
      inputVersion: BILL_FROM_READINGS_BODY_VERSION,
      method: "POST",
      path: "/api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings",
      bind: { path: { periodId: "billingPeriod", tenantId: "tenant" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
      prepare: prepareBillFromReadings,
      available: billFromReadingsAvailable,
    },
    // One bill, from the meter or from readings entered, on its own route so
    // it can never become a whole-period run. Targeted: its form needs only
    // the readings choice, and available() and prepare check the bill, so it
    // is sound on any view of a bill. A ceremony, so the host sends the
    // acknowledgement a paid bill's prepare asks for and the route requires
    // (only typed and ceremony actions are sent a confirmation, invoke.ts).
    // Its tone is neutral, as it is neither a DELETE nor destructive; if
    // actionTone (merge-actions.ts) or this action's risk or method changes,
    // revisit.
    {
      ...REGENERATE_BILL_ACTION,
      target: "lineItem",
      input: RegenerateBillBody,
      inputVersion: REGENERATE_BILL_BODY_VERSION,
      method: "POST",
      path: "/api/billing-line-items/[lineItemId]/regenerate",
      bind: { path: { lineItemId: "lineItem" } },
      risk: "money",
      confirm: "ceremony",
      humanOnly: true,
      prepare: prepareRegenerateBill,
      available: regenerateBillAvailable,
    },
    // A usage correction on an unmetered draft bill: a per-bill
    // regeneration from manual readings (#247). `targeted: false`: the
    // review offers it only on the bills the usage route accepts. A
    // ceremony, as regenerate-bill is, so the host sends the acknowledgement
    // a paid bill's prepare asks for and the route requires (only typed and
    // ceremony actions are sent a confirmation, invoke.ts); its tone is
    // neutral for the same reasons as regenerate-bill's.
    {
      ...RECORD_USAGE_ACTION,
      target: "lineItem",
      input: LineItemUsageBody,
      inputVersion: LINE_ITEM_USAGE_BODY_VERSION,
      method: "PATCH",
      path: "/api/billing-line-items/[lineItemId]/usage",
      bind: { path: { lineItemId: "lineItem" } },
      risk: "money",
      confirm: "ceremony",
      humanOnly: true,
      targeted: false,
      prepare: prepareRecordUsage,
      available: recordUsageAvailable,
    },
    // The payment-status transitions, all on one route. Each is offered only
    // where the loader links it, with the status it sets as its prefill, so
    // each is `targeted: false`: appended elsewhere it would open with no
    // status. The kit form does not lock that prefill, so a person can
    // submit another status; the route's transition and super-admin checks
    // stay the authority, and it refuses a refund without the tenant's name
    // typed, which only Mark as refunded (typed) sends: a confirm-level
    // action's form switched to refunded sends no confirmation (invoke.ts).
    // If Prepare comes to supply fixed values, revisit.
    // Every one of them has a confirmation step, Mark as unpaid included.
    // No available(): the loader already offers each by the bill's status
    // and the person's role, and prepare checks both again.
    ...(
      [
        [MARK_PAID_ACTION, "confirm", prepareMarkPaid],
        [MARK_UNPAID_ACTION, "confirm", prepareMarkUnpaid],
        // Typed: a refund is final (review on #205).
        [MARK_REFUNDED_ACTION, "typed", prepareMarkRefunded],
        [MARK_FAILED_ACTION, "confirm", prepareMarkFailed],
        [CANCEL_PAYMENT_LINK_ACTION, "confirm", prepareCancelPaymentLink],
      ] as const
    ).map(
      ([action, confirm, prepare]): ActionDef => ({
        ...action,
        target: "lineItem",
        input: LineItemPaymentStatusBody,
        inputVersion: LINE_ITEM_PAYMENT_STATUS_BODY_VERSION,
        method: "PATCH",
        path: "/api/billing-line-items/[lineItemId]/payment-status",
        bind: { path: { lineItemId: "lineItem" } },
        risk: "money",
        confirm,
        humanOnly: true,
        targeted: false,
        prepare,
      }),
    ),
    {
      ...SAVINGS_SETTINGS_ACTION,
      target: "microgrid",
      input: SaveSavingsSettingsBody,
      inputVersion: SAVE_SAVINGS_SETTINGS_BODY_VERSION,
      method: "PUT",
      path: "/api/microgrids/[id]/savings-settings",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    },
    {
      ...GRID_TARIFF_ADD_ACTION,
      target: "microgrid",
      input: AddGridTariffBody,
      inputVersion: ADD_GRID_TARIFF_BODY_VERSION,
      method: "POST",
      path: "/api/microgrids/[id]/grid-tariffs",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
    },
  ],
  signals: [{ id: PERIOD_DUE_SIGNAL, load: loadPeriodDue, examples: PERIOD_DUE_EXAMPLES }],
};
