import { describe, expect, it } from "vitest";
import { addDaysToDateKey, startOfDayInZone } from "@/lib/timezone/day-key";
import { generateSiteSamples, siteScenario, SITE_FIXTURE_SEED } from "../fixture/site-samples";
import { mulberry32 } from "../fixture/random";
import {
  GRID_PRESENT_MIN_V,
  LOW_BATTERY_PCT,
  computeSiteDay,
  computeSiteDayDetail,
  type DecidingReading,
  type MinuteRange,
  type SiteDayDetail,
  type SiteDayInput,
  type SiteDayOperations,
  type SiteSourceAvailability,
} from "../site-operations";
import type { SiteSamples, SiteSources } from "../types";

const MINUTE = 60_000;
const BIN_MINUTES = 5;
const BIN_MS = BIN_MINUTES * MINUTE;
const KAMPALA = "Africa/Kampala";
/** The day of the evidence document's §4 example. */
const DATE = "2026-11-10";
/** 00:00 on 10 Nov 2026 in Kampala (UTC+3), the example's `t0`. */
const DAY_START = Date.parse("2026-11-09T21:00:00Z");

const ALL_SOURCES: SiteSourceAvailability = {
  battery: true,
  gridMeter: true,
  load: true,
  pv: false,
  houses: false,
  houseMetersUnreadable: 0,
};

type Row = { soc?: number | null; volts?: number | null; batteryW?: number | null; loadW?: number | null };

/**
 * Samples at the start of bin `pos` (negative in the previous day) for each
 * entry; a position without an entry is a gap. Each row has a load reading
 * unless it says otherwise, so a row with no voltage or SoC is still online.
 */
function samplesAt(rows: Map<number, Row>, dayStartMs = DAY_START): SiteSamples {
  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: {},
  };
  for (const pos of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(pos)!;
    out.timestamps.push(dayStartMs + pos * BIN_MS);
    out.batterySocPct.push(row.soc ?? null);
    out.batteryPowerW.push(row.batteryW ?? null);
    out.gridPowerW.push(null);
    out.gridVoltageV.push(row.volts ?? null);
    out.loadPowerW.push(row.loadW === undefined ? 300 : row.loadW);
    out.pvPowerW.push(null);
  }
  return out;
}

/** Fills bins [from, to] with `row`. */
function fill(rows: Map<number, Row>, from: number, to: number, row: Row) {
  for (let pos = from; pos <= to; pos++) rows.set(pos, row);
}

function detailOf(rows: Map<number, Row>) {
  return computeSiteDayDetail({
    date: DATE,
    timezone: KAMPALA,
    samples: samplesAt(rows),
    sources: ALL_SOURCES,
    resolutionMinutes: BIN_MINUTES,
    nowMs: DAY_START + 26 * 60 * MINUTE,
  });
}

const gridV = (pos: number, v: number): DecidingReading => ({ series: "gridV", pos, v });
const soc = (pos: number, v: number): DecidingReading => ({ series: "soc", pos, v });

describe("computeSiteDayDetail — the evidence document's §4 example", () => {
  // The previous day ends at 231.4 V and 14.8%; bins 0–18 are empty and bin
  // 19 reads the grid; bin 119 reads 229.8 V and 63% before an empty run at
  // 120–128; bin 227 reads 0 V before an empty run at 228–260; bin 261
  // reads the grid back.
  const rows = new Map<number, Row>();
  rows.set(-1, { volts: 231.4, soc: 14.8 });
  fill(rows, 19, 118, { volts: 230, soc: 50 });
  rows.set(119, { volts: 229.8, soc: 63 });
  fill(rows, 129, 226, { volts: 231, soc: 60 });
  rows.set(227, { volts: 0, soc: 58 });
  fill(rows, 261, 287, { volts: 232, soc: 40 });
  const { day, detail } = detailOf(rows);

  it("keeps the previous day's readings with their positions", () => {
    expect(detail.carry_in).toEqual({ gridV: [-1, 231.4], soc: [-1, 14.8] });
  });

  it("returns each range with the reading that decided it", () => {
    expect(detail.dark_lowbat).toEqual({ ranges: [[0, 95]], min: 95, decidedBy: [soc(-1, 14.8)] });
    expect(detail.no_data).toEqual({
      ranges: [[600, 645]],
      min: 45,
      ruledOut: [{ grid: gridV(119, 229.8), soc: soc(119, 63) }],
    });
    expect(detail.dark_cut).toEqual({ ranges: [[1140, 1305]], min: 165, decidedBy: [gridV(227, 0)] });
    expect(detail.dark_after_lowbat).toEqual({ ranges: [], min: 0, decidedBy: [] });
  });

  it("agrees with the day's figures", () => {
    expect(day.darkMinutes).toBe(260);
    expect(day.darkInferredMinutes).toBe(95);
    expect(day.noDataMinutes).toBe(45);
    expect(day.cutMinutes).toBe(265);
    expect(day.knownMinutes).toBe(1395);
  });
});

