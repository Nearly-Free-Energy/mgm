/**
 * The `billing.period-history` model: the legacy history page's entries as
 * a collection, one row per entry with its time, change, details, revision,
 * actor and note; the back, show-all and latest links; both empty states;
 * and the keyset paging over the audit log and payment events, ties
 * included.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { ViewDef } from "@/lib/gui/surface";
import type { BillingAuditEventType, BillingAuditLogEntry } from "@/lib/types/billing-audit";
import { humanizeAuditEvent } from "../../audit-humanize";
import { BILLING_SURFACE } from "../../surface";
import { PERIOD_HISTORY_EXAMPLES, PERIOD_HISTORY_LOADED_EXAMPLES } from "../period-history-examples";
import {
  BACK_TO_PERIOD_LINK,
  buildPeriodHistoryModel,
  compareHistory,
  cursorQueries,
  encodeCursor,
  HISTORY_LATEST_LINK,
  HISTORY_SHOW_ALL_LINK,
  historyActorLabel,
  humanizeHistoryEntry,
  instantKey,
  mergePage,
  parseCursor,
  PERIOD_HISTORY_KEYS,
  PERIOD_HISTORY_NOTE_MAX,
  periodHistoryHref,
  type HistoryKeyed,
  type PeriodHistoryInput,
  type SideQuery,
} from "../period-history-model";
import { PERIOD_REVIEW_EXAMPLES } from "../period-review-examples";
import { VIEW_HISTORY_LINK } from "../period-review-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7b00000-0000-4000-8002-0000000000a1";
const PERIOD = "e7b00000-0000-4000-8003-0000000000b1";
const TENANT = "e7b00000-0000-4000-8004-0000000000c1";
const BILL = "e7b00000-0000-4000-8005-0000000000d1";
const ACTOR = "e7b00000-0000-4000-8006-0000000000f1";
const view = BILLING_SURFACE.views!.find((v) => v.id === "billing.period-history") as ViewDef;
const uuid = (n: number) => `e7b00000-0000-4000-8007-${n.toString(16).padStart(12, "0")}`;

const entry = (o: Partial<BillingAuditLogEntry> & Pick<BillingAuditLogEntry, "eventType">): BillingAuditLogEntry => ({
  id: `audit:${uuid(1)}`,
  actorUserId: ACTOR,
  actorDisplayName: "Okello Daniel",
  createdAt: "2026-10-31T21:00:00+00:00",
  billingLineItemId: BILL,
  tenantName: "Unit 1",
  details: {},
  ...o,
});

const input = (o: Partial<PeriodHistoryInput> = {}): PeriodHistoryInput => ({
  microgrid: { id: MG, currency: "UGX" },
  period: { id: PERIOD, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala" },
  entries: [entry({ eventType: "period_created" })],
  filter: null,
  before: null,
  next: null,
  fmt,
  ...o,
});
const build = (o: Partial<PeriodHistoryInput> = {}) => buildPeriodHistoryModel(input(o));
const human = (e: BillingAuditLogEntry) => humanizeHistoryEntry(e, fmt, "UGX");
const ugx = (n: number) => fmt.money(n, "UGX").text;
const hrefs = (m: ReturnType<typeof build>) => [...(m.links ?? []).map((l) => l.href), m.body.next ?? ""];

/** One entry of every event type, with the details each one's writer puts. */
const FIXTURES: BillingAuditLogEntry[] = [
  entry({ eventType: "period_created", billingLineItemId: null, tenantName: null }),
  entry({ eventType: "period_closed", billingLineItemId: null, tenantName: null, details: { digest: "abc", bill_count: 3 } }),
  entry({ eventType: "line_item_generated", details: { new_total_amount: 55875, manual_reason: "By hand" } }),
  entry({
    eventType: "line_item_regenerated",
    details: { previous_total_amount: 55875, new_total_amount: 24000, previous_reading_source: "edge", new_reading_source: "manual", period_was_closed: true },
  }),
  entry({ eventType: "payment_status_changed", details: { from: "unpaid", to: "paid", notes: "Cash" } }),
  entry({ eventType: "payment_link_generated", details: { from: "unpaid", to: "link_generated" } }),
  entry({ eventType: "billing_period_created", billingLineItemId: null, tenantName: null }),
  entry({ eventType: "token_generated", billingLineItemId: null, tenantName: null, details: { name: "ERP" } }),
  entry({ eventType: "token_revoked", billingLineItemId: null, tenantName: null, details: { name: "ERP" } }),
  entry({ eventType: "token_regenerated", billingLineItemId: null, tenantName: null }),
  entry({ eventType: "tariff_reconciled", billingLineItemId: null, tenantName: null, details: { review_reference: "TR-1" } }),
];

