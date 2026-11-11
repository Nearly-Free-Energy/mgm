/**
 * The models a GUI's View is checked with (checks 3 to 7): one per view kind,
 * a value of every type, a collection with and without rows, a notice, a
 * disabled action and a proposed one, plus the signals a Shell is given
 * (check 5). Each value's text is unique on its page, so finding it in the
 * document finds that value. Everything here parses with the strict schemas
 * of ../../host/server/model-schema.ts (__tests__/fixtures.test.ts) except
 * UNKNOWN_VALUE_MODEL, which carries a value type no contract version has.
 */
import {
  type ActionRef,
  type Id,
  type ModelOf,
  type RowOf,
  type Signals,
  type Value,
  type ViewKind,
  type ViewModel,
} from "../../contract";
import { FIXTURE_IDS } from "./manifests";

const { org: ORG, community: COMMUNITY, site: SITE } = FIXTURE_IDS;
const HOUSES = ["b1", "b2", "b3"].map((n) => `00000000-0000-4000-8000-0000000000${n}`);
const PERIOD = "00000000-0000-4000-8000-0000000000f1";
const AT = "2026-11-10T11:55:00.000Z";
const SITE_HREF = `/microgrids/${SITE}/operations` as const;
const SITE_REF = { kind: "microgrid", id: SITE, label: "First site", href: SITE_HREF } as const;

export interface ModelFixture {
  name: string;
  model: ViewModel;
}

function model<K extends ViewKind>(kind: K, view: Id, title: string, body: ModelOf<K>["body"], over: Partial<ModelOf<K>> = {}) {
  return {
    type: "view",
    view,
    kind,
    body,
    title,
    org: ORG,
    trail: [{ label: "First site", href: SITE_HREF }],
    actions: [],
    links: [],
    attached: [],
    ...over,
  } as ModelOf<K>;
}

const ADD_HOUSEHOLD: ActionRef = { action: "community.add-household", params: { microgrid_id: SITE }, label: "Add household", enabled: true };
/** Disabled, with the reason a GUI must show. */
export const DISABLED_REF: ActionRef = {
  action: "billing.close-period",
  params: { period_id: PERIOD },
  label: "Close period",
  enabled: false,
  reason: "Billing is off for this organization.",
};
/** Proposed by a watcher rather than started by a person. */
export const PROPOSED_REF: ActionRef = {
  action: "billing.send-reminders",
  params: { period_id: PERIOD },
  label: "Send reminders",
  enabled: true,
  provenance: { by: "watcher", at: AT },
};

const ugx = (v: number, text: string): Value => ({ t: "money", v, currency: "UGX", text });
const kwh = (v: number, over: Partial<Value> = {}): Value => ({ t: "energy", v, unit: "kWh", text: `${v} kWh`, ...over }) as Value;
const text = (t: string): Value => ({ t: "text", text: t });

function house(i: number, name: string, owed: Value, usage: number, meter: string): RowOf<ActionRef> {
  const id = HOUSES[i];
  return {
    id,
    entity: { kind: "household", id, label: name },
    href: `/households/${id}`,
    cells: { name: text(name), owed, usage: kwh(usage), meter: text(meter) },
    actions: [],
  };
}

/** The owed column is bare: its cells carry no currency, and its header names it. */
export const BARE_COLUMN = { key: "owed", currency: "UGX" } as const;

const COLLECTION = model("collection", "community.households", "Households", {
  columns: [
    { key: "name", label: "Household", type: "text", priority: 1 },
    { key: "owed", label: "Owed (UGX)", type: "money", priority: 1, copy: "bare" },
    { key: "usage", label: "Used", type: "energy", priority: 2 },
    { key: "meter", label: "Meter", type: "text", priority: 3 },
  ],
  rows: [
    house(0, "First house", ugx(4216800, "4,216,800"), 41.2, "Meter A17"),
    house(1, "Second house", ugx(1350000, "1,350,000"), 18.6, "Meter B22"),
    house(2, "Third house", ugx(72500, "72,500"), 7.9, "Meter C31"),
  ],
  totals: { owed: ugx(5639300, "5,639,300"), usage: kwh(67.7) },
  filters: [
    { label: "Every household", href: `/microgrids/${SITE}/households`, count: 3, current: true },
    { label: "Owing only", href: `/microgrids/${SITE}/households?owing=1`, count: 2, current: false },
  ],
  empty: { title: "No households yet", text: "Add the first household to start billing.", action: ADD_HOUSEHOLD },
}, { entity: SITE_REF, actions: [ADD_HOUSEHOLD] });

const EMPTY_COLLECTION = model("collection", "community.households", "Households", {
  columns: COLLECTION.body.columns,
  rows: [],
  filters: COLLECTION.body.filters?.map((f) => ({ ...f, count: 0 })),
  empty: COLLECTION.body.empty,
  // Only the empty state offers Add household, so a GUI that leaves out its call to action is caught.
}, { entity: SITE_REF });

