import "server-only";

/**
 * Examples of the `billing.period-history` view, so every GUI can be tested
 * against it: a period's whole history on one page, with every kind of
 * entry a period holds; the history filtered to one tenant; filtered to a
 * tenant this microgrid does not have; a period with no entries; a later
 * page, which leads back to the latest changes; the first page before it,
 * at a page size shrunk to five, with more to follow; and the first again
 * while billing is off, with the gate's notice. Built at import the way the
 * loader builds them.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";
import { buildPeriodHistoryModel, encodeCursor, mergePage, type PeriodHistoryInput } from "./period-history-model";
import { periodLabel } from "./period-label";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site", currency: "UGX" };
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled billing plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice. If the
 * gate's copy changes, so may this.
 */
const BILLING_DISABLED =
  "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const OCTOBER = { id: id(0xb1), start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala" };
const AKELLO = { id: id(0xc1), name: "Akello Grace" };
const BILL_AKELLO = id(0xd1);
const BILL_KATO = id(0xd3);
const MANAGER = id(0xf1);
const ADMIN = id(0xf2);

const entry = (n: number, o: Partial<BillingAuditLogEntry> & Pick<BillingAuditLogEntry, "eventType" | "createdAt">): BillingAuditLogEntry => ({
  id: `audit:${id(0x100 + n)}`,
  actorUserId: MANAGER,
  actorDisplayName: "Okello Daniel",
  billingLineItemId: null,
  tenantName: null,
  details: {},
  ...o,
});
const payment = (n: number, o: Partial<BillingAuditLogEntry> & Pick<BillingAuditLogEntry, "eventType" | "createdAt">) =>
  entry(n, { id: `payment_event:${id(0x200 + n)}`, ...o });

/** Every kind of entry a period's history holds, newest first. */
const FIRST_PAGE: BillingAuditLogEntry[] = [
  entry(9, {
    eventType: "tariff_reconciled",
    createdAt: "2026-11-12T09:30:00+00:00",
    actorUserId: ADMIN,
    actorDisplayName: "Nakato Ruth",
    details: { review_reference: "TR-2026-014" },
  }),
  // Seen by an organization manager, who may not see a super admin's name.
  entry(8, { eventType: "period_closed", createdAt: "2026-11-05T16:00:00+00:00", actorUserId: ADMIN, actorDisplayName: null }),
  payment(7, {
    eventType: "payment_status_changed",
    createdAt: "2026-11-04T10:15:00.25+00:00",
    billingLineItemId: BILL_AKELLO,
    tenantName: AKELLO.name,
    details: { from: "unpaid", to: "paid", source: "manual", notes: "Paid in cash at the site office." },
  }),
  payment(6, {
    eventType: "payment_link_generated",
    createdAt: "2026-11-03T08:00:00+00:00",
    actorUserId: null,
    actorDisplayName: null,
    billingLineItemId: BILL_KATO,
    tenantName: "Kato Joseph",
    details: { from: "unpaid", to: "link_generated", source: "generate_link" },
  }),
  payment(5, {
    eventType: "payment_status_changed",
    createdAt: "2026-11-02T12:00:00+00:00",
    billingLineItemId: BILL_KATO,
    tenantName: "Kato Joseph",
    details: { from: null, to: "unpaid", source: "manual" },
  }),
  // A bill regenerated after the period closed, from manual readings.
  entry(4, {
    eventType: "line_item_regenerated",
    createdAt: "2026-11-01T14:45:30.123456+00:00",
    billingLineItemId: BILL_AKELLO,
    tenantName: AKELLO.name,
    details: {
      tenant_name: AKELLO.name,
      previous_total_amount: 55875,
      new_total_amount: 24000,
      previous_reading_source: "edge",
      new_reading_source: "manual",
      manual_reason: "Meter replaced on 20 October; readings taken by hand.",
      period_was_closed: true,
    },
  }),
  // A bill whose line item was deleted later: its snapshot names the tenant.
  entry(3, {
    eventType: "line_item_generated",
    createdAt: "2026-10-31T21:00:00+00:00",
    details: { tenant_name: "Byaruhanga Peter", new_total_amount: 18000, new_reading_source: "manual", manual_reason: "Edge offline all month." },
  }),
  entry(2, {
    eventType: "line_item_generated",
    createdAt: "2026-10-31T21:00:00+00:00",
    billingLineItemId: BILL_AKELLO,
    tenantName: AKELLO.name,
    details: { tenant_name: AKELLO.name, previous_total_amount: null, new_total_amount: 55875, new_reading_source: "edge" },
  }),
  entry(1, { eventType: "billing_period_created", createdAt: "2026-10-01T06:00:00+00:00" }),
  entry(0, { eventType: "period_created", createdAt: "2026-10-01T06:00:00+00:00", actorUserId: null, actorDisplayName: null }),
];