describe("buildPeriodHistoryModel: columns and keys", () => {
  it("emits the columns in order, with only declared keys, so the host's strict parse passes", () => {
    expect(build().body.columns.map((c) => [c.key, c.label, c.type, c.priority])).toEqual([
      ["at", "When", "datetime", 1],
      ["change", "Change", "text", 1],
      ["detail", "Details", "text", 2],
      ["revision", "Revision", "status", 2],
      ["by", "By", "text", 3],
      ["note", "Note", "text", 3],
    ]);
    for (const model of PERIOD_HISTORY_LOADED_EXAMPLES) {
      expect(strictParseModel(view, model)).toMatchObject({ ok: true });
      for (const row of model.body.rows) for (const key of Object.keys(row.cells)) expect(PERIOD_HISTORY_KEYS).toContain(key);
    }
    expect(view.declares.keys).toEqual(PERIOD_HISTORY_KEYS);
  });

  it("gives rows no entity, related records, href or actions", () => {
    const [row] = build({ entries: [entry({ eventType: "line_item_generated" })] }).body.rows;
    expect(row).not.toHaveProperty("entity");
    expect(row).not.toHaveProperty("related");
    expect(row).not.toHaveProperty("href");
    expect(row.actions).toEqual([]);
  });

  it("shows each entry's time in the period's time zone", () => {
    const [row] = build().body.rows;
    expect(row.cells.at).toEqual(fmt.datetime("2026-10-31T21:00:00+00:00", "Africa/Kampala"));
  });
});