/** One field of each value type; derived, at and synthetic are set on some. */
const GALLERY = model("record", "community.household", "A household", {
  sections: [{
    title: "Every value",
    fields: [
      { key: "notes", label: "Notes", value: text("Gate code at the side door") },
      { key: "phone", label: "Phone", value: { t: "empty", text: "Not set" } },
      { key: "people", label: "Occupants", value: { t: "number", v: 4, text: "4 people" } },
      { key: "share", label: "Share of load", value: { t: "percent", v: 12.5, text: "12.5 %", derived: true } },
      { key: "balance", label: "Balance", value: ugx(72500, "UGX 72,500") },
      { key: "used", label: "Used this month", value: kwh(41.2, { derived: true }) },
      { key: "load", label: "Load now", value: { t: "power", v: 1.4, unit: "kW", text: "1.4 kW", at: AT, synthetic: true } },
      { key: "since", label: "Connected", value: { t: "date", v: "2026-03-02", text: "2 Mar 2026" } },
      { key: "read", label: "Last reading", value: { t: "datetime", v: AT, tz: "Africa/Kampala", text: "10 Nov 2026, 14:55", at: AT } },
      { key: "account", label: "Account", value: { t: "status", v: "active", tone: "success", text: "Active" } },
      { key: "site", label: "Site", value: { t: "ref", ref: SITE_REF, text: "Main grid site" } },
    ],
  }],
}, {
  entity: { kind: "household", id: HOUSES[0], label: "First house" },
  actions: [DISABLED_REF],
  links: [
    { id: "billing.bill", label: "Download bill", icon: "download", href: `/api/billing/periods/${PERIOD}/bill.pdf`, download: { mime: "application/pdf", filename: "bill.pdf" } },
    { id: "community.whatsapp", label: "WhatsApp", icon: "message", href: "https://wa.me/256700000001" },
    { id: "community.call", label: "Call", icon: "contact", href: "tel:+256700000001" },
    { id: "community.sms", label: "Text", icon: "message", href: "sms:+256700000001" },
  ],
});

const METRICS = model("metrics", "metering.day", "Today", {
  tiles: [
    { key: "battery", label: "Battery", value: { t: "percent", v: 64, text: "64 %" }, status: { t: "status", v: "charging", tone: "info", text: "Charging" } },
    { key: "solar", label: "Solar", value: kwh(12.3, { synthetic: true }), hint: "Generated readings" },
  ],
  series: [{ key: "load", label: "Load", unit: "kW", points: [["2026-11-10T06:00:00.000Z", 0.8], ["2026-11-10T07:00:00.000Z", null], ["2026-11-10T08:00:00.000Z", 1.1]] }],
}, { entity: SITE_REF, notice: { tone: "warning", text: "Readings paused while the gateway restarts." } });

const EMBEDDED = model("record", "community.meter", "Meter M-4471", {
  sections: [{ fields: [{ key: "serial", label: "Serial", value: text("Serial SN-90210") }] }],
});

const FEED = model("feed", "community.notes", "Notes", {
  entries: [
    {
      id: "e1",
      at: AT,
      author: { kind: "person", name: "Ann" },
      text: [{ p: ["Paid in cash, see ", { link: `/households/${HOUSES[0]}`, text: "the household" }, "."] }, { li: [{ value: ugx(150000, "UGX 150,000") }] }],
      embed: { type: "values", values: [kwh(3.1)] },
    },
    { id: "e2", at: AT, author: { kind: "system", name: "MGM" }, text: [{ p: ["Meter replaced."] }], embed: { type: "view", href: `/households/${HOUSES[1]}`, model: EMBEDDED } },
  ],
  compose: { action: { action: "community.add-note", params: { community_id: COMMUNITY }, label: "Add note", enabled: true }, textField: "text", placeholder: "Write a note" },
}, { entity: { kind: "community", id: COMMUNITY, label: "Community" } });

const FLOW = model("flow", "billing.close", "Close October", {
  steps: [
    { id: "read", title: "Enter readings", state: "done", href: `/billing/periods/${PERIOD}/readings` },
    { id: "review", title: "Review the totals", state: "current", detail: "Two households owe more than last month.", action: PROPOSED_REF },
    { id: "close", title: "Close the period", state: "todo" },
  ],
}, { entity: { kind: "billingPeriod", id: PERIOD, label: "October 2026" } });

/** The models every View is checked with, before withPoke(). */
export const MODEL_FIXTURES: readonly ModelFixture[] = [
  { name: "collection", model: COLLECTION },
  { name: "collection with no rows", model: EMPTY_COLLECTION },
  { name: "record of every value", model: GALLERY },
  { name: "metrics with a notice", model: METRICS },
  { name: "feed", model: FEED },
  { name: "flow with a proposal", model: FLOW },
];

/** Rendered as if its kind arrived after the GUI's range (check 7). */
export const LATE_KIND_MODEL: ViewModel = METRICS;

export const UNKNOWN_VALUE_TEXT = "Gauge at 42 of 100";
/** A value whose type arrived after this contract version: a GUI prints its text. */
export const UNKNOWN_VALUE_MODEL = model("record", "community.gauge", "A gauge", {
  sections: [{ fields: [{ key: "gauge", label: "Gauge", value: { t: "gauge", text: UNKNOWN_VALUE_TEXT } as unknown as Value }] }],
});

/** The signals a Shell is given: an alarm, a step that needs the person, and a proposal. */
export const SIGNALS: Signals = {
  type: "signals",
  org: ORG,
  // More than `top` holds, and a number no other text on the signals page has, so check 2 finds it.
  count: 7,
  top: [
    { id: "s1", source: "metering.gateway", severity: "critical", kind: "alarm", title: "Gateway offline", href: SITE_HREF, at: AT },
    { id: "s2", source: "billing.periods", severity: "warn", kind: "your-move", title: "Readings due", href: `/billing/periods/${PERIOD}/readings`, at: AT },
    { id: "s3", source: "billing.reminders", severity: "info", kind: "proposal", title: "Remind two households", href: `/billing/periods/${PERIOD}`, at: AT, action: PROPOSED_REF },
  ],
  checked: ["metering.gateway", "billing.periods", "billing.reminders"],
  unchecked: [],
};
