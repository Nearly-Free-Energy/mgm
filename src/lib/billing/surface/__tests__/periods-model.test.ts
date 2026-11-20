/**
 * The `billing.periods` model: the legacy periods list as a collection, with
 * the create action on the view and its empty state, and Delete on each
 * draft row.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { ViewDef } from "@/lib/gui/surface";
import { BillingCapability } from "../../capability";
import type { BillingRepository } from "../../repository";
import { BILLING_SURFACE } from "../../surface";
import { PERIODS_EXAMPLES, PERIODS_LOADED_EXAMPLES } from "../periods-examples";
import { timezoneNudge } from "@/lib/timezone/nudge";
import {
  buildPeriodsModel,
  CREATE_PERIOD_ACTION,
  DELETE_PERIOD_ACTION,
  PERIODS_KEYS,
  SET_TIMEZONE_LINK,
  TIMEZONE_NOTICE_MAX,
  type PeriodRowInput,
} from "../periods-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7100000-0000-4000-8002-0000000000a1";
const view = BILLING_SURFACE.views!.find((v) => v.id === "billing.periods") as ViewDef;

const period = (o: Partial<PeriodRowInput> = {}): PeriodRowInput => ({
  id: "e7100000-0000-4000-8003-0000000000b1",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  status: "draft",
  totalKwh: null,
  totalAmount: null,
  ...o,
});
const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };
const build = (periods: PeriodRowInput[], currency = "UGX", o: { nudge?: ReturnType<typeof timezoneNudge> } = {}) =>
  buildPeriodsModel({ microgridId: MG, currency, periods, defaults: OCTOBER, nudge: o.nudge ?? null, fmt });
const NOW = new Date("2026-11-18T08:00:00Z");
const UGANDA_UTC = { address_country: "Uganda", lat: 0.35, lng: 32.6, timezone: "UTC" };

describe("buildPeriodsModel", () => {
  it("emits the legacy list's columns, and only declared keys", () => {
    const model = build([period()]);
    expect(model.title).toBe("Billing periods");
    expect(model.body.columns.map((c) => [c.key, c.label, c.type])).toEqual([
      ["period", "Period", "text"],
      ["status", "Status", "status"],
      ["energy", "Total kWh", "energy"],
      ["total", "Total (UGX)", "money"],
    ]);
    expect(Object.keys(model.body.rows[0].cells)).toEqual([...PERIODS_KEYS]);
    // A bare money column names its currency in the header (the conformance check).
    expect(model.body.columns.find((c) => c.key === "total")).toMatchObject({ copy: "bare", label: "Total (UGX)" });
    expect(build([period()], "USD").body.columns.find((c) => c.key === "total")!.label).toBe("Total (USD)");
  });

  it("gives each row its billing period, its review page and the host's label", () => {
    const row = build([period()]).body.rows[0];
    expect(row.entity).toEqual({ kind: "billingPeriod", id: period().id, label: "1 Oct 2026 – 31 Oct 2026" });
    expect(row.href).toBe(`/microgrids/${MG}/billing/${period().id}`);
    expect(row.cells.period).toEqual({ t: "text", text: "1 Oct 2026 – 31 Oct 2026" });
    expect(row.cells.status).toMatchObject({ t: "status", v: "draft" });
  });

  it("shows a one-day period as its one date", () => {
    const row = build([period({ start_date: "2026-10-05", end_date: "2026-10-05" })]).body.rows[0];
    expect(row.cells.period.text).toBe("5 Oct 2026");
  });

  it("gives energy in Wh to Fmt, and shows the bare figures", () => {
    const row = build([period({ status: "closed", totalKwh: 1284.5, totalAmount: 4_216_800 })]).body.rows[0];
    expect(row.cells.energy).toMatchObject({ t: "energy", v: 1284.5, unit: "kWh" });
    expect(row.cells.energy.text).not.toContain("kWh");
    expect(row.cells.total).toEqual({ t: "money", v: 4_216_800, currency: "UGX", text: "4,216,800" });
  });

  it("shows 0 kWh and an empty total for a period with no bills, as the legacy list does", () => {
    const row = build([period()]).body.rows[0];
    expect(row.cells.energy).toMatchObject({ v: 0 });
    expect(row.cells.total.t).toBe("empty");
  });

  it("offers Delete on draft rows only", () => {
    const draft = period();
    const closed = period({ id: "e7100000-0000-4000-8003-0000000000b2", status: "closed" });
    const rows = build([draft, closed]).body.rows;
    expect(rows[0].actions).toEqual([{ action: DELETE_PERIOD_ACTION.id, params: { periodId: draft.id } }]);
    expect(rows[1].actions).toEqual([]);
  });

  it("offers create on the view and in the empty state, starting at the given dates", () => {
    const create = {
      action: CREATE_PERIOD_ACTION.id,
      params: { microgrid_id: MG },
      prefill: { start_date: "2026-10-01", end_date: "2026-10-31" },
    };
    const empty = build([]);
    expect(empty.actions).toEqual([create]);
    expect(empty.body.empty).toMatchObject({ title: "Create the first billing period", action: create });
    expect(empty.body.empty.text).toContain("typically one calendar month");
    expect(build([period()]).actions).toEqual([create]);
  });

  it("has no notice and no links while the microgrid's zone needs no nudge", () => {
    const model = build([period()]);
    expect(model).not.toHaveProperty("notice");
    expect(model).not.toHaveProperty("links");
    // An address whose zone is already set needs none either.
    expect(timezoneNudge({ ...UGANDA_UTC, timezone: "Africa/Kampala" }, NOW)).toBeNull();
  });

  it("repeats the microgrid layout's time zone nudge as its notice, with a link to set the zone", () => {
    const nudge = timezoneNudge(UGANDA_UTC, NOW)!;
    const model = build([period()], "UGX", { nudge });
    expect(model.notice).toEqual({ tone: "warning", text: `Billing timezone is still UTC. ${nudge.text}` });
    expect(model.notice!.text).toContain("is in Uganda (Africa/Kampala (UTC+3))");
    expect(model.links).toEqual([{ id: SET_TIMEZONE_LINK, label: "Set timezone", href: `/microgrids/${MG}/setup/rates` }]);
    // The notice shows above the empty state too.
    expect(build([], "UGX", { nudge }).notice).toEqual(model.notice);
  });

  it("cuts a notice longer than its bound, as the free-text country could make it", () => {
    const nudge = timezoneNudge({ ...UGANDA_UTC, address_country: "U".repeat(800) }, NOW)!;
    const text = build([], "UGX", { nudge }).notice!.text;
    expect(text).toHaveLength(TIMEZONE_NOTICE_MAX);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("PERIODS_EXAMPLES", () => {
  it("pass the view's strict parse as the loader returns them", () => {
    for (const loaded of PERIODS_LOADED_EXAMPLES) expect(strictParseModel(view, loaded)).toMatchObject({ ok: true });
  });

  it("are a list with a closed and a draft period, the empty state, the empty state while billing is off, and a UTC microgrid's nudge with billing on and off", () => {
    expect(PERIODS_EXAMPLES.map((e) => [e.view, e.kind, e.body.rows.length, e.notice?.tone ?? null])).toEqual([
      ["billing.periods", "collection", 2, null],
      ["billing.periods", "collection", 0, null],
      ["billing.periods", "collection", 0, "warning"],
      ["billing.periods", "collection", 1, "warning"],
      ["billing.periods", "collection", 1, "warning"],
    ]);
    const [list, empty, off, utc, utcOff] = PERIODS_EXAMPLES;
    expect(utc.notice!.text).toMatch(/^Billing timezone is still UTC\. This microgrid's address is in Uganda/);
    expect(utc.links.map((l) => l.id)).toEqual([SET_TIMEZONE_LINK]);
    // While billing is off, the gate's notice comes first and the nudge, with its link, stays.
    expect(utcOff.notice!.text).toBe(`${off.notice!.text} ${utc.notice!.text}`);
    expect(utcOff.links).toEqual(utc.links);
    expect(utcOff.actions).toMatchObject([{ action: CREATE_PERIOD_ACTION.id, enabled: false, reason: off.notice!.text }]);
    // Create starts at the previous month: in Kampala, and in UTC where the zone is still UTC.
    expect(list.actions[0].prefill).toEqual({ start_date: "2026-11-01", end_date: "2026-11-30" });
    expect(off.actions[0].prefill).toEqual(list.actions[0].prefill);
    expect(utc.actions[0].prefill).toEqual({ start_date: "2026-11-01", end_date: "2026-11-30" });
    expect(list.body.rows.map((r) => r.actions.map((a) => [a.action, a.label, a.enabled, a.tone]))).toEqual([
      [["billing.delete-period", "Delete period", true, "danger"]],
      [],
    ]);
    expect(empty.body.empty.action).toMatchObject({ action: CREATE_PERIOD_ACTION.id, label: "New billing period", enabled: true });
    expect(off.body.empty.action).toMatchObject({ enabled: false, reason: off.notice!.text });
    expect(off.actions).toEqual([off.body.empty.action]);
  });

  it("carry the copy billing answers with while disabled", async () => {
    const repo = {
      isPluginEnabled: async () => false,
      getMicrogridOrganization: async () => ({ microgridId: MG, communityId: "c", orgId: "o" }),
    } as unknown as BillingRepository;
    const capability = new BillingCapability(repo, { organizationId: "o", userId: "u", roles: [] }, { run: async () => ({ results: [] }) }, () => true);
    const refused = await capability.createPeriod({ microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31" });
    expect(refused).toMatchObject({ ok: false, code: "billing_disabled" });
    expect(PERIODS_EXAMPLES[2].notice!.text).toBe((refused as { message: string }).message);
  });
});