describe("humanizeHistoryEntry", () => {
  it("words each event type as the legacy page does", () => {
    expect(FIXTURES.map((e) => [e.eventType, human(e).change, human(e).detail, human(e).note])).toEqual([
      ["period_created", "Period created", null, null],
      ["period_closed", "Period closed", null, null],
      ["line_item_generated", "Bill generated for Unit 1", `Total: ${ugx(55875)}`, "By hand"],
      ["line_item_regenerated", "Bill regenerated for Unit 1", `Total changed from ${ugx(55875)} to ${ugx(24000)} · Source changed from Edge to Manual`, null],
      ["payment_status_changed", "Payment status for Unit 1", "Unpaid → Paid", "Cash"],
      ["payment_link_generated", "Payment link generated for Unit 1", null, null],
      ["billing_period_created", "Billing period created", null, null],
      ["token_generated", "API token created: ERP", null, null],
      ["token_revoked", "API token revoked: ERP", null, null],
      ["token_regenerated", "API token regenerated", null, null],
      ["tariff_reconciled", "Historical tariff reconciled (TR-1)", null, null],
    ]);
  });

  it("matches the legacy page's labels and post-close mark for every event type", () => {
    for (const e of FIXTURES) {
      const legacy = humanizeAuditEvent(e);
      expect(typeof legacy.label).toBe("string");
      expect(human(e).change, e.eventType).toBe(legacy.label);
      expect(human(e).postClose, e.eventType).toBe(legacy.postCloseRevision);
    }
  });

  it("says the total is unchanged when there is no previous total or it is the same", () => {
    expect(human(entry({ eventType: "line_item_regenerated", details: { previous_total_amount: null, new_total_amount: 10 } })).detail).toBe("Total unchanged");
    expect(human(entry({ eventType: "line_item_regenerated", details: { previous_total_amount: 10, new_total_amount: 10 } })).detail).toBe("Total unchanged");
  });

  it("names a source change only when both sources are known and differ", () => {
    const detail = (prev: string | null, next: string | null) =>
      human(entry({ eventType: "line_item_regenerated", details: { previous_total_amount: 1, new_total_amount: 1, previous_reading_source: prev, new_reading_source: next } }))
        .detail;
    expect(detail(null, "manual")).toBe("Total unchanged");
    expect(detail("edge", "edge")).toBe("Total unchanged");
    expect(detail("manual", "edge")).toBe("Total unchanged · Source changed from Manual to Edge");
  });

  it("says Set to for a first status, and from → to after", () => {
    expect(human(entry({ eventType: "payment_status_changed", details: { from: null, to: "paid" } })).detail).toBe("Set to Paid");
    expect(human(entry({ eventType: "payment_status_changed", details: { from: "paid", to: "refunded" } })).detail).toBe("Paid → Refunded");
    expect(human(entry({ eventType: "payment_status_changed", details: {} })).detail).toBeNull();
  });

  it("shows notes on status changes only, and manual reasons on bills only", () => {
    expect(human(entry({ eventType: "payment_link_generated", details: { notes: "x", manual_reason: "y" } })).note).toBeNull();
    expect(human(entry({ eventType: "period_closed", details: { manual_reason: "y" } })).note).toBeNull();
    expect(human(entry({ eventType: "payment_status_changed", details: { to: "paid", manual_reason: "y" } })).note).toBeNull();
    expect(human(entry({ eventType: "line_item_regenerated", details: { notes: "x", manual_reason: "y" } })).note).toBe("y");
  });

  it("shows an unknown event type as itself", () => {
    const e = entry({ eventType: "meter_swapped" as BillingAuditEventType });
    expect(human(e)).toEqual({ change: "meter_swapped", detail: null, note: null, postClose: false });
  });

  it("names the tenant live, then from the snapshot, then as unknown", () => {
    const change = (o: Partial<BillingAuditLogEntry>) => human(entry({ eventType: "payment_link_generated", ...o })).change;
    expect(change({ tenantName: "Live", details: { tenant_name: "Snap" } })).toBe("Payment link generated for Live");
    expect(change({ tenantName: null, details: { tenant_name: "Snap", household_name: "Old" } })).toBe("Payment link generated for Snap");
    expect(change({ tenantName: null, details: { household_name: "Old" } })).toBe("Payment link generated for Old");
    expect(change({ tenantName: null, details: {} })).toBe("Payment link generated for Unknown tenant");
  });

  it("clips a long note so the model still parses", () => {
    const long = "x".repeat(5000);
    const e = entry({ eventType: "line_item_generated", details: { manual_reason: long, tenant_name: long } });
    expect(human(e).note).toHaveLength(PERIOD_HISTORY_NOTE_MAX);
    expect(human(e).note!.endsWith("…")).toBe(true);
    const model = build({ entries: [{ ...e, tenantName: null }] });
    expect(strictParseModel(view, model)).toMatchObject({ ok: true });
  });

  it("clips a long tenant name in the filter's subtitle and empty state, so the model still parses", () => {
    // tenants.display_name has no length limit.
    const long = "n".repeat(5000);
    const filter = { tenantId: TENANT, tenantName: long, canMatch: true };
    for (const model of [build({ filter }), build({ filter, entries: [entry({ eventType: "line_item_generated", tenantName: long })] })]) {
      expect(strictParseModel(view, model)).toMatchObject({ ok: true });
      expect(model.subtitle).toContain("n".repeat(PERIOD_HISTORY_NOTE_MAX - 1) + "…");
    }
    expect(build({ filter }).body.empty.title).toBe(`No changes recorded for ${"n".repeat(PERIOD_HISTORY_NOTE_MAX - 1)}…`);
  });
});