describe("computeSiteDayDetail — causes", () => {
  it("decides a gap that starts in a cut carried in by the previous day's reading", () => {
    for (const n of [0, 11, 40]) {
      const rows = new Map<number, Row>();
      rows.set(-1, { volts: 0, soc: 50 });
      fill(rows, n + 1, 287, { volts: 230, soc: 50 });
      const { detail } = detailOf(rows);
      expect(detail.dark_cut).toEqual({
        ranges: [[0, 5 * (n + 1)]],
        min: 5 * (n + 1),
        decidedBy: [gridV(-1, 0)],
      });
      expect(detail.dark_lowbat.ranges).toEqual([]);
      expect(detail.no_data.ranges).toEqual([]);
    }
  });

  it("points a gap after a low-battery gap, before any voltage reading, at that gap", () => {
    const rows = new Map<number, Row>();
    rows.set(-1, { volts: 230, soc: 10 });
    // 0–5 empty: low battery. 6–20 online with no voltage, so the grid stays
    // carried as off; 21–25 empty.
    fill(rows, 6, 20, { soc: 40 });
    // The grid back at 26; the battery at its floor at 100; 101–110 empty.
    fill(rows, 26, 99, { volts: 230, soc: 40 });
    rows.set(100, { volts: 230, soc: 12 });
    // 111–150 online with no voltage; 151–155 empty; the grid back at 156.
    fill(rows, 111, 150, { soc: 20 });
    fill(rows, 156, 287, { volts: 230, soc: 30 });
    const { day, detail } = detailOf(rows);
    expect(detail.dark_lowbat).toEqual({
      ranges: [
        [0, 30],
        [505, 555],
      ],
      min: 80,
      decidedBy: [soc(-1, 10), soc(100, 12)],
    });
    expect(detail.dark_after_lowbat).toEqual({
      ranges: [
        [105, 130],
        [755, 780],
      ],
      min: 50,
      decidedBy: [{ lowbatRange: 0 }, { lowbatRange: 1 }],
    });
    expect(detail.dark_cut.ranges).toEqual([]);
    expect(day.darkMinutes).toBe(130);
    expect(day.darkInferredMinutes).toBe(80);
  });

  it("points a gap after a low-battery gap and a reading below the threshold at that reading", () => {
    const rows = new Map<number, Row>();
    rows.set(-1, { volts: 230, soc: 10 });
    // 0–5 empty: low battery. 6 reads 0 V; 7–10 empty.
    rows.set(6, { volts: 0, soc: 12 });
    fill(rows, 11, 287, { volts: 230, soc: 30 });
    const { detail } = detailOf(rows);
    expect(detail.dark_lowbat).toEqual({ ranges: [[0, 30]], min: 30, decidedBy: [soc(-1, 10)] });
    expect(detail.dark_cut).toEqual({ ranges: [[35, 55]], min: 20, decidedBy: [gridV(6, 0)] });
    expect(detail.dark_after_lowbat.ranges).toEqual([]);
  });

  it("rules out nothing for a no-data gap before any reading", () => {
    const rows = new Map<number, Row>();
    fill(rows, 10, 287, { volts: 230, soc: 50 });
    const { detail } = detailOf(rows);
    expect(detail.carry_in).toEqual({ gridV: null, soc: null });
    expect(detail.no_data).toEqual({ ranges: [[0, 50]], min: 50, ruledOut: [{ grid: null, soc: null }] });
  });
});

