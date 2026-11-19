/**
 * The usage views' models (RFC mgm#197 § 4–5): what a tenant reads in each
 * state of a day or an hour, the totals that are never a lower number, the
 * times in the unit's zone, and the ext's calendar and navigation. Built
 * from the calendar's own output (computeUsageMonth, computeUsageDay) with
 * figures a test chooses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatKwh } from "@/components/format/kwh";
import { createFmt } from "@/lib/gui/fmt";
import { localHourStarts } from "@/lib/timezone/day-key";
import type { TenantMeter } from "../types";
import { computeUsageDay, computeUsageMonth, datesOfMonth, type UsageFigures } from "../usage-calendar";
import { TenantUsageDayExt, TenantUsageMonthExt, type TenantUsageDayExtData, type TenantUsageMonthExtData } from "../surface/usage-ext";
import {
  buildUsageDayModel,
  buildUsageMonthModel,
  readTimeLabel,
  TENANT_USAGE_DAY_EXT_SCHEMA,
  TENANT_USAGE_MONTH_EXT_SCHEMA,
  TENANT_USAGE_PROBLEMS,
} from "../surface/usage-model";

const LOCALE = "en-GB";
const fmt = createFmt({ locale: LOCALE });
const KAMPALA = "Africa/Kampala";
const UNIT = "00000000-0000-4000-8000-0000000000b1";
const TENANT = { id: UNIT, displayName: "Nakato Grace", unitLabel: "Unit 4" };
const ONE = { tenantId: UNIT, several: false };
const SEVERAL = { tenantId: UNIT, several: true };
/** 14:30 on 18 November 2026 in Kampala. */
const NOW = Date.parse("2026-11-18T11:30:00Z");
const TODAY = "2026-11-18";

const link = (deviceId: string, effectiveFrom: string, effectiveTo: string | null = null): TenantMeter => ({
  deviceId,
  name: deviceId,
  deviceType: "consumption_meter",
  role: "primary_consumption_meter",
  effectiveFrom,
  effectiveTo,
});
const kwh = (v: number, digits = 1) => `${formatKwh(v, LOCALE, { digits })} kWh`;
const figures = (values: Record<string, number | null>, readAt = NOW, stale = false, synthetic = false): UsageFigures => ({
  kind: "figures",
  values,
  readAt,
  stale,
  synthetic,
});

type Cells = Record<string, { t: string; text: string; synthetic?: true }>;
const cellsOf = (model: ReturnType<typeof buildUsageMonthModel>) =>
  Object.fromEntries(model.body.rows.map((r) => [r.id, r.cells as Cells]));

function month(
  monthKey: string,
  f: UsageFigures,
  assignments: TenantMeter[] = [link("m", "2026-01-01")],
  o: { today?: string; nowMs?: number; links?: typeof ONE; timezone?: string } = {},
) {
  const computed = computeUsageMonth({
    tenant: TENANT,
    timezone: o.timezone ?? KAMPALA,
    month: monthKey,
    today: o.today ?? TODAY,
    nowMs: o.nowMs ?? NOW,
    assignments,
    figures: f,
  });
  const model = buildUsageMonthModel(computed, { fmt, locale: LOCALE, links: o.links ?? ONE });
  return { computed, model, ext: model.ext!.data as TenantUsageMonthExtData };
}

function day(
  date: string,
  f: UsageFigures,
  assignments: TenantMeter[] = [link("m", "2026-01-01")],
  o: { today?: string; nowMs?: number; links?: typeof ONE; timezone?: string } = {},
) {
  const computed = computeUsageDay({
    tenant: TENANT,
    timezone: o.timezone ?? KAMPALA,
    date,
    today: o.today ?? TODAY,
    nowMs: o.nowMs ?? NOW,
    assignments,
    figures: f,
  });
  const model = buildUsageDayModel(computed, { fmt, locale: LOCALE, links: o.links ?? ONE });
  return { computed, model, ext: model.ext!.data as TenantUsageDayExtData };
}

/** Every past day of November up to today at 2 kWh, and today so far at 0.5 kWh. */
const NOVEMBER = Object.fromEntries(datesOfMonth("2026-11").filter((d) => d <= TODAY).map((d) => [d, d === TODAY ? 0.5 : 2]));