describe("buildPeriodHistoryModel: rows", () => {
  it("names the actor: System for none, Restricted for one not visible, else the name", () => {
    expect(historyActorLabel({ actorUserId: null, actorDisplayName: null })).toBe("System");
    expect(historyActorLabel({ actorUserId: ACTOR, actorDisplayName: null })).toBe("Restricted");
    expect(historyActorLabel({ actorUserId: ACTOR, actorDisplayName: "Okello" })).toBe("Okello");
    const rows = build({
      entries: [entry({ eventType: "period_created", actorUserId: null, actorDisplayName: null }), entry({ eventType: "period_closed", actorDisplayName: null })],
    }).body.rows;
    expect(rows.map((r) => r.cells.by.text)).toEqual(["System", "Restricted"]);
  });

  it("marks a post-close revision in the warning tone, and nothing else", () => {
    const rows = build({ entries: FIXTURES }).body.rows;
    expect(rows[3].cells.revision).toEqual({ t: "status", v: "post_close_revision", tone: "warning", text: "Post-close revision" });
    for (const [n, row] of rows.entries()) if (n !== 3) expect(row.cells.revision).toEqual(fmt.empty());
  });

  it("puts empty cells where an entry has no detail or note", () => {
    const [row] = build().body.rows;
    expect(row.cells.detail.t).toBe("empty");
    expect(row.cells.note.t).toBe("empty");
  });
});