const AKELLO_ONLY = FIRST_PAGE.filter((e) => e.billingLineItemId === BILL_AKELLO);
const keyOf = (e: BillingAuditLogEntry) => ({ source: e.id.startsWith("audit:") ? ("a" as const) : ("p" as const), id: e.id.slice(e.id.indexOf(":") + 1), at: e.createdAt });
const cursorAfter = (e: BillingAuditLogEntry) => encodeCursor(keyOf(e));

/**
 * The first page of the same history with a page of five rather than
 * PERIOD_HISTORY_PAGE, so a GUI meets a next link without two hundred rows
 * to draw (the view matrix draws every row); paged by mergePage as the
 * loader pages it, and followed by the later page below.
 */
const EXAMPLE_PAGE = 5;
const SHORT_PAGE = mergePage(
  FIRST_PAGE.map((e) => ({ ...keyOf(e), entry: e })),
  [],
  EXAMPLE_PAGE,
);

const base = (o: Partial<PeriodHistoryInput>): PeriodHistoryInput => ({
  microgrid: MICROGRID,
  period: OCTOBER,
  entries: [],
  filter: null,
  before: null,
  next: null,
  fmt,
  ...o,
});

/** The models as the loader returns them, before the host fills its fields. */
export const PERIOD_HISTORY_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  // A period's whole history, on one page: it ends with the period's creation.
  buildPeriodHistoryModel(base({ entries: FIRST_PAGE })),
  // Filtered to one tenant, as the period review's row links it.
  buildPeriodHistoryModel(base({ entries: AKELLO_ONLY, filter: { tenantId: AKELLO.id, tenantName: AKELLO.name, canMatch: true } })),
  // Filtered to a tenant this microgrid does not have.
  buildPeriodHistoryModel(base({ filter: { tenantId: id(0xc9), tenantName: null, canMatch: false } })),
  // A period with no entries yet.
  buildPeriodHistoryModel(base({})),
  // A later page.
  buildPeriodHistoryModel(base({ entries: FIRST_PAGE.slice(5), before: cursorAfter(FIRST_PAGE[4]) })),
  // A first page with more to follow, at the example's page size: the page before the later page above.
  buildPeriodHistoryModel(base({ entries: SHORT_PAGE.entries.map((e) => e.entry), next: SHORT_PAGE.next })),
];

/** A loaded model with the fields the host fills, as a GUI receives it; `disabled` as while billing is off. */
function asReceived(loaded: LoadedModel<"collection">, disabled = false): ModelOf<"collection"> {
  const { empty } = loaded.body;
  return {
    ...loaded,
    type: "view",
    view: "billing.period-history",
    kind: "collection",
    org: ORG,
    // As the host builds it from the path's microgrid and period (src/lib/gui/host/server/entities.ts).
    trail: [
      { label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` },
      { label: periodLabel(fmt, OCTOBER.start_date, OCTOBER.end_date), href: `/microgrids/${MICROGRID.id}/billing/${OCTOBER.id}` },
    ],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    body: {
      ...loaded.body,
      rows: loaded.body.rows.map((row) => ({ ...row, actions: [] })),
      empty: { title: empty.title, ...(empty.text ? { text: empty.text } : {}) },
    },
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const PERIOD_HISTORY_EXAMPLES: readonly ModelOf<"collection">[] = [
  ...PERIOD_HISTORY_LOADED_EXAMPLES.map((loaded) => asReceived(loaded)),
  asReceived(PERIOD_HISTORY_LOADED_EXAMPLES[0], true),
];
