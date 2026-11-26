import { describe, expect, it } from "vitest";
import { addDaysToDateKey } from "@/lib/timezone/day-key";
import { MeteringError } from "../../errors";
import { LOW_BATTERY_PCT } from "../../site-operations";
import type { SiteSamples, SiteSamplesRequest, SiteSources } from "../../types";
import { CASES } from "../../__tests__/investigation-cases.pins";
import { CASE_DEVICES, caseDeviceId, caseEdgeId, caseMicrogridId } from "../case-ids";
import { PINNED_DAYS, pinnedDayKey, type PinnedDay, type PinnedWindow } from "../pinned-days";
import { generateSiteSamples, SITE_FIXTURE_SEED, siteScenario, type SiteScenario } from "../site-samples";

const KAMPALA = "Africa/Kampala";
const SERIES = ["batterySocPct", "batteryPowerW", "gridPowerW", "gridVoltageV", "loadPowerW", "pvPowerW"] as const;

/** Microgrids 01 to 14, hexadecimal. */
const NUMBERS = Array.from({ length: 0x14 }, (_, i) => (i + 1).toString(16).padStart(2, "0"));
const PINNABLE = NUMBERS.filter((nn) => parseInt(nn, 16) >= 0x0b);
const NOT_PINNABLE = NUMBERS.filter((nn) => parseInt(nn, 16) < 0x0b);

/**
 * The microgrid of surface/examples.ts (`MICROGRID`), which is server-only
 * and so not imported here. If that id changes, revisit.
 */
const EXAMPLES_MICROGRID = "00000000-0000-4000-8000-0000000000a1";
/** site-samples.test.ts's `MICROGRID`. If that id changes, revisit. */
const SITE_SAMPLES_TEST_MICROGRID = "microgrid-synthetic";

const ENTRIES = Object.entries(PINNED_DAYS).map(([key, pin]) => {
  const [microgridId, date] = key.split("|");
  const nn = microgridId.slice(-2);
  return { key, label: `microgrid ${nn}, ${date}`, microgridId, date, nn, pin };
});

/** Every device of a case microgrid on its synthetic edge, with all three tenant meters. */
function caseSources(nn: string): SiteSources {
  const device = (dd: string) => ({
    id: caseDeviceId(nn, dd),
    edgeOpenemsId: caseEdgeId(nn),
    componentId: CASE_DEVICES.find((d) => d.dd === dd)!.componentId,
  });
  return {
    battery: device("01"),
    gridMeter: device("02"),
    load: device("03"),
    pv: device("04"),
    houseMeters: CASE_DEVICES.filter((d) => d.tenantLinked).map((d) => device(d.dd)),
    houseMetersUnreadable: 0,
  };
}

function request(microgridId: string, sources: SiteSources, startDate: string, endDate: string): SiteSamplesRequest {
  return { microgridId, sources, startDate, endDate, timezone: KAMPALA, resolutionMinutes: 5 };
}

const caseRequest = (nn: string, startDate: string, endDate: string) =>
  request(caseMicrogridId(nn), caseSources(nn), startDate, endDate);

/** The day's read window, as `getSiteDay` asks for it: the day before and the day. */
const readWindow = (nn: string, date: string) => caseRequest(nn, addDaysToDateKey(date, -1), date);