describe("buildPeriodHistoryModel: the period and links", () => {
  it("titles the history, labels the period and offers Back to period", () => {
    const model = build();
    expect(model.title).toBe("Audit history");
    expect(model.subtitle).toBe(`${fmt.date("2026-10-01").text} – ${fmt.date("2026-10-31").text}`);
    expect(model.entity).toEqual({ kind: "billingPeriod", id: PERIOD, label: model.subtitle });
    expect(model.actions).toEqual([]);
    expect(model.links).toEqual([{ id: BACK_TO_PERIOD_LINK, label: "Back to period", href: `/microgrids/${MG}/billing/${PERIOD}` }]);
  });

  it("shows a one-day period's one date", () => {
    const model = build({ period: { id: PERIOD, start_date: "2026-10-05", end_date: "2026-10-05", timezone: "UTC" } });
    expect(model.subtitle).toBe(fmt.date("2026-10-05").text);
  });

  it("offers Show all and names the tenant while filtered", () => {
    const model = build({ filter: { tenantId: TENANT, tenantName: "Unit 1", canMatch: true } });
    expect(model.subtitle).toMatch(/ · Showing changes for Unit 1$/);
    expect(model.links).toEqual([
      { id: BACK_TO_PERIOD_LINK, label: "Back to period", href: `/microgrids/${MG}/billing/${PERIOD}` },
      { id: HISTORY_SHOW_ALL_LINK, label: "Show all", href: `/microgrids/${MG}/billing/${PERIOD}/history` },
    ]);
  });

  it("offers Latest changes on a later page only, keeping a valid tenant", () => {
    const before = encodeCursor({ source: "a", id: uuid(9), at: "2026-10-31T21:00:00+00:00" });
    expect(build().links!.map((l) => l.id)).not.toContain(HISTORY_LATEST_LINK);
    const later = build({ before, filter: { tenantId: TENANT, tenantName: "Unit 1", canMatch: true } });
    expect(later.links!.find((l) => l.id === HISTORY_LATEST_LINK)).toEqual({
      id: HISTORY_LATEST_LINK,
      label: "Latest changes",
      href: `/microgrids/${MG}/billing/${PERIOD}/history?tenant_id=${TENANT}`,
    });
  });

  it("never echoes a tenant id that is not a UUID", () => {
    const model = build({ filter: { tenantId: null, tenantName: null, canMatch: false }, entries: [], before: "a~x~y" });
    expect(model.subtitle).toMatch(/ · Showing changes for unknown tenant$/);
    expect(JSON.stringify(model)).not.toContain("tenant_id=");
    for (const href of hrefs(model)) expect(href).not.toContain("tenant_id");
  });

  it("shows the legacy empty states, with no action", () => {
    expect(build({ entries: [] }).body.empty).toEqual({
      title: "No changes recorded yet",
      text: "This period has no events. As you generate bills, close the period, or take payments, entries will appear here.",
    });
    expect(build({ entries: [], filter: { tenantId: TENANT, tenantName: "Unit 1", canMatch: true } }).body.empty).toEqual({
      title: "No changes recorded for Unit 1",
      text: "Other tenants on this period may have entries.",
    });
    expect(build({ entries: [], filter: { tenantId: TENANT, tenantName: null, canMatch: true } }).body.empty.title).toBe("No changes recorded for unknown tenant");
    expect(build({ entries: [], before: "a~x~y" }).body.empty).toEqual({ title: "No earlier changes recorded" });
  });

  it("says a filtered later page that comes back empty has no earlier changes, not none at all", () => {
    const before = encodeCursor({ source: "a", id: uuid(9), at: "2026-10-31T21:00:00+00:00" });
    expect(build({ entries: [], before, filter: { tenantId: TENANT, tenantName: "Unit 1", canMatch: true } }).body.empty).toEqual({
      title: "No earlier changes recorded for Unit 1",
    });
    expect(build({ entries: [], before, filter: { tenantId: TENANT, tenantName: null, canMatch: true } }).body.empty).toEqual({
      title: "No earlier changes recorded for unknown tenant",
    });
  });

  it("treats a page filtered by a tenant id that is not a UUID as the first, whatever its cursor", () => {
    const before = encodeCursor({ source: "a", id: uuid(9), at: "2026-10-31T21:00:00+00:00" });
    const model = build({ entries: [], before, filter: { tenantId: null, tenantName: null, canMatch: false } });
    // Show all and Latest changes would both be the unfiltered history: only Show all is offered.
    expect(model.links!.map((l) => [l.id, l.href])).toEqual([
      [BACK_TO_PERIOD_LINK, `/microgrids/${MG}/billing/${PERIOD}`],
      [HISTORY_SHOW_ALL_LINK, `/microgrids/${MG}/billing/${PERIOD}/history`],
    ]);
    expect(new Set(model.links!.map((l) => l.href)).size).toBe(model.links!.length);
    expect(model.body.empty).toEqual({ title: "No changes recorded for unknown tenant", text: "Other tenants on this period may have entries." });
  });

  it("treats a page filtered by a tenant that can match nothing as the first, whatever its cursor", () => {
    const before = encodeCursor({ source: "a", id: uuid(9), at: "2026-10-31T21:00:00+00:00" });
    // A tenant of another microgrid (no name) and a tenant of this one with no bill in the period.
    for (const [tenantName, label] of [
      [null, "unknown tenant"],
      ["Unit 1", "Unit 1"],
    ] as const) {
      const model = build({ entries: [], before, filter: { tenantId: TENANT, tenantName, canMatch: false } });
      expect(model.links!.map((l) => [l.id, l.href])).toEqual([
        [BACK_TO_PERIOD_LINK, `/microgrids/${MG}/billing/${PERIOD}`],
        [HISTORY_SHOW_ALL_LINK, `/microgrids/${MG}/billing/${PERIOD}/history`],
      ]);
      expect(model.body.empty).toEqual({ title: `No changes recorded for ${label}`, text: "Other tenants on this period may have entries." });
    }
  });

  it("never offers two of its own links to the same place", () => {
    const before = encodeCursor({ source: "a", id: uuid(9), at: "2026-10-31T21:00:00+00:00" });
    for (const filter of [
      null,
      { tenantId: TENANT, tenantName: "Unit 1", canMatch: true },
      { tenantId: TENANT, tenantName: null, canMatch: true },
      { tenantId: TENANT, tenantName: null, canMatch: false },
      { tenantId: null, tenantName: null, canMatch: false },
    ]) {
      for (const b of [null, before]) {
        const hrefs = build({ filter, before: b }).links!.map((l) => l.href);
        expect(new Set(hrefs).size, JSON.stringify({ filter, before: b })).toBe(hrefs.length);
      }
    }
  });

  it("links the next page with both parameters, encoded", () => {
    const next = encodeCursor({ source: "p", id: uuid(3), at: "2026-10-31T21:00:00.5+03:00" });
    const model = build({ next, filter: { tenantId: TENANT, tenantName: "Unit 1", canMatch: true } });
    expect(model.body.next).toMatch(new RegExp(`^/microgrids/${MG}/billing/${PERIOD}/history\\?tenant_id=${TENANT}&before=[^&#]+$`));
    // The cursor's "+" and ":" are encoded, so the offset survives the URL.
    expect(model.body.next).not.toContain("+03:00");
    const search = new URL(model.body.next!, "https://x.invalid").searchParams;
    expect([...search.keys()]).toEqual(["tenant_id", "before"]);
    expect(search.get("before")).toBe(next);
    expect(build().body).not.toHaveProperty("next");
  });

  it("builds hrefs with periodHistoryHref", () => {
    expect(periodHistoryHref(MG, PERIOD)).toBe(`/microgrids/${MG}/billing/${PERIOD}/history`);
    expect(periodHistoryHref(MG, PERIOD, { tenantId: TENANT })).toBe(`/microgrids/${MG}/billing/${PERIOD}/history?tenant_id=${TENANT}`);
  });
});

