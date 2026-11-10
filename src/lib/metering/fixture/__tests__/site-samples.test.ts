import { describe, expect, it } from "vitest";
import { addDaysToDateKey } from "@/lib/timezone/day-key";
import { computeSiteDay } from "../../site-operations";
import type { SiteSamplesRequest, SiteSources } from "../../types";
import {
  SITE_FIXTURE_SEED,
  generateSiteSamples,
  siteScenario,
  type SiteScenario,
} from "../site-samples";

const edge = "SYNTHETIC-EDGE-001";
// componentId differs from id so a test can tell which one keys a series.
const device = (id: string) => ({ id, edgeOpenemsId: edge, componentId: `meter-${id}` });
const SOURCES: SiteSources = {
  battery: device("battery"),
  gridMeter: device("grid"),
  load: device("load"),
  pv: null,
  houseMeters: [device("house-a"), device("house-b")],
  houseMetersUnreadable: 0,
};
const MICROGRID = "microgrid-synthetic";

function request(overrides: Partial<SiteSamplesRequest> = {}): SiteSamplesRequest {
  return {
    microgridId: MICROGRID,
    sources: SOURCES,
    startDate: "2026-06-09",
    endDate: "2026-06-10",
    timezone: "Africa/Kampala",
    resolutionMinutes: 5,
    ...overrides,
  };
}

const SERIES = [
  "batterySocPct",
  "batteryPowerW",
  "gridPowerW",
  "gridVoltageV",
  "loadPowerW",
  "pvPowerW",
] as const;

/** The day as the Operations view works it out, read in full. */
function dayOf(date: string, timezone = "Africa/Kampala") {
  const samples = generateSiteSamples(
    request({ startDate: addDaysToDateKey(date, -1), endDate: date, timezone })
  );
  return computeSiteDay({
    date,
    timezone,
    samples,
    sources: {
      battery: true,
      gridMeter: true,
      load: true,
      pv: false,
      houses: true,
      houseMetersUnreadable: 0,
    },
    resolutionMinutes: 5,
    nowMs: Date.parse("2030-01-01T00:00:00Z"),
  });
}

/** Every date in 2026 that follows each scenario. */
const DATES = Array.from({ length: 365 }, (_, i) => addDaysToDateKey("2026-01-01", i));
const byScenario = new Map<SiteScenario, string[]>();
for (const date of DATES) {
  const scenario = siteScenario(SITE_FIXTURE_SEED, MICROGRID, date);
  byScenario.set(scenario, [...(byScenario.get(scenario) ?? []), date]);
}

describe("generateSiteSamples", () => {
  it("gives the same samples for the same inputs", () => {
    expect(generateSiteSamples(request())).toEqual(generateSiteSamples(request()));
  });

  it("changes with the seed, the microgrid and the date", () => {
    const base = generateSiteSamples(request());
    expect(generateSiteSamples(request(), "another-seed")).not.toEqual(base);
    // Not only the house counters: the seed drives the day itself.
    expect(generateSiteSamples(request(), "another-seed").loadPowerW).not.toEqual(base.loadPowerW);
    const scenarioMoves = (date: string) =>
      siteScenario("another-seed", MICROGRID, date) !== siteScenario(SITE_FIXTURE_SEED, MICROGRID, date);
    expect(DATES.some(scenarioMoves)).toBe(true);
    expect(generateSiteSamples(request({ microgridId: "microgrid-other" }))).not.toEqual(base);
    expect(
      generateSiteSamples(request({ startDate: "2026-06-10", endDate: "2026-06-11" })).loadPowerW
    ).not.toEqual(base.loadPowerW);
  });

  it("gives a day the same samples whatever window it is read in", () => {
    const two = generateSiteSamples(request());
    const one = generateSiteSamples(request({ startDate: "2026-06-10" }));
    const from = two.timestamps.indexOf(one.timestamps[0]);
    expect(from).toBe(288);
    expect(two.loadPowerW.slice(from)).toEqual(one.loadPowerW);
    expect(two.batterySocPct.slice(from)).toEqual(one.batterySocPct);
    expect(two.houseEnergyWh["house-a"].slice(from)).toEqual(one.houseEnergyWh["house-a"]);
  });

  it("aligns every series with timestamps on local 5-minute boundaries", () => {
    const samples = generateSiteSamples(request());
    expect(samples.timestamps).toHaveLength(2 * 288);
    for (const key of SERIES) expect(samples[key]).toHaveLength(samples.timestamps.length);
    for (const series of Object.values(samples.houseEnergyWh)) {
      expect(series).toHaveLength(samples.timestamps.length);
    }
    expect(samples.timestamps[0]).toBe(Date.parse("2026-06-08T21:00:00Z"));
    samples.timestamps.forEach((t, i) => {
      if (i > 0) expect(t - samples.timestamps[i - 1]).toBe(5 * 60_000);
    });
  });

  it("bins a DST day by local midnights in the site's zone", () => {
    const zone = "America/New_York";
    const fallBack = generateSiteSamples(
      request({ timezone: zone, startDate: "2026-11-01", endDate: "2026-11-01" })
    );
    expect(fallBack.timestamps).toHaveLength(300);
    expect(fallBack.timestamps[0]).toBe(Date.parse("2026-11-01T04:00:00Z"));
    const springForward = generateSiteSamples(
      request({ timezone: zone, startDate: "2026-03-08", endDate: "2026-03-08" })
    );
    expect(springForward.timestamps).toHaveLength(276);
    const minutes = new Intl.DateTimeFormat("en-US", { timeZone: zone, minute: "2-digit" });
    for (const t of [...fallBack.timestamps, ...springForward.timestamps]) {
      expect(Number(minutes.format(t)) % 5).toBe(0);
    }
    expect(
      generateSiteSamples(request({ startDate: "2026-11-01", endDate: "2026-11-01" })).timestamps
    ).toHaveLength(288);
  });

  it("works out a DST day without error", () => {
    const day = dayOf("2026-11-01", "America/New_York");
    expect(day.dayEndMs - day.dayStartMs).toBe(25 * 3_600_000);
    expect(day.soc).toHaveLength(300);
  });

  it("gives all-null series for a source the request does not have, never zeros", () => {
    const samples = generateSiteSamples(
      request({
        sources: { ...SOURCES, battery: null, gridMeter: null, houseMeters: [] },
      })
    );
    for (const key of ["batterySocPct", "batteryPowerW", "gridPowerW", "gridVoltageV", "pvPowerW"] as const) {
      expect(samples[key].every((v) => v === null)).toBe(true);
    }
    expect(samples.loadPowerW.some((v) => v !== null)).toBe(true);
    expect(samples.houseEnergyWh).toEqual({});
    const noLoad = generateSiteSamples(request({ sources: { ...SOURCES, load: null } }));
    expect(noLoad.loadPowerW.every((v) => v === null)).toBe(true);
    expect(noLoad.batterySocPct.some((v) => v !== null)).toBe(true);
  });

  it("keys house series by the requested meter ids, with counters that never go back", () => {
    const samples = generateSiteSamples(request({ startDate: "2026-01-01", endDate: "2026-01-20" }));
    expect(Object.keys(samples.houseEnergyWh).sort()).toEqual(["house-a", "house-b"]);
    for (const series of Object.values(samples.houseEnergyWh)) {
      const read = series.filter((v): v is number => v !== null);
      expect(read.length).toBeGreaterThan(0);
      read.forEach((v, i) => {
        if (i > 0) expect(v).toBeGreaterThanOrEqual(read[i - 1]);
      });
    }
  });

  it("refuses a resolution that does not divide an hour", () => {
    expect(() => generateSiteSamples(request({ resolutionMinutes: 7 }))).toThrow(RangeError);
  });
});