const clock = new Intl.DateTimeFormat("en-CA", {
  timeZone: KAMPALA,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
function localTime(ms: number): { date: string; minute: number } {
  const p = Object.fromEntries(clock.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

const inWindow = (minute: number, [start, end]: PinnedWindow) => minute >= start && minute < end;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw");
}

describe("existing pins", () => {
  // The first day from 1 January 2026 that the generator gives each
  // scenario on the examples' microgrid, as surface/examples.ts's `dayOf`
  // picks them. If that rule changes, revisit.
  const SCENARIOS: SiteScenario[] = ["clear", "evening-cut", "long-cut-dark", "floor-at-dawn", "gateway-gap"];
  const exampleDays = SCENARIOS.map((scenario) => {
    for (let i = 0; i < 366; i++) {
      const date = addDaysToDateKey("2026-01-01", i);
      if (siteScenario(SITE_FIXTURE_SEED, EXAMPLES_MICROGRID, date) === scenario) return { scenario, date };
    }
    throw new Error(`no ${scenario} day in 2026`);
  });
  const existing = CASES.filter((c) => NOT_PINNABLE.includes(c.microgrid));

  it("covers C01 to C14", () => {
    expect(existing.map((c) => c.id)).toEqual(
      Array.from({ length: 14 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`)
    );
  });

  it.each(existing)("$id keeps its scenario and its samples", (c) => {
    expect(siteScenario(SITE_FIXTURE_SEED, caseMicrogridId(c.microgrid), c.date)).toBe(c.scenario);
    const window = readWindow(c.microgrid, c.date);
    expect(generateSiteSamples(window)).toEqual(generateSiteSamples(window, SITE_FIXTURE_SEED, {}));
  });

  it.each(exampleDays)("the examples' $scenario day ($date) keeps its samples", ({ date }) => {
    const window = request(EXAMPLES_MICROGRID, caseSources("01"), addDaysToDateKey(date, -1), date);
    expect(generateSiteSamples(window)).toEqual(generateSiteSamples(window, SITE_FIXTURE_SEED, {}));
  });
});

describe("the table", () => {
  it("lists only microgrids 0b to 14", () => {
    const allowed = new Set(PINNABLE.map(caseMicrogridId));
    const refused = new Set([...NOT_PINNABLE.map(caseMicrogridId), EXAMPLES_MICROGRID, SITE_SAMPLES_TEST_MICROGRID]);
    for (const { key, microgridId, date } of ENTRIES) {
      expect(allowed.has(microgridId), key).toBe(true);
      expect(refused.has(microgridId), key).toBe(false);
      expect(date, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("overlays only the tenant meters of the day's own microgrid", () => {
    for (const { key, nn, pin } of ENTRIES) {
      const meters = CASE_DEVICES.filter((d) => d.tenantLinked).map((d) => caseDeviceId(nn, d.dd));
      for (const id of Object.keys(pin.meters ?? {})) expect(meters, key).toContain(id);
    }
  });

  it("pins each case's day, and C21's day before, on a clear base day", () => {
    for (const { key, microgridId, date } of ENTRIES) {
      expect(siteScenario(SITE_FIXTURE_SEED, microgridId, date), key).toBe("clear");
    }
    // Every pending case's day is pinned, on the case's own microgrid.
    for (const c of CASES.filter((x) => PINNABLE.includes(x.microgrid))) {
      expect(PINNED_DAYS[pinnedDayKey(caseMicrogridId(c.microgrid), c.date)], c.id).toBeDefined();
    }
  });
});

/** The value a pinned day's mask gives a series in a bin, or `base` outside it. */
function masked(pin: PinnedDay, minute: number, base: number | null): number | null {
  return pin.gatewayDown?.some((w) => inWindow(minute, w)) ? null : base;
}

describe("masks", () => {
  const masks = ENTRIES.filter(({ pin }) => !pin.refuse);

  // Over the day's read window, so C21's day, whose window holds its pinned
  // day before, is checked against both.
  it.each(masks)("$label changes only what its mask covers", ({ microgridId, nn, date, pin }) => {
    const window = readWindow(nn, date);
    const base = generateSiteSamples(window, SITE_FIXTURE_SEED, {});
    const pinned = generateSiteSamples(window);
    // By timestamp, not by index: dropped bins shorten the pinned arrays.
    const at = new Map(pinned.timestamps.map((t, i) => [t, i]));
    const references = new Map<string, number>();
    let changed = 0;
    let dropped = 0;
    base.timestamps.forEach((t, b) => {
      const local = localTime(t);
      const dayPin: PinnedDay = PINNED_DAYS[pinnedDayKey(microgridId, local.date)] ?? {};
      const p = at.get(t);
      if (dayPin.dropTimestamps && inWindow(local.minute, dayPin.dropTimestamps)) {
        expect(p, `${t} dropped`).toBeUndefined();
        dropped += 1;
        return;
      }
      expect(p, `${t} kept`).toBeDefined();
      for (const series of SERIES) {
        const want = masked(dayPin, local.minute, base[series][b]);
        expect(pinned[series][p!], `${series} ${local.date} ${local.minute}`).toBe(want);
        if (want !== base[series][b]) changed += 1;
      }
      for (const [id, values] of Object.entries(base.houseEnergyWh)) {
        let want = values[b];
        const overlay = dayPin.meters?.[id];
        if (overlay && "silent" in overlay && inWindow(local.minute, overlay.silent)) want = null;
        if (overlay && !("silent" in overlay)) {
          const from = "resetAt" in overlay ? overlay.resetAt : overlay.holdFrom;
          const key = `${local.date}|${id}`;
          if (local.minute >= from) {
            if (!references.has(key)) references.set(key, values[b] as number);
            const reference = references.get(key)!;
            want = want === null ? null : "resetAt" in overlay ? want - reference : reference;
          }
        }
        want = masked(dayPin, local.minute, want);
        expect(pinned.houseEnergyWh[id][p!], `${id} ${local.date} ${local.minute}`).toBe(want);
        if (want !== values[b]) changed += 1;
      }
    });
    expect(changed + dropped).toBeGreaterThan(0);
    expect(base.unreadableTimestamps).toBeUndefined();
    expect(pinned.unreadableTimestamps).toBe(pin.dropTimestamps ? dropped : undefined);
  });

  it("drops 30 bins on C18's day, counted only in a window that holds it", () => {
    const date = "2026-09-06";
    const count = (startDate: string, endDate: string) =>
      generateSiteSamples(caseRequest("0e", startDate, endDate)).unreadableTimestamps;
    expect(count(addDaysToDateKey(date, -1), date)).toBe(30);
    expect(count(date, addDaysToDateKey(date, 1))).toBe(30);
    expect(count(addDaysToDateKey(date, -2), addDaysToDateKey(date, -1))).toBeUndefined();
    expect(count(addDaysToDateKey(date, 1), addDaysToDateKey(date, 2))).toBeUndefined();
  });

  // A gap whose last SoC is above the floor is no data, not inferred dark
  // (computeSiteDay in site-operations.ts), which C16 and C21 expect.
  it.each([
    { case: "C16", nn: "0c", date: "2026-09-04", before: "2026-09-04", minute: 23 * 60 + 15, soc: 23.6 },
    { case: "C21", nn: "11", date: "2026-09-02", before: "2026-09-01", minute: 22 * 60 + 55, soc: 26.1 },
  ])("$case's gap starts with the battery above its floor", ({ nn, date, before, minute, soc }) => {
    const samples: SiteSamples = generateSiteSamples(readWindow(nn, date));
    const i = samples.timestamps.findIndex((t) => {
      const local = localTime(t);
      return local.date === before && local.minute === minute;
    });
    expect(samples.batterySocPct[i]).toBe(soc);
    expect(soc).toBeGreaterThan(LOW_BATTERY_PCT);
    expect(samples.loadPowerW[i + 1]).toBeNull();
  });
});

describe("refusals", () => {
  const refusals = ENTRIES.filter(({ pin }) => pin.refuse);

  it("refuses C19, C20 and C24's days", () => {
    expect(refusals.map(({ nn, date }) => `${nn} ${date}`)).toEqual(["0f 2026-09-04", "10 2026-09-02", "14 2026-09-03"]);
  });

  it.each(refusals)("$label refuses every window that holds it, and no other", ({ nn, date, pin }) => {
    for (const [start, end] of [
      [addDaysToDateKey(date, -1), date],
      [date, addDaysToDateKey(date, 1)],
    ]) {
      const error = thrown(() => generateSiteSamples(caseRequest(nn, start, end)));
      expect(error).toBeInstanceOf(MeteringError);
      expect({ code: (error as MeteringError).code, status: (error as MeteringError).statusCode }).toEqual({
        code: pin.refuse!.code,
        status: pin.refuse!.status,
      });
    }
    expect(() => generateSiteSamples(caseRequest(nn, addDaysToDateKey(date, -2), addDaysToDateKey(date, -1)))).not.toThrow();
    expect(() => generateSiteSamples(caseRequest(nn, addDaysToDateKey(date, 1), addDaysToDateKey(date, 2)))).not.toThrow();
  });
});