describe("instantKey and the order", () => {
  it("keys trimmed fractions and any offset to fixed-width UTC microseconds", () => {
    expect(instantKey("2026-10-31T21:00:00+00:00")).toBe("2026-10-31T21:00:00.000000");
    expect(instantKey("2026-10-31T21:00:00.5+00:00")).toBe("2026-10-31T21:00:00.500000");
    expect(instantKey("2026-10-31T21:00:00.123456+00:00")).toBe("2026-10-31T21:00:00.123456");
    expect(instantKey("2026-11-01T00:00:00.1+03:00")).toBe("2026-10-31T21:00:00.100000");
    expect(instantKey("2026-10-31T17:30:00-03:30")).toBe("2026-10-31T21:00:00.000000");
    expect(instantKey("2026-10-31T21:00:00Z")).toBe("2026-10-31T21:00:00.000000");
    expect(instantKey("not a time")).toBe("");
  });

  it("orders a microsecond apart, which a Date cannot tell", () => {
    const a = { source: "a" as const, id: uuid(1), at: "2026-10-31T21:00:00.000001+00:00" };
    const b = { source: "a" as const, id: uuid(2), at: "2026-10-31T21:00:00+00:00" };
    expect(Date.parse(a.at)).toBe(Date.parse(b.at));
    expect([b, a].sort(compareHistory)).toEqual([a, b]);
  });

  it("puts the audit log first at one instant, then ids descending", () => {
    const at = "2026-10-31T21:00:00.25+00:00";
    const sameInstant = "2026-11-01T00:00:00.25+03:00";
    const rows: HistoryKeyed[] = [
      { source: "p", id: uuid(9), at },
      { source: "a", id: uuid(1), at: sameInstant },
      { source: "a", id: uuid(5), at },
      { source: "p", id: uuid(2), at: "2026-10-31T22:00:00+00:00" },
    ];
    expect([...rows].sort(compareHistory).map((r) => `${r.source}${r.id.slice(-1)}`)).toEqual(["p2", "a5", "a1", "p9"]);
  });
});

describe("the cursor", () => {
  it("round-trips", () => {
    const c = { source: "p" as const, id: uuid(3), at: "2026-10-31T21:00:00.123+00:00" };
    expect(parseCursor(encodeCursor(c))).toEqual(c);
    for (const at of ["2024-02-29T00:00:00Z", "2026-12-31 23:59:59.999999+03:00", "2026-10-31T21:00:00+15:59", "2026-10-31T21:00:00-0530"]) {
      expect(parseCursor(encodeCursor({ ...c, at }))?.at, at).toBe(at);
    }
  });

  it.each([null, "", "a", "x~" + uuid(1) + "~2026-10-31T21:00:00+00:00", "a~not-a-uuid~2026-10-31T21:00:00+00:00", `a~${uuid(1)}~yesterday`, `a~${uuid(1)}~2026-13-45T99:00:00+00:00`,
    // Date.parse takes these; Postgres refuses them, which would fail the read.
    `a~${uuid(1)}~2026-02-30T00:00:00Z`,
    `a~${uuid(1)}~2025-02-29T00:00:00+00:00`,
    `a~${uuid(1)}~2026-04-31 12:00:00+00`,
    `a~${uuid(1)}~0000-10-31T21:00:00Z`,
    `a~${uuid(1)}~2026-10-31T21:00:00+16:00`,
    `a~${uuid(1)}~2026-10-31T24:00:00Z`,
    `a~${uuid(1)}~2026-10-31T21:00:00+00:00~x`])(
    "reads %j as the first page",
    (raw) => {
      expect(parseCursor(raw)).toBeNull();
    },
  );

  it("reads, after an audit entry, its instant's lower ids and earlier entries, and payment events at or before it", () => {
    const at = "2026-10-31T21:00:00+00:00";
    expect(cursorQueries(null)).toEqual({ audit: [{ kind: "all" }], payment: [{ kind: "all" }] });
    expect(cursorQueries({ source: "a", id: uuid(1), at })).toEqual({
      audit: [{ kind: "tie", at, beforeId: uuid(1) }, { kind: "lt", at }],
      payment: [{ kind: "lte", at }],
    });
    expect(cursorQueries({ source: "p", id: uuid(1), at })).toEqual({
      audit: [{ kind: "lt", at }],
      payment: [{ kind: "tie", at, beforeId: uuid(1) }, { kind: "lt", at }],
    });
  });
});