// ---------------------------------------------------------------------------
// Invariants, over generated fixture days and seeded random samples.
// ---------------------------------------------------------------------------

/** The examples' microgrid (surface/examples.ts), whose 2026 days cover every scenario. */
const EXAMPLE_MICROGRID = "00000000-0000-4000-8000-0000000000a1";
const device = (id: string) => ({ id, edgeOpenemsId: "SYNTHETIC-EDGE-EXAMPLE", componentId: `meter-${id}` });
const FIXTURE_SOURCES: SiteSources = {
  battery: device("battery"),
  gridMeter: device("grid"),
  load: device("load"),
  pv: null,
  houseMeters: [],
  houseMetersUnreadable: 0,
};

function fixtureInput(date: string): SiteDayInput {
  return {
    date,
    timezone: KAMPALA,
    samples: generateSiteSamples({
      microgridId: EXAMPLE_MICROGRID,
      sources: FIXTURE_SOURCES,
      startDate: addDaysToDateKey(date, -1),
      endDate: date,
      timezone: KAMPALA,
      resolutionMinutes: BIN_MINUTES,
    }),
    sources: { ...ALL_SOURCES },
    resolutionMinutes: BIN_MINUTES,
    nowMs: Date.parse(`${addDaysToDateKey(date, 2)}T00:00:00Z`),
  };
}

const RANDOM_ZONES = ["Africa/Kampala", "Europe/London", "America/New_York", "UTC"];
const RANDOM_DATES = ["2026-03-08", "2026-03-29", "2026-06-15", "2026-10-25", "2026-11-01", "2026-11-10"];
const RANDOM_RESOLUTIONS = [5, 5, 15, 60];

/**
 * Random samples for the day before and the day itself: runs of empty
 * bins, bins with two samples (only the first counts), all-null rows,
 * voltages either side of the threshold and SoC around the floor.
 */
function randomInput(seed: number): SiteDayInput {
  const random = mulberry32(seed);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const timezone = pick(RANDOM_ZONES);
  const date = pick(RANDOM_DATES);
  const resolutionMinutes = pick(RANDOM_RESOLUTIONS);
  const binMs = resolutionMinutes * MINUTE;
  const carryStartMs = startOfDayInZone(addDaysToDateKey(date, -1), timezone).getTime();
  const dayStartMs = startOfDayInZone(date, timezone).getTime();
  const dayEndMs = startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime();
  const gapChance = 0.02 + random() * 0.2;
  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: {},
  };
  const value = (chanceNull: number, draw: () => number) => (random() < chanceNull ? null : draw());
  // A run of samples from a day or two back, which the day must ignore.
  let t = carryStartMs - (random() < 0.3 ? 3 * 60 * MINUTE : 0);
  let gapLeft = 0;
  for (; t < dayEndMs + binMs; t += binMs) {
    if (gapLeft > 0) {
      gapLeft--;
      continue;
    }
    if (random() < gapChance) {
      gapLeft = Math.floor(random() * 40);
      continue;
    }
    const samplesInBin = random() < 0.15 ? 2 : 1;
    for (let k = 0; k < samplesInBin; k++) {
      out.timestamps.push(t + k * Math.floor(binMs / 3));
      const allNull = random() < 0.03;
      out.batterySocPct.push(allNull ? null : value(0.15, () => Math.round(random() * 400) / 10));
      out.batteryPowerW.push(allNull ? null : value(0.5, () => Math.round(random() * 2000 - 1000)));
      out.gridPowerW.push(null);
      out.gridVoltageV.push(
        allNull ? null : value(0.25, () => (random() < 0.3 ? Math.round(random() * 1690) / 10 : 170 + Math.round(random() * 700) / 10))
      );
      out.loadPowerW.push(allNull ? null : value(0.5, () => Math.round(random() * 1500)));
      out.pvPowerW.push(null);
    }
  }
  const finished = random() < 0.7;
  return {
    date,
    timezone,
    samples: out,
    sources: { ...ALL_SOURCES },
    resolutionMinutes,
    nowMs: finished ? dayEndMs + 2 * 60 * MINUTE : dayStartMs + Math.floor(random() * (dayEndMs - dayStartMs)),
  };
}