/** One day's raw samples, as dayOf reads them. */
const samplesOf = (date: string) =>
  generateSiteSamples(request({ startDate: addDaysToDateKey(date, -1), endDate: date }));

/** Wherever the load reads null, every series reads null, house counters included. */
function expectGapsInEverySeries(date: string) {
  const samples = samplesOf(date);
  const gaps = samples.loadPowerW.flatMap((v, i) => (v === null ? [i] : []));
  expect(gaps.length, date).toBeGreaterThan(0);
  for (const i of gaps) {
    for (const key of SERIES) expect(samples[key][i], `${date} ${key} ${i}`).toBeNull();
    for (const [id, series] of Object.entries(samples.houseEnergyWh)) {
      expect(series[i], `${date} ${id} ${i}`).toBeNull();
    }
  }
}

describe("the scenarios, as the Operations view reads them", () => {
  it("assigns every scenario to some days of a year", () => {
    expect([...byScenario.keys()].sort()).toEqual(
      ["clear", "evening-cut", "floor-at-dawn", "gateway-gap", "long-cut-dark"]
    );
  });

  it("clear: no cut, no dark time, no missing data", () => {
    for (const date of byScenario.get("clear")!) {
      const day = dayOf(date);
      expect(day.cuts, date).toEqual([]);
      expect(day.darkMinutes, date).toBe(0);
      expect(day.noDataMinutes, date).toBe(0);
    }
  });

  it("evening-cut: a cut in the evening and no dark time", () => {
    for (const date of byScenario.get("evening-cut")!) {
      const day = dayOf(date);
      expect(day.cuts!.length, date).toBeGreaterThanOrEqual(1);
      expect(day.cutMinutes, date).toBe(90);
      expect(day.darkMinutes, date).toBe(0);
      expect(day.housesEveningKwh, date).toBeGreaterThan(0);
    }
  });

  it("in a cut the grid carries nothing while its voltage reads 0", () => {
    const dates = [
      ...byScenario.get("evening-cut")!.slice(0, 5),
      ...byScenario.get("long-cut-dark")!.slice(0, 5),
    ];
    for (const date of dates) {
      const samples = samplesOf(date);
      const cut = samples.gridVoltageV.flatMap((v, i) => (v === 0 ? [i] : []));
      expect(cut.length, date).toBeGreaterThan(0);
      for (const i of cut) expect(samples.gridPowerW[i], `${date} ${i}`).toBe(0);
    }
  });

  it("long-cut-dark: the battery reaches its floor in a cut and the houses go dark", () => {
    for (const date of byScenario.get("long-cut-dark")!) {
      const day = dayOf(date);
      expect(day.darkMinutes, date).toBeGreaterThan(0);
      expect(day.darkInferredMinutes, date).toBe(0);
      expect(day.cutMinutes, date).toBe(240);
    }
    for (const date of byScenario.get("long-cut-dark")!.slice(0, 5)) expectGapsInEverySeries(date);
  });

  it("floor-at-dawn: a gap at the floor with the grid not known to be off is inferred dark", () => {
    for (const date of byScenario.get("floor-at-dawn")!) {
      const day = dayOf(date);
      expect(day.darkInferredMinutes, date).toBeGreaterThan(0);
    }
  });

  it("gateway-gap: missing data with the grid on, not dark", () => {
    for (const date of byScenario.get("gateway-gap")!) {
      const day = dayOf(date);
      expect(day.noDataMinutes, date).toBe(45);
      expect(day.darkMinutes, date).toBe(0);
    }
    for (const date of byScenario.get("gateway-gap")!.slice(0, 5)) expectGapsInEverySeries(date);
  });
});