describe("mergePage", () => {
  /** The loader's reads, in memory: each query newest first, at most a page and one. */
  const read = (rows: HistoryKeyed[], queries: SideQuery[], page: number) =>
    queries.flatMap((q) =>
      rows
        .filter((r) => {
          const k = instantKey(r.at);
          if (q.kind === "all") return true;
          const t = instantKey(q.at);
          if (q.kind === "tie") return k === t && r.id < q.beforeId;
          return q.kind === "lt" ? k < t : k <= t;
        })
        .sort(compareHistory)
        .slice(0, page + 1),
    );

  const walk = (audit: HistoryKeyed[], payments: HistoryKeyed[], page: number) => {
    const pages: string[][] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const plan = cursorQueries(parseCursor(before));
      const { entries, next } = mergePage(read(audit, plan.audit, page), read(payments, plan.payment, page), page);
      pages.push(entries.map((e) => `${e.source}:${e.id}`));
      if (!next) return pages;
      before = next;
    }
    throw new Error("did not end");
  };

  // Three instants, written in the database's trimmed forms and two offsets, with ties across both sources.
  const T1 = "2026-10-31T21:00:00.5+00:00";
  const T1_OTHER_ZONE = "2026-11-01T00:00:00.5+03:00";
  const T2 = "2026-10-31T20:00:00+00:00";
  const T3 = "2026-10-31T19:59:59.999999+00:00";
  const audit: HistoryKeyed[] = [
    ...Array.from({ length: 7 }, (_, n) => ({ source: "a" as const, id: uuid(0x100 + n), at: n % 2 ? T1 : T1_OTHER_ZONE })),
    ...Array.from({ length: 4 }, (_, n) => ({ source: "a" as const, id: uuid(0x200 + n), at: T2 })),
    { source: "a", id: uuid(0x300), at: T3 },
  ];
  const payments: HistoryKeyed[] = [
    ...Array.from({ length: 3 }, (_, n) => ({ source: "p" as const, id: uuid(0x400 + n), at: T1 })),
    ...Array.from({ length: 3 }, (_, n) => ({ source: "p" as const, id: uuid(0x500 + n), at: T2 })),
  ];
  const all = [...audit, ...payments].sort(compareHistory).map((e) => `${e.source}:${e.id}`);

  it.each([1, 2, 3, 4, 5, 7, 18, 50])("pages of %i neither skip nor repeat an entry across ties", (page) => {
    const pages = walk(audit, payments, page);
    expect(pages.flat()).toEqual(all);
    for (const p of pages.slice(0, -1)) expect(p).toHaveLength(page);
  });

  it("gives a next cursor only when more than a page is merged", () => {
    expect(mergePage(audit.slice(0, 2), payments.slice(0, 1), 3).next).toBeNull();
    const { entries, next } = mergePage(audit.slice(0, 2), payments.slice(0, 2), 3);
    expect(entries).toHaveLength(3);
    expect(parseCursor(next)).toMatchObject({ id: entries[2].id, source: entries[2].source });
  });
});