const minutesOf = (list: MinuteRange[]) => list.reduce((sum, [start, end]) => sum + end - start, 0);

function merged(list: MinuteRange[]): MinuteRange[] {
  const out: MinuteRange[] = [];
  for (const [start, end] of [...list].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && last[1] === start) last[1] = end;
    else out.push([start, end]);
  }
  return out;
}

/**
 * The values computeSiteDay reads for each series: at a day position, the
 * first sample in the bin; at a negative one, the previous day's last
 * non-null sample, if it is in that bin.
 */
function readingsOf(input: SiteDayInput, day: SiteDayOperations) {
  const binMs = input.resolutionMinutes * MINUTE;
  const binOf = (t: number) => Math.floor((t - day.dayStartMs) / binMs);
  const carryStartMs = startOfDayInZone(addDaysToDateKey(input.date, -1), input.timezone).getTime();
  const series = { gridV: input.samples.gridVoltageV, soc: input.samples.batterySocPct };
  const firstInBin = new Map<number, number>();
  const carried: Record<"gridV" | "soc", { pos: number; v: number } | null> = { gridV: null, soc: null };
  input.samples.timestamps.forEach((t, i) => {
    if (t >= carryStartMs && t < day.dayStartMs) {
      for (const name of ["gridV", "soc"] as const) {
        const v = series[name][i];
        if (v !== null) carried[name] = { pos: binOf(t), v };
      }
    } else if (t >= day.dayStartMs && t < day.readUntilMs && !firstInBin.has(binOf(t))) {
      firstInBin.set(binOf(t), i);
    }
  });
  return (name: "gridV" | "soc", pos: number): number | null => {
    if (pos < 0) return carried[name]?.pos === pos ? carried[name].v : null;
    const i = firstInBin.get(pos);
    return i === undefined ? null : series[name][i];
  };
}

