/**
 * createFmt against the format primitives. Expected text comes from the
 * primitives themselves rather than typed strings, because some locales
 * separate digits and units with no-break spaces.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCurrency, formatRate } from "@/components/format/currency";
import { formatKwh } from "@/components/format/kwh";
import { formatLocalDate } from "@/components/format/local-date";
import { LOCAL_DATE_TIME_OPTS } from "@/components/format/local-date-time";
import type { EntityRef, Value } from "../contract";
import { createFmt } from "../fmt";
import { valueSchema } from "../host/server/model-schema";
import { STATUS_MAPS, type StatusKind } from "../status-maps";
import type { Fmt } from "../surface";

const LOCALES = ["en", "fr-FR"] as const;
const AT = "2026-11-06T09:15:00Z";
const REF: EntityRef = { kind: "microgrid", id: "mg-1", label: "North site", href: "/microgrids/mg-1" };

/** One call of every builder, with and without its options. */
function everyBuilder(fmt: Fmt): Value[] {
  const flags = { at: AT, derived: true, synthetic: true } as const;
  return [
    fmt.text("Hello"),
    fmt.empty(),
    fmt.number(1234.567),
    fmt.number(42, "households"),
    fmt.percent(87.4),
    fmt.percent(87.4, { at: AT, synthetic: true }),
    fmt.money(4216800, "UGX"),
    fmt.money(4216800, "UGX", { bare: true }),
    fmt.money(12.34, "USD"),
    fmt.money(12.34, "USD", { bare: true }),
    fmt.energy(12345),
    fmt.energy(12345, { bare: true, ...flags }),
    fmt.power(850),
    fmt.power(850, flags),
    fmt.power(2500, flags),
    fmt.power(-1500),
    fmt.date("2026-11-06"),
    fmt.datetime(AT, "Africa/Kampala"),
    fmt.status("billingPeriod", "draft"),
    fmt.status("billingPeriod", "archived"),
    fmt.ref(REF),
  ];
}