describe("the month model", () => {
  it("lists the days up to today, with today so far, and leaves the rest of the month to the ext", () => {
    const { model, ext } = month("2026-11", figures(NOVEMBER, NOW, false, true));
    expect(model.title).toBe("November 2026");
    expect(model.subtitle).toBe("Unit 4");
    expect(model.entity).toEqual({ kind: "tenant", id: UNIT, label: "Unit 4" });
    expect(model.actions).toEqual([]);
    expect(model).not.toHaveProperty("links");
    expect(model.body.columns).toEqual([
      { key: "date", label: "Day", type: "date", priority: 1 },
      { key: "usage", label: "Use", type: "energy", priority: 1 },
      { key: "note", label: "Note", type: "text", priority: 2 },
    ]);
    expect(model.body.rows.map((r) => r.id)).toEqual(datesOfMonth("2026-11").slice(0, 18));
    const cells = cellsOf(model);
    expect(cells["2026-11-01"]).toEqual({ date: fmt.date("2026-11-01"), usage: fmt.energy(2000, { synthetic: true }) });
    expect(cells[TODAY]).toEqual({
      date: fmt.date(TODAY),
      usage: fmt.energy(500, { synthetic: true }),
      note: { t: "text", text: "So far today" },
    });
    expect(model.body.totals).toEqual({ usage: fmt.energy(34_500, { synthetic: true }), note: { t: "text", text: "So far" } });
    expect(model.ext?.schema).toBe(TENANT_USAGE_MONTH_EXT_SCHEMA);
    expect(TenantUsageMonthExt.safeParse(ext).success).toBe(true);
    expect(ext.days).toHaveLength(30);
    expect(ext.days.slice(18).every((d) => d.state === "future" && d.text === "" && d.tier === null && d.href === null)).toBe(true);
    expect(ext.days[17]).toMatchObject({ date: TODAY, day: 18, state: "partial", kwh: 0.5, text: kwh(0.5), note: "So far today" });
    expect(ext.days[0]).toMatchObject({ state: "data", note: null });
    expect(ext.days[18]).toMatchObject({ state: "future", note: null });
    expect(ext.total).toEqual({ kwh: 34.5, text: kwh(34.5), note: "So far", withoutData: 0 });
    // Fresh figures: the read time, with no note.
    expect(ext).toMatchObject({
      synthetic: true,
      stale: false,
      readAt: { at: "2026-11-18T11:30:00.000Z", label: null },
      problem: null,
    });
  });

  it("says So far and the days missing together for the current month", () => {
    const { model, ext } = month("2026-11", figures({ ...NOVEMBER, "2026-11-03": null }));
    // 32.5 kWh: the 34.5 above less the 2 kWh of the 3rd.
    expect(model.body.totals).toEqual({ usage: fmt.energy(32_500, { digits: 1 }), note: { t: "text", text: "So far · 1 day missing" } });
    expect(ext.total).toMatchObject({ kwh: 32.5, note: "So far · 1 day missing", withoutData: 1 });
    expect(TenantUsageMonthExt.safeParse(ext).success).toBe(true);
  });

  it("gives each day of the ext the note its row carries", () => {
    const { model, ext } = month("2026-11", figures(NOVEMBER), [link("m", "2026-11-10")]);
    for (const row of model.body.rows) {
      const shown = ext.days.find((d) => d.date === row.id)!;
      expect(shown.note, row.id).toBe(row.cells.note?.text ?? null);
    }
    expect(ext.days[0].note).toBe("No meter on this day");
    expect(ext.days[9].note).toBeNull();
    expect(ext.days[17].note).toBe("So far today");
    expect(ext.days[29].note).toBeNull();
  });

  it("shows a day a meter did not report as No data, never beside a figure, and totals the rest with the days missing", () => {
    const { model, ext } = month("2026-10", figures({ ...Object.fromEntries(datesOfMonth("2026-10").map((d) => [d, 1.2])), "2026-10-07": null, "2026-10-20": null }));
    const cells = cellsOf(model);
    expect(cells["2026-10-07"]).toEqual({ date: fmt.date("2026-10-07"), usage: { t: "text", text: "No data" } });
    expect(cells["2026-10-08"].usage).toEqual(fmt.energy(1200));
    for (const row of model.body.rows) {
      const texts = Object.values(row.cells).map((c) => c.text);
      expect(texts.includes("No data") && row.cells.usage.t === "energy", row.id).toBe(false);
    }
    // The 29 other days, never shown as the whole month's use (decided on mgm#210).
    expect(model.body.totals).toEqual({ usage: fmt.energy(34_800, { digits: 1 }), note: { t: "text", text: "2 days missing" } });
    expect(ext.total).toEqual({ kwh: 34.8, text: fmt.energy(34_800, { digits: 1 }).text, note: "2 days missing", withoutData: 2 });
    // A past month: no "So far", and the next month is there.
    expect(ext.next).toEqual({ month: "2026-11", label: "November 2026", href: "/my/usage?month=2026-11" });
  });

  it('says "1 day" for a single day without data', () => {
    const { ext } = month("2026-10", figures({ ...Object.fromEntries(datesOfMonth("2026-10").map((d) => [d, 1.2])), "2026-10-07": null }));
    expect(ext.total.note).toBe("1 day missing");
  });

  it("has no total, and says so, when no day of the month has a figure", () => {
    const { model, ext } = month("2026-10", figures(Object.fromEntries(datesOfMonth("2026-10").map((d) => [d, null]))));
    expect(model.body.totals).toEqual({ usage: { t: "text", text: "No data" }, note: { t: "text", text: "No data for 31 days" } });
    expect(ext.total).toEqual({ kwh: null, text: "No data", note: "No data for 31 days", withoutData: 31 });
  });

  it("marks the days no meter of the unit was in force, and shades only days with a figure", () => {
    const assignments = [link("m", "2026-10-10", "2026-10-20")];
    const values = Object.fromEntries(datesOfMonth("2026-10").filter((d) => d >= "2026-10-10" && d < "2026-10-20").map((d, i) => [d, i + 1]));
    const { model, ext } = month("2026-10", figures(values), assignments);
    const cells = cellsOf(model);
    expect(cells["2026-10-01"]).toEqual({
      date: fmt.date("2026-10-01"),
      usage: { t: "text", text: "No data" },
      note: { t: "text", text: "No meter on this day" },
    });
    expect(cells["2026-10-10"].usage).toEqual(fmt.energy(1000));
    expect(ext.days.map((d) => d.tier).filter((t) => t !== null)).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 4, 4]);
    expect(ext.days[0]).toMatchObject({ state: "no-meter", tier: null, text: "No data" });
    expect(ext.total).toMatchObject({ kwh: 55, withoutData: 0, note: "" });
  });

  it("shows the empty state, and no total, for a month with no meter of the unit", () => {
    const { model, ext } = month("2025-12", { kind: "none" });
    expect(model.body.rows).toEqual([]);
    expect(model.body).not.toHaveProperty("totals");
    expect(model.body.empty).toEqual({ title: "No data", text: "No meter of this unit was in use in this month." });
    expect(ext.days.every((d) => d.state === "no-meter")).toBe(true);
    expect(ext.readAt).toBeNull();
  });

  it.each([
    ["unavailable", TENANT_USAGE_PROBLEMS.unavailable],
    ["limited", TENANT_USAGE_PROBLEMS.limited],
    ["not-offered", TENANT_USAGE_PROBLEMS["not-offered"]],
  ] as const)("on a %s read shows every day with a meter as No data, says why, and has no total", (kind, copy) => {
    const { model, ext } = month("2026-11", { kind: "problem", problem: kind });
    expect(model.subtitle).toBe(`Unit 4 · ${copy.message}`);
    expect(model.body.rows.every((r) => r.cells.usage.text === "No data" && !r.cells.note)).toBe(true);
    expect(model.body.totals).toEqual({ usage: { t: "text", text: "No data" } });
    expect(ext.problem).toEqual({ kind, ...copy });
    expect(ext.total).toEqual({ kwh: null, text: "No data", note: "", withoutData: 18 });
  });

  it("suggests another try only for a problem another try can clear", () => {
    expect(TENANT_USAGE_PROBLEMS.unavailable.message).toContain("Try again");
    expect(TENANT_USAGE_PROBLEMS.limited.message).toContain("Try again");
    expect(TENANT_USAGE_PROBLEMS["not-offered"]).toEqual({
      title: "No data",
      message: "Your meter readings are not available here.",
    });
    expect(TENANT_USAGE_PROBLEMS["not-offered"].message).not.toMatch(/try|again|minute/i);
  });

  it("names the read time of kept figures in the unit's zone", () => {
    const { model, ext } = month("2026-11", figures(NOVEMBER, Date.parse("2026-11-18T11:05:00Z"), true));
    expect(model.subtitle).toBe("Unit 4 · As read at 14:05.");
    expect(ext).toMatchObject({ stale: true, readAt: { at: "2026-11-18T11:05:00.000Z", label: "As read at 14:05." } });
    expect(TenantUsageMonthExt.safeParse(ext).success).toBe(true);
  });

  it("has no read time in the ext when nothing was read", () => {
    expect(month("2026-11", { kind: "problem", problem: "limited" }).ext.readAt).toBeNull();
  });

  it("links the days and the months around it, naming the unit only for a person with several", () => {
    const one = month("2026-10", figures({}), undefined).ext;
    expect(one.href).toBe("/my/usage?month=2026-10");
    expect(one.previous).toEqual({ month: "2026-09", label: "September 2026", href: "/my/usage?month=2026-09" });
    expect(one.days[0].href).toBe("/my/usage/day?date=2026-10-01");
    const several = month("2026-10", figures({}), undefined, { links: SEVERAL }).ext;
    expect(several.href).toBe(`/my/usage?month=2026-10&unit=${UNIT}`);
    expect(several.previous?.href).toBe(`/my/usage?month=2026-09&unit=${UNIT}`);
    expect(several.next?.href).toBe(`/my/usage?month=2026-11&unit=${UNIT}`);
    expect(several.days[0].href).toBe(`/my/usage/day?date=2026-10-01&unit=${UNIT}`);
  });

  it("has no previous month at the earliest month, and starts the grid on the 1st's weekday", () => {
    expect(month("2000-01", { kind: "none" }).ext.previous).toBeNull();
    // 1 November 2026 is a Sunday, 1 October 2026 a Thursday.
    expect(month("2026-11", { kind: "none" }).ext.firstWeekday).toBe(6);
    expect(month("2026-10", { kind: "none" }).ext.firstWeekday).toBe(3);
  });
});