describe("the examples", () => {
  it("are received models of this view, built by the model", () => {
    expect(PERIOD_HISTORY_EXAMPLES).toHaveLength(7);
    for (const [n, example] of PERIOD_HISTORY_EXAMPLES.entries()) {
      expect(example).toMatchObject({ view: "billing.period-history", kind: "collection", title: "Audit history", actions: [] });
      expect(example.trail).toHaveLength(2);
      expect(example.links[0].id).toBe(BACK_TO_PERIOD_LINK);
      if (n < PERIOD_HISTORY_LOADED_EXAMPLES.length) expect(example.body).toEqual(PERIOD_HISTORY_LOADED_EXAMPLES[n].body);
    }
    expect(PERIOD_HISTORY_EXAMPLES[6].notice).toMatchObject({ tone: "warning" });
    // The first holds every kind of entry a period holds, in order, down to
    // the period's creation, so no next page.
    const first = PERIOD_HISTORY_EXAMPLES[0];
    expect(first.body.next).toBeUndefined();
    expect(first.body.rows.at(-1)?.cells.change.text).toBe("Period created");
    const keyed = first.body.rows.map((r): HistoryKeyed => {
      const [source, id] = r.id.split(":");
      const at = r.cells.at;
      return { source: source === "audit" ? "a" : "p", id, at: at.t === "datetime" ? at.v : "" };
    });
    expect(keyed.length).toBeGreaterThan(8);
    expect([...keyed].sort(compareHistory)).toEqual(keyed);
    expect(first.body.rows.some((r) => r.cells.revision.t === "status")).toBe(true);
    expect(first.body.rows.map((r) => r.cells.by.text)).toEqual(expect.arrayContaining(["System", "Restricted", "Okello Daniel"]));
    expect(PERIOD_HISTORY_EXAMPLES[2].body.empty.title).toBe("No changes recorded for unknown tenant");
    expect(PERIOD_HISTORY_EXAMPLES[4].links.map((l) => l.id)).toContain(HISTORY_LATEST_LINK);
  });

  it("show a next page only where mergePage gives one, at the page size they name", () => {
    // Only the shrunk page (five rows, ./period-history-examples.ts) has more to follow.
    expect(PERIOD_HISTORY_EXAMPLES.map((e) => Boolean(e.body.next))).toEqual([false, false, false, false, false, true, false]);
    const paged = PERIOD_HISTORY_EXAMPLES[5];
    expect(paged.body.rows.map((r) => r.id)).toEqual(PERIOD_HISTORY_EXAMPLES[0].body.rows.slice(0, 5).map((r) => r.id));
    // Its next page is the later-page example.
    const later = PERIOD_HISTORY_EXAMPLES[4];
    const before = (href: string) => new URL(href, "http://x").searchParams.get("before");
    const latest = later.links.find((l) => l.id === HISTORY_LATEST_LINK)!;
    expect(before(paged.body.next!)).not.toBeNull();
    expect(parseCursor(before(paged.body.next!))).toMatchObject({ source: "p", id: paged.body.rows.at(-1)!.id.split(":")[1] });
    expect(later.body.rows.map((r) => r.id)).toEqual(PERIOD_HISTORY_EXAMPLES[0].body.rows.slice(5).map((r) => r.id));
    expect(before(latest.href)).toBeNull();
  });
});

describe("consistency with the period review", () => {
  const pattern = new RegExp(`^${view.path.replace(/\[[^\]]+\]/g, "[^/?#]+")}(?:\\?(.*))?$`);

  it("links every View history to this view's path, with only the query names it reads", () => {
    const links = PERIOD_REVIEW_EXAMPLES.flatMap((m) => [...m.links, ...m.body.rows.flatMap((r) => r.links ?? [])]).filter((l) => l.id === VIEW_HISTORY_LINK);
    expect(links.length).toBeGreaterThan(1);
    expect(links.some((l) => l.href.includes("?"))).toBe(true);
    for (const l of links) {
      const m = pattern.exec(l.href);
      expect(m, l.href).not.toBeNull();
      for (const name of new URLSearchParams(m![1] ?? "").keys()) expect(view.query).toContain(name);
    }
  });
});