describe.each(LOCALES)("createFmt in %s", (locale) => {
  const fmt = createFmt({ locale });

  it("builds text, empty and ref values", () => {
    expect(fmt.text("Hello")).toEqual({ t: "text", text: "Hello" });
    expect(fmt.empty()).toEqual({ t: "empty", text: formatLocalDate(null, locale) });
    expect(fmt.ref(REF)).toEqual({ t: "ref", ref: REF, text: "North site" });
  });

  it("formats numbers with up to two digits, and a unit only when given", () => {
    expect(fmt.number(1234.567)).toEqual({
      t: "number",
      v: 1234.567,
      text: formatRate(1234.567, locale, { minDigits: 0, maxDigits: 2 }),
    });
    expect(fmt.number(42, "households")).toEqual({
      t: "number",
      v: 42,
      unit: "households",
      text: `${formatRate(42, locale, { minDigits: 0, maxDigits: 2 })} households`,
    });
  });

  it("formats a percentage of 0 to 100 with no digits", () => {
    expect(fmt.percent(87.4)).toEqual({
      t: "percent",
      v: 87.4,
      text: `${formatRate(87.4, locale, { minDigits: 0, maxDigits: 0 })}%`,
    });
  });

  it("formats money as the currency primitive does, with v in minor units", () => {
    expect(fmt.money(4216800, "UGX")).toEqual({
      t: "money",
      v: 4216800,
      currency: "UGX",
      text: formatCurrency(4216800, locale, "UGX"),
    });
    expect(fmt.money(12.34, "USD")).toEqual({
      t: "money",
      v: 1234,
      currency: "USD",
      text: formatCurrency(12.34, locale, "USD"),
    });
  });

  it("gives a bare UGX amount the same text as the bareNumber primitive", () => {
    for (const amount of [4216800, 0, 1500.5, -2000]) {
      expect(fmt.money(amount, "UGX", { bare: true }).text).toBe(
        formatCurrency(amount, locale, "UGX", { bareNumber: true }),
      );
    }
  });

  it("keeps the cents of a bare USD amount", () => {
    const bare = fmt.money(12.34, "USD", { bare: true });
    expect(bare.text).toBe(formatRate(12.34, locale, { minDigits: 2, maxDigits: 2 }));
    expect(bare.text).not.toBe(formatCurrency(12.34, locale, "USD", { bareNumber: true }));
    expect(fmt.money(12.34, "USD")).toMatchObject({ v: 1234 });
    expect(fmt.money(0.29, "USD")).toMatchObject({ v: 29 });
  });

  it("rounds v half away from zero, as the text does", () => {
    expect(fmt.money(-2000.5, "UGX")).toEqual({
      t: "money",
      v: -2001,
      currency: "UGX",
      text: formatCurrency(-2000.5, locale, "UGX"),
    });
    expect(fmt.money(2000.5, "UGX")).toMatchObject({ v: 2001 });
    expect(fmt.money(-2000.5, "UGX", { bare: true }).text).toBe(
      formatCurrency(-2001, locale, "UGX", { bareNumber: true }),
    );
    expect(fmt.money(-0.015, "USD")).toMatchObject({ v: -2, text: formatCurrency(-0.02, locale, "USD") });
    expect(fmt.money(-0.001, "USD")).toMatchObject({ v: 0 }); // not -0
  });

  // Binary scaling gets these wrong: 1.005 * 100 is 100.49999999999999.
  it.each([1.005, 8.345, 10.075, -1.005, -8.345])("keeps v equal to the text's digits for %s USD", (amount) => {
    const money = fmt.money(amount, "USD");
    const bare = fmt.money(amount, "USD", { bare: true });
    if (money.t !== "money") throw new Error("fmt.money returned another kind of value");
    expect(Math.abs(money.v)).toBe(Number(bare.text.replace(/\D/g, "")));
    expect(Math.sign(money.v)).toBe(Math.sign(amount));
    expect(money.text).toBe(formatCurrency(money.v / 100, locale, "USD"));
  });

  it("scales an amount written in exponent form", () => {
    expect(fmt.money(1e21, "UGX")).toMatchObject({ v: 1e21 });
    expect(fmt.money(1.5e-7, "USD")).toMatchObject({ v: 0 });
    expect(fmt.money(5e-3, "USD")).toMatchObject({ v: 1 });
  });

  it("formats energy in kWh from watt-hours", () => {
    expect(fmt.energy(12345)).toEqual({
      t: "energy",
      v: 12.345,
      unit: "kWh",
      text: `${formatKwh(12.345, locale)} kWh`,
    });
    expect(fmt.energy(12345, { bare: true }).text).toBe(formatKwh(12.345, locale));
  });

  it("formats power in W below 1000 W and in kW from there", () => {
    const watts = (w: number) => `${formatRate(w, locale, { minDigits: 0, maxDigits: 0 })} W`;
    const kilowatts = (kw: number) => `${formatRate(kw, locale, { minDigits: 1, maxDigits: 1 })} kW`;
    expect(fmt.power(999)).toEqual({ t: "power", v: 999, unit: "W", text: watts(999) });
    expect(fmt.power(1000)).toEqual({ t: "power", v: 1, unit: "kW", text: kilowatts(1) });
    expect(fmt.power(2500)).toEqual({ t: "power", v: 2.5, unit: "kW", text: kilowatts(2.5) });
    expect(fmt.power(999.6)).toMatchObject({ unit: "kW", text: kilowatts(0.9996) });
    expect(fmt.power(-1500)).toMatchObject({ v: -1.5, unit: "kW", text: kilowatts(-1.5) });
    expect(fmt.power(-400)).toMatchObject({ v: -400, unit: "W", text: watts(-400) });
    expect(fmt.power(-999.5)).toMatchObject({ unit: "kW", text: kilowatts(-0.9995) });
    expect(fmt.power(999.5)).toMatchObject({ unit: "kW", text: kilowatts(0.9995) });
  });

  it("formats a date-time in the time zone it is given", () => {
    const iso = "2026-11-06T21:30:00Z";
    expect(fmt.datetime(iso, "Africa/Kampala")).toEqual({
      t: "datetime",
      v: iso,
      tz: "Africa/Kampala",
      text: formatLocalDate(iso, locale, { ...LOCAL_DATE_TIME_OPTS, timeZone: "Africa/Kampala" }),
    });
    expect(fmt.datetime(iso, "Africa/Kampala").text).not.toBe(fmt.datetime(iso, "UTC").text);
  });

  it("gives a known status its label and tone, and an unknown one itself in neutral", () => {
    expect(fmt.status("billingPeriod", "draft")).toEqual({ t: "status", v: "draft", tone: "warning", text: "Draft" });
    expect(fmt.status("billingPeriod", "archived")).toEqual({
      t: "status",
      v: "archived",
      tone: "neutral",
      text: "archived",
    });
    expect(fmt.status("billingPeriod", "toString")).toMatchObject({ tone: "neutral", text: "toString" });
    expect(fmt.status("nope" as StatusKind, "x")).toEqual({ t: "status", v: "x", tone: "neutral", text: "x" });
  });

  it("passes the meta flags through and leaves them out when unset", () => {
    const flags = { at: AT, derived: true, synthetic: true } as const;
    expect(fmt.energy(1000, flags)).toMatchObject(flags);
    expect(fmt.power(1000, flags)).toMatchObject(flags);
    expect(fmt.power(500, flags)).toMatchObject(flags);
    expect(fmt.percent(50, { at: AT, synthetic: true })).toMatchObject({ at: AT, synthetic: true });
    for (const value of [fmt.energy(1000), fmt.power(1000), fmt.percent(50), fmt.energy(1000, { at: undefined })]) {
      expect(Object.keys(value)).not.toContain("at");
      expect(Object.keys(value)).not.toContain("derived");
      expect(Object.keys(value)).not.toContain("synthetic");
    }
  });

  it("builds values the host's strict Value schema accepts", () => {
    for (const value of everyBuilder(fmt)) {
      expect(valueSchema.safeParse(value).error).toBeUndefined();
    }
    for (const [kind, map] of Object.entries(STATUS_MAPS)) {
      for (const status of Object.keys(map)) {
        expect(valueSchema.safeParse(fmt.status(kind as StatusKind, status)).error).toBeUndefined();
      }
    }
  });
});

describe("createFmt dates", () => {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it.each(LOCALES)("shows the given day in %s on a server west of UTC", (locale) => {
    // The process is west of UTC: midnight UTC on the 6th is still the 5th here.
    expect(new Date("2026-11-06T00:00:00Z").getDate()).toBe(5);
    const sixth = formatLocalDate("2026-11-06T12:00:00Z", locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    });
    expect(createFmt({ locale }).date("2026-11-06")).toEqual({ t: "date", v: "2026-11-06", text: sixth });
  });

  it("refuses anything but a calendar date", () => {
    const fmt = createFmt({ locale: "en" });
    for (const bad of ["2026-02-30", "2026-11-6", "2026-11-06T00:00:00Z", "", "06/11/2026"]) {
      expect(() => fmt.date(bad)).toThrow(RangeError);
    }
  });
});