describe("the day model", () => {
  const hours = localHourStarts(TODAY, KAMPALA);
  /** Every hour of today up to 14:00 read at 0.085 kWh; 14:00 so far at 0.04. */
  const TODAY_HOURS = Object.fromEntries(hours.filter((s) => s <= NOW).map((s) => [String(s), s === hours[14] ? 0.04 : 0.085]));

  it("lists the hours up to now with two decimals, and the hour that held the read so far", () => {
    const { model, ext } = day(TODAY, figures(TODAY_HOURS, NOW, false, true));
    expect(model.title).toMatch(/^Wednesday,? 18 November 2026$/);
    expect(model.subtitle).toBe("Unit 4");
    expect(model.body.columns.map((c) => [c.key, c.type])).toEqual([["hour", "text"], ["usage", "energy"], ["note", "text"]]);
    expect(model.body.rows.map((r) => r.id)).toEqual(hours.slice(0, 15).map((s) => new Date(s).toISOString()));
    expect(model.body.rows[0].cells).toEqual({ hour: { t: "text", text: "00:00" }, usage: fmt.energy(85, { digits: 2, synthetic: true }) });
    expect(model.body.rows[0].cells.usage.text).toBe(kwh(0.085, 2));
    expect(model.body.rows[14].cells).toEqual({
      hour: { t: "text", text: "14:00" },
      usage: fmt.energy(40, { digits: 2, synthetic: true }),
      note: { t: "text", text: "So far" },
    });
    // The total has the hours' two decimals.
    expect(model.body.totals).toEqual({ usage: fmt.energy(1230, { digits: 2, synthetic: true }), note: { t: "text", text: "So far" } });
    expect(ext.total.text).toBe(kwh(1.23, 2));
    expect(ext.hours[0].note).toBeNull();
    expect(ext.hours[14].note).toBe("So far");
    expect(ext.hours[15].note).toBeNull();
    expect(model.ext?.schema).toBe(TENANT_USAGE_DAY_EXT_SCHEMA);
    expect(TenantUsageDayExt.safeParse(ext).success).toBe(true);
    expect(ext.hours).toHaveLength(24);
    expect(ext.hours.slice(15).every((h) => h.state === "future" && h.text === "")).toBe(true);
    expect(ext.next).toBeNull();
    expect(ext.previous).toEqual({ date: "2026-11-17", label: "17 Nov 2026", href: "/my/usage/day?date=2026-11-17" });
    expect(ext.month).toEqual({ month: "2026-11", label: "November 2026", href: "/my/usage?month=2026-11" });
  });

  it("keeps a figure read part-way through an hour partial when served after it, and an hour begun since the read not read yet", () => {
    // Read at 13:59:30, served from the cache at 14:00:10.
    const readAt = Date.parse("2026-11-18T10:59:30Z");
    const read = Object.fromEntries(hours.filter((s) => s <= readAt).map((s) => [String(s), s === hours[13] ? 0.08 : 0.1]));
    const { model, computed, ext } = day(TODAY, figures(read, readAt), undefined, { nowMs: Date.parse("2026-11-18T11:00:10Z") });
    expect(computed.hours.slice(13, 15).map((h) => [h.state, h.kwh])).toEqual([["partial", 0.08], ["partial", null]]);
    expect(model.body.rows[13].cells).toMatchObject({ usage: fmt.energy(80, { digits: 2 }), note: { text: "So far" } });
    expect(model.body.rows[14].cells).toEqual({ hour: { t: "text", text: "14:00" }, usage: fmt.empty(), note: { t: "text", text: "Not read yet" } });
    expect(ext.hours[14].text).toBe(fmt.empty().text);
    expect(ext.hours.slice(12, 15).map((h) => h.note)).toEqual([null, "So far", "Not read yet"]);
    // Neither is missing: the total is the sum so far.
    expect(ext.total).toMatchObject({ kwh: 1.38, withoutData: 0, note: "So far" });
  });

  it("totals a day of small hours to the hours' decimals, never rounding them away to 0.0", () => {
    // Read at 03:30: 00:00 used 0.01 kWh, 01:00 0.03, and 02:00 and 03:00 so far none; 0.04 kWh in all.
    const nowMs = hours[3] + 30 * 60_000;
    const values = { [String(hours[0])]: 0.01, [String(hours[1])]: 0.03, [String(hours[2])]: 0, [String(hours[3])]: 0 };
    const { model, ext } = day(TODAY, figures(values, nowMs), undefined, { nowMs });
    expect(model.body.rows.map((r) => r.cells.usage.text)).toEqual([kwh(0.01, 2), kwh(0.03, 2), kwh(0, 2), kwh(0, 2)]);
    expect(model.body.totals).toEqual({ usage: fmt.energy(40, { digits: 2 }), note: { t: "text", text: "So far" } });
    expect(model.body.totals!.usage.text).toBe(kwh(0.04, 2));
    expect(model.body.totals!.usage.text).not.toBe(kwh(0, 1));
    expect(ext.total).toEqual({ kwh: 0.04, text: kwh(0.04, 2), note: "So far", withoutData: 0 });
  });

  it("names the stale read time in the ext as the subtitle does", () => {
    const readAt = Date.parse("2026-11-18T10:05:00Z");
    const { model, ext } = day(TODAY, figures(TODAY_HOURS, readAt, true));
    expect(model.subtitle).toBe("Unit 4 · As read at 13:05.");
    expect(ext.readAt).toEqual({ at: "2026-11-18T10:05:00.000Z", label: "As read at 13:05." });
    expect(TenantUsageDayExt.safeParse(ext).success).toBe(true);
  });

  it("shows an hour a meter did not report as No data, and totals the other hours with the hours missing", () => {
    const past = "2026-11-10";
    const values = Object.fromEntries(localHourStarts(past, KAMPALA).map((s, i) => [String(s), i >= 21 ? null : 0.1]));
    const { model, ext } = day(past, figures(values));
    expect(model.body.rows).toHaveLength(24);
    expect(model.body.rows[21].cells).toEqual({ hour: { t: "text", text: "21:00" }, usage: { t: "text", text: "No data" } });
    expect(model.body.totals).toEqual({ usage: fmt.energy(2_100, { digits: 2 }), note: { t: "text", text: "3 hours missing" } });
    expect(ext.total).toEqual({ kwh: 2.1, text: "2.10 kWh", note: "3 hours missing", withoutData: 3 });
    expect(ext.next).toEqual({ date: "2026-11-11", label: "11 Nov 2026", href: "/my/usage/day?date=2026-11-11" });
  });

  it("shows the empty state for a day no meter of the unit was in force, as for a day outside the assignment", () => {
    const { model, ext } = day("2026-11-10", { kind: "none" }, [link("m", "2026-11-15")]);
    expect(model.body.rows).toEqual([]);
    expect(model.body).not.toHaveProperty("totals");
    expect(model.body.empty).toEqual({ title: "No data", text: "No meter of this unit was in use on this day." });
    expect(ext.meters).toBe(0);
  });

  it("on a failed read shows every hour as No data and says why", () => {
    const { model, ext } = day("2026-11-17", { kind: "problem", problem: "unavailable" });
    expect(model.subtitle).toBe(`Unit 4 · ${TENANT_USAGE_PROBLEMS.unavailable.message}`);
    expect(model.body.rows.every((r) => r.cells.usage.text === "No data")).toBe(true);
    expect(ext.problem?.kind).toBe("unavailable");
  });

  it("tells the two 01:00 hours of a fall-back day apart by their offset, and leaves a 24-hour day's plain", () => {
    const zone = "America/New_York";
    const date = "2026-11-01";
    const starts = localHourStarts(date, zone);
    const values = Object.fromEntries(starts.map((s) => [String(s), 0.1]));
    const nowMs = Date.parse("2026-11-03T12:00:00Z");
    const { model, ext } = day(date, figures(values, nowMs), undefined, { timezone: zone, today: "2026-11-03", nowMs });
    const labels = model.body.rows.map((r) => r.cells.hour.text);
    expect(labels).toHaveLength(25);
    expect(new Set(labels).size).toBe(25);
    expect(labels.slice(1, 3)).toEqual(["01:00 GMT-4", "01:00 GMT-5"]);
    expect(ext.hours.map((h) => h.label)).toEqual(labels);
    expect(TenantUsageDayExt.safeParse(ext).success).toBe(true);

    const plain = day("2026-11-02", figures({}, nowMs), undefined, { timezone: zone, today: "2026-11-03", nowMs });
    expect(plain.model.body.rows.map((r) => r.cells.hour.text).slice(0, 2)).toEqual(["00:00", "01:00"]);
  });

  it("names the unit in its hrefs only for a person with several, and has no previous day at the earliest", () => {
    const { ext } = day("2026-11-10", { kind: "none" }, undefined, { links: SEVERAL });
    expect(ext.href).toBe(`/my/usage/day?date=2026-11-10&unit=${UNIT}`);
    expect(ext.month.href).toBe(`/my/usage?month=2026-11&unit=${UNIT}`);
    expect(day("2000-01-01", { kind: "none" }).ext.previous).toBeNull();
  });
});

describe("the read time", () => {
  let zone: string | undefined;
  beforeEach(() => {
    zone = process.env.TZ;
    // The server's own zone, which must not show through.
    process.env.TZ = "America/Los_Angeles";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("is the unit's local time, whatever zone the server runs in", () => {
    const readAt = Date.parse("2026-11-18T11:05:00Z");
    expect(new Date(readAt).getHours()).toBe(3);
    expect(readTimeLabel(readAt, KAMPALA, LOCALE)).toBe("14:05");
    const { model } = month("2026-11", figures(NOVEMBER, readAt, true));
    expect(model.subtitle).toBe("Unit 4 · As read at 14:05.");
  });

  it("carries the offset on a day that is not 24 hours long", () => {
    expect(readTimeLabel(Date.parse("2026-11-01T05:30:00Z"), "America/New_York", LOCALE)).toBe("01:30 GMT-4");
    expect(readTimeLabel(Date.parse("2026-11-02T05:30:00Z"), "America/New_York", LOCALE)).toBe("00:30");
  });
});
