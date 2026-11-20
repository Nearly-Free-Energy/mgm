/**
 * The tenant usage renderer's reader: which exts it accepts, which it
 * refuses so the kit's view draws the model, and the join of each ext to its
 * rows, which holds one to one or not at all.
 */
import { describe, expect, it } from "vitest";
import type { Json } from "@/lib/gui/contract";
import { pageHref, readUsageDay, readUsageDayExt, readUsageMonth, readUsageMonthExt } from "../ext";
import { dayModel, mismatch, monthModel, withExt } from "./usage-fixture";

const MONTHS = {
  "the current month": monthModel(),
  "a synthetic month": monthModel({ synthetic: true }),
  "a stale read": monthModel({ stale: true }),
  "a failed read": monthModel({ problem: "unavailable" }),
  "a read over the limit": monthModel({ problem: "limited" }),
  "nothing to read": monthModel({ problem: "not-offered" }),
  "a day not read": monthModel({ gap: true }),
  "days before the first meter": monthModel({ meterFrom: 5 }),
  "a month with no meter": monthModel({ noMeter: true }),
  "a past month": monthModel({ month: "2026-09" }),
  "the earliest month": monthModel({ previous: null }),
  "a person with several units": monthModel({ several: true }),
};
const DAYS = {
  today: dayModel(),
  "a 23-hour day": dayModel({ zone: "dst23" }),
  "a 25-hour day": dayModel({ zone: "dst25" }),
  "a day with no meter": dayModel({ meters: 0 }),
  "a failed read": dayModel({ problem: "unavailable" }),
  "a person with several units": dayModel({ several: true }),
  "a synthetic day": dayModel({ synthetic: true }),
};

const days = (model = monthModel()) => (model.ext!.data as { days: Record<string, Json>[] }).days;
const hours = (model = dayModel()) => (model.ext!.data as { hours: Record<string, Json>[] }).hours;
const withDay = (i: number, fields: Record<string, Json>) => withExt(monthModel(), { days: days().map((d, j) => (j === i ? { ...d, ...fields } : d)) });
const withHour = (i: number, fields: Record<string, Json>) => withExt(dayModel(), { hours: hours().map((h, j) => (j === i ? { ...h, ...fields } : h)) });

describe("the month reader", () => {
  it.each(Object.entries(MONTHS))("reads and joins %s", (_, model) => {
    const read = readUsageMonth(model);
    expect(read).not.toBeNull();
    for (const row of model.body.rows) expect(read!.rowOf(row.id)).toBe(row);
  });

  it("reads the calendar as the server sends it", () => {
    const ext = readUsageMonthExt(monthModel().ext)!;
    expect(ext).toMatchObject({ month: "2026-11", title: "November 2026", firstWeekday: 6, next: null, problem: null });
    expect(ext.days).toHaveLength(30);
    expect(ext.days[17]).toMatchObject({ date: "2026-11-18", state: "partial", href: "/my/usage/day?date=2026-11-18" });
    expect(ext.days[18]).toMatchObject({ state: "future", href: null });
    expect(ext.previous).toEqual({ label: "October 2026", href: "/my/usage?month=2026-10" });
    expect(readUsageMonthExt(monthModel({ problem: "limited" }).ext)!.problem).toMatchObject({ kind: "limited", title: "No data" });
  });

  it.each([
    ["no ext data", { days: undefined }],
    ["a missing title", { title: undefined }],
    ["a first weekday of 7", { firstWeekday: 7 }],
    ["a first weekday that is not whole", { firstWeekday: 1.5 }],
    ["27 days", { days: days().slice(0, 27) }],
    ["32 days", { days: [...days(), ...days().slice(0, 2)] }],
    ["a missing total", { total: undefined }],
    ["a total without its note", { total: { text: "No data" } }],
    ["a synthetic flag that is not a boolean", { synthetic: "yes" }],
    ["a stale flag that is missing", { stale: undefined }],
    ["a problem without its message", { problem: { kind: "unavailable", title: "No data" } }],
    ["a problem of a kind it does not know", { problem: { kind: "offline", title: "No data", message: "Off" } }],
    ["an outside previous href", { previous: { month: "2026-10", label: "October 2026", href: "https://x.test/my/usage" } }],
    ["a protocol-relative next href", { next: { month: "2026-12", label: "December 2026", href: "//x.test" } }],
    ["a previous step without its label", { previous: { month: "2026-10", href: "/my/usage?month=2026-10" } }],
  ])("reads no month ext with %s", (_, data) => {
    expect(readUsageMonthExt(withExt(monthModel(), data).ext)).toBeNull();
  });

  it.each([
    ["an unknown state", 3, { state: "pending" }],
    ["tier 0", 3, { tier: 0 }],
    ["tier 5", 3, { tier: 5 }],
    ["a day out of order", 3, { day: 5 }],
    ["a date in another month", 3, { date: "2026-10-04" }],
    ["a backslash href", 3, { href: "/\\x.test" }],
    ["a past day with no href", 3, { href: null }],
    ["a figure text that is missing", 3, { text: null }],
  ])("reads no month ext with %s", (_, i, fields) => {
    expect(readUsageMonthExt(withDay(i, fields).ext)).toBeNull();
  });

  it.each(["missing", "extra", "future", "duplicate"] as const)("joins no month whose rows have a %s row", (how) => {
    expect(readUsageMonth(mismatch(monthModel(), how))).toBeNull();
  });

  it("joins no month whose row carries actions of its own, or lacks its figure", () => {
    const model = monthModel();
    const [first, ...rest] = model.body.rows;
    const ref = { action: "acme.poke" as const, params: {}, label: "Poke", enabled: true };
    expect(readUsageMonth({ ...model, body: { ...model.body, rows: [{ ...first, actions: [ref] }, ...rest] } })).toBeNull();
    expect(readUsageMonth({ ...model, body: { ...model.body, rows: [{ ...first, cells: { date: first.cells.date } }, ...rest] } })).toBeNull();
  });

  it("joins a month with no rows", () => {
    expect(readUsageMonth(monthModel({ noMeter: true }))).not.toBeNull();
  });

  it("reads nothing from a model of another kind", () => {
    const model = monthModel();
    expect(readUsageMonth({ ...model, kind: "record", body: { sections: [] } })).toBeNull();
  });
});