function expectInvariants(input: SiteDayInput, day: SiteDayOperations, detail: SiteDayDetail) {
  const darkLists = [detail.dark_cut, detail.dark_lowbat, detail.dark_after_lowbat];
  expect(detail.dark_cut.min + detail.dark_lowbat.min + detail.dark_after_lowbat.min).toBe(day.darkMinutes);
  expect(detail.dark_lowbat.min).toBe(day.darkInferredMinutes);
  expect(detail.no_data.min).toBe(day.noDataMinutes);
  const toMinutes = (r: { startMs: number; endMs: number }): MinuteRange => [
    (r.startMs - day.dayStartMs) / MINUTE,
    (r.endMs - day.dayStartMs) / MINUTE,
  ];
  expect(merged(darkLists.flatMap((l) => l.ranges))).toEqual(day.dark.map(toMinutes));

  for (const list of [...darkLists, detail.no_data]) {
    expect(list.min).toBe(minutesOf(list.ranges));
    list.ranges.forEach(([start, end], i) => {
      expect(end).toBeGreaterThan(start);
      if (i > 0) expect(start).toBeGreaterThan(list.ranges[i - 1][1]);
    });
  }
  expect(detail.dark_cut.decidedBy).toHaveLength(detail.dark_cut.ranges.length);
  expect(detail.dark_lowbat.decidedBy).toHaveLength(detail.dark_lowbat.ranges.length);
  expect(detail.dark_after_lowbat.decidedBy).toHaveLength(detail.dark_after_lowbat.ranges.length);
  expect(detail.no_data.ruledOut).toHaveLength(detail.no_data.ranges.length);

  const readingAt = readingsOf(input, day);
  const expectRead = (r: DecidingReading) => expect(r.v).toBe(readingAt(r.series, r.pos));
  detail.dark_cut.decidedBy.forEach((r, i) => {
    expect(r.series).toBe("gridV");
    expect(r.v).toBeLessThan(GRID_PRESENT_MIN_V);
    expect(r.pos * day.resolutionMinutes).toBeLessThan(detail.dark_cut.ranges[i][0]);
    expectRead(r);
  });
  detail.dark_lowbat.decidedBy.forEach((r, i) => {
    expect(r.series).toBe("soc");
    expect(r.v).toBeLessThanOrEqual(LOW_BATTERY_PCT);
    expect(r.pos * day.resolutionMinutes).toBeLessThan(detail.dark_lowbat.ranges[i][0]);
    expectRead(r);
  });
  detail.dark_after_lowbat.decidedBy.forEach(({ lowbatRange }, i) => {
    expect(lowbatRange).toBeGreaterThanOrEqual(0);
    expect(detail.dark_lowbat.ranges[lowbatRange][1]).toBeLessThan(detail.dark_after_lowbat.ranges[i][0]);
  });
  detail.no_data.ruledOut.forEach(({ grid, soc: lastSoc }, i) => {
    const start = detail.no_data.ranges[i][0];
    if (grid) {
      expect(grid.series).toBe("gridV");
      expect(grid.v).toBeGreaterThanOrEqual(GRID_PRESENT_MIN_V);
      expect(grid.pos * day.resolutionMinutes).toBeLessThan(start);
      expectRead(grid);
    }
    if (lastSoc) {
      expect(lastSoc.series).toBe("soc");
      expect(lastSoc.v).toBeGreaterThan(LOW_BATTERY_PCT);
      expect(lastSoc.pos * day.resolutionMinutes).toBeLessThan(start);
      expectRead(lastSoc);
    }
  });
  for (const series of ["gridV", "soc"] as const) {
    const carried = detail.carry_in[series];
    if (carried) {
      expect(carried[0]).toBeLessThan(0);
      expect(carried[1]).toBe(readingAt(series, carried[0]));
    }
  }
}

/** These read hundreds of days; the default five seconds is too little on a loaded runner. */
const LONG = 120_000;

describe("computeSiteDayDetail — invariants", () => {
  const dates2026 = Array.from({ length: 365 }, (_, i) => addDaysToDateKey("2026-01-01", i));

  it("covers every scenario in the fixture days", () => {
    expect(new Set(dates2026.map((d) => siteScenario(SITE_FIXTURE_SEED, EXAMPLE_MICROGRID, d))).size).toBe(5);
  });

  it("holds on every 2026 fixture day of the examples' microgrid", () => {
    const causes = new Set<string>();
    for (const date of dates2026) {
      const input = fixtureInput(date);
      const { day, detail } = computeSiteDayDetail(input);
      expectInvariants(input, day, detail);
      for (const key of ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"] as const) {
        if (detail[key].ranges.length) causes.add(key);
      }
    }
    // The fixture's scenarios reach cuts, low-battery gaps and gateway gaps.
    expect(causes).toEqual(new Set(["dark_cut", "dark_lowbat", "no_data"]));
  }, LONG);

  it("holds on seeded random samples", () => {
    const causes = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const input = randomInput(seed);
      const { day, detail } = computeSiteDayDetail(input);
      expectInvariants(input, day, detail);
      for (const key of ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"] as const) {
        if (detail[key].ranges.length) causes.add(key);
      }
    }
    expect(causes).toEqual(new Set(["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"]));
  }, LONG);
});

describe("computeSiteDayDetail — no figure moves", () => {
  it("returns computeSiteDay's day exactly", () => {
    const inputs = [
      ...["2026-01-14", "2026-03-02", "2026-06-20", "2026-09-11", "2026-11-05"].map(fixtureInput),
      ...Array.from({ length: 60 }, (_, i) => randomInput(1000 + i)),
    ];
    for (const input of inputs) {
      expect(computeSiteDay(input)).toEqual(computeSiteDayDetail(input).day);
    }
  }, LONG);
});