describe("the day reader", () => {
  it.each(Object.entries(DAYS))("reads and joins %s", (_, model) => {
    const read = readUsageDay(model);
    expect(read).not.toBeNull();
    for (const row of model.body.rows) expect(read!.rowOf(row.id)).toBe(row);
  });

  it("reads 23, 24 and 25 hours with the server's labels", () => {
    expect(readUsageDayExt(dayModel({ zone: "dst23" }).ext)!.hours).toHaveLength(23);
    expect(readUsageDayExt(dayModel().ext)!.hours).toHaveLength(24);
    const long = readUsageDayExt(dayModel({ zone: "dst25" }).ext)!;
    expect(long.hours).toHaveLength(25);
    expect(long.hours.slice(1, 3).map((h) => h.label)).toEqual(["01:00 GMT-4", "01:00 GMT-5"]);
    expect(long.month).toEqual({ label: "November 2026", href: "/my/usage?month=2026-11" });
  });

  it("keys each hour by its instant as the server writes it", () => {
    const model = withHour(0, { start: "2026-11-18T00:00:00+03:00" });
    expect(readUsageDayExt(model.ext)!.hours[0].start).toBe("2026-11-17T21:00:00.000Z");
  });

  it.each([
    ["22 hours", { hours: hours().slice(0, 22) }],
    ["26 hours", { hours: [...hours(), ...hours().slice(0, 2)] }],
    ["no month step", { month: undefined }],
    ["an outside month href", { month: { month: "2026-11", label: "November 2026", href: "https://x.test/my/usage" } }],
    ["a meter count that is not a number", { meters: "1" }],
    ["a problem of a kind it does not know", { problem: { kind: "offline", title: "No data", message: "Off" } }],
  ])("reads no day ext with %s", (_, data) => {
    expect(readUsageDayExt(withExt(dayModel(), data).ext)).toBeNull();
  });

  it.each([
    ["a start that is not an instant", { start: "noon" }],
    ["a figure that is not a number", { kwh: "0.1" }],
    ["a negative figure", { kwh: -1 }],
    ["an unknown state", { state: "pending" }],
    ["a missing label", { label: null }],
  ])("reads no day ext with %s", (_, fields) => {
    expect(readUsageDayExt(withHour(2, fields).ext)).toBeNull();
  });

  it.each(["missing", "extra", "future", "duplicate"] as const)("joins no day whose rows have a %s row", (how) => {
    expect(readUsageDay(mismatch(dayModel(), how))).toBeNull();
  });
});

describe("pageHref", () => {
  it.each([
    ["/my/usage?month=2026-11", true],
    ["/my/usage/day?date=2026-11-18&unit=00000000-0000-4000-8000-0000000000b7", true],
    ["https://x.test/my", false],
    ["//x.test/my", false],
    ["/\\x.test", false],
    ["/my\nusage", false],
    ["my/usage", false],
    ["", false],
  ])("%s is a page link: %s", (href, ok) => {
    expect(pageHref(href)).toBe(ok ? href : null);
  });

  it("refuses what is not a string", () => {
    expect(pageHref(null)).toBeNull();
    expect(pageHref(undefined)).toBeNull();
    expect(pageHref(1)).toBeNull();
  });
});
