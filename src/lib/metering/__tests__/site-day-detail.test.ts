import { createHash } from "node:crypto";
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

  it("keeps the six series as picked, one value per bin", () => {
    for (const series of Object.values(detail.series)) expect(series).toHaveLength(288);
    expect(detail.series.gridV[119]).toBe(229.8);
    expect(detail.series.soc[119]).toBe(63);
    expect(detail.series.gridV[227]).toBe(0);
    expect(detail.series.gridV.slice(0, 19)).toEqual(Array(19).fill(null));
    expect(detail.series.loadW[19]).toBe(300);
    expect(detail.series.pvW).toEqual(Array(288).fill(null));
  });

  it("takes the first sample in a bin, as the day does", () => {
    const samples = samplesAt(rows);
    // A second sample in bin 119, a minute later: the series keeps the first.
    const i = samples.timestamps.indexOf(DAY_START + 119 * BIN_MS);
    samples.timestamps.splice(i + 1, 0, DAY_START + 119 * BIN_MS + MINUTE);
    for (const key of ["batterySocPct", "batteryPowerW", "gridPowerW", "gridVoltageV", "loadPowerW", "pvPowerW"] as const) {
      samples[key].splice(i + 1, 0, key === "gridVoltageV" ? 0 : 1);
    }
    const twice = computeSiteDayDetail({
      date: DATE,
      timezone: KAMPALA,
      samples,
      sources: ALL_SOURCES,
      resolutionMinutes: BIN_MINUTES,
      nowMs: DAY_START + 26 * 60 * MINUTE,
    });
    expect(twice.detail.series).toEqual(detail.series);
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

  it("rules out the previous day's last readings for a no-data gap at the day's start", () => {
    const rows = new Map<number, Row>();
    // An earlier cut and a battery at its floor, both overtaken by the
    // previous day's last readings.
    rows.set(-4, { volts: 0, soc: 8 });
    rows.set(-1, { volts: 231, soc: 60 });
    fill(rows, 10, 287, { volts: 230, soc: 50 });
    const { detail } = detailOf(rows);
    expect(detail.no_data).toEqual({
      ranges: [[0, 50]],
      min: 50,
      ruledOut: [{ grid: gridV(-1, 231), soc: soc(-1, 60) }],
    });
    expect(detail.dark_cut.ranges).toEqual([]);
    expect(detail.dark_lowbat.ranges).toEqual([]);
  });

  it("decides a cut by the last reading below the threshold, not an earlier one", () => {
    const rows = new Map<number, Row>();
    fill(rows, 0, 224, { volts: 230, soc: 60 });
    rows.set(225, { volts: 0, soc: 60 });
    // Online with no voltage, so the grid stays carried as off.
    rows.set(226, { soc: 60 });
    rows.set(227, { volts: 12, soc: 60 });
    // 228–260 empty.
    fill(rows, 261, 287, { volts: 230, soc: 60 });
    const { detail } = detailOf(rows);
    expect(detail.dark_cut).toEqual({ ranges: [[1140, 1305]], min: 165, decidedBy: [gridV(227, 12)] });
  });

  it("decides a low-battery gap by the last SoC reading, not an earlier one", () => {
    const rows = new Map<number, Row>();
    fill(rows, 0, 99, { volts: 230, soc: 40 });
    rows.set(100, { volts: 230, soc: 12 });
    // Online with no SoC.
    rows.set(101, { volts: 230 });
    rows.set(102, { volts: 230, soc: 10 });
    // 103–110 empty.
    fill(rows, 111, 287, { volts: 230, soc: 30 });
    const { detail } = detailOf(rows);
    expect(detail.dark_lowbat).toEqual({ ranges: [[515, 555]], min: 40, decidedBy: [soc(102, 10)] });
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
 * non-null sample, if it is in that bin. `lastBefore` is the reading in
 * force when a day bin starts.
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
  const readingAt = (name: "gridV" | "soc", pos: number): number | null => {
    if (pos < 0) return carried[name]?.pos === pos ? carried[name].v : null;
    const i = firstInBin.get(pos);
    return i === undefined ? null : (series[name][i] ?? null);
  };
  /** The series' last reading before day bin `bin`, the previous day's included. */
  const lastBefore = (name: "gridV" | "soc", bin: number): DecidingReading | null => {
    for (let pos = bin - 1; pos >= 0; pos--) {
      const v = readingAt(name, pos);
      if (v !== null) return { series: name, pos, v };
    }
    const c = carried[name];
    return c ? { series: name, pos: c.pos, v: c.v } : null;
  };
  return { readingAt, lastBefore };
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

  const { lastBefore } = readingsOf(input, day);
  const binOf = (minute: number) => minute / day.resolutionMinutes;
  // Each deciding reading is the series' last reading before its gap starts
  // (the previous day's included), so no reading of that series falls
  // between the deciding one and the gap.
  detail.dark_cut.decidedBy.forEach((r, i) => {
    expect(r.series).toBe("gridV");
    expect(r.v).toBeLessThan(GRID_PRESENT_MIN_V);
    expect(r).toEqual(lastBefore("gridV", binOf(detail.dark_cut.ranges[i][0])));
  });
  detail.dark_lowbat.decidedBy.forEach((r, i) => {
    expect(r.series).toBe("soc");
    expect(r.v).toBeLessThanOrEqual(LOW_BATTERY_PCT);
    expect(r).toEqual(lastBefore("soc", binOf(detail.dark_lowbat.ranges[i][0])));
  });
  detail.dark_after_lowbat.decidedBy.forEach(({ lowbatRange }, i) => {
    const start = detail.dark_after_lowbat.ranges[i][0];
    // The latest low-battery gap before this one, with no voltage reading
    // since it started.
    expect(lowbatRange).toBe(detail.dark_lowbat.ranges.filter(([s]) => s < start).length - 1);
    const [lowbatStart, lowbatEnd] = detail.dark_lowbat.ranges[lowbatRange];
    expect(lowbatEnd).toBeLessThan(start);
    const lastVolts = lastBefore("gridV", binOf(start));
    if (lastVolts) expect(lastVolts.pos).toBeLessThan(binOf(lowbatStart));
  });
  detail.no_data.ruledOut.forEach(({ grid, soc: lastSoc }, i) => {
    const startBin = binOf(detail.no_data.ranges[i][0]);
    // Null only when the series has no reading before the gap.
    expect(grid).toEqual(lastBefore("gridV", startBin));
    expect(lastSoc).toEqual(lastBefore("soc", startBin));
    if (grid) expect(grid.v).toBeGreaterThanOrEqual(GRID_PRESENT_MIN_V);
    if (lastSoc) expect(lastSoc.v).toBeGreaterThan(LOW_BATTERY_PCT);
  });
  for (const series of ["gridV", "soc"] as const) {
    // The previous day's last reading, null only when it has none.
    const before = lastBefore(series, 0);
    expect(detail.carry_in[series]).toEqual(before ? [before.pos, before.v] : null);
    if (before) expect(before.pos).toBeLessThan(0);
  }
  expectSeries(input, day, detail);
}

/**
 * The six series hold one value per bin read, each the first sample in its
 * bin (null for an empty bin), and every deciding reading inside the day is
 * the value at its position.
 */
function expectSeries(input: SiteDayInput, day: SiteDayOperations, detail: SiteDayDetail) {
  const binMs = input.resolutionMinutes * MINUTE;
  const bins = Math.round((day.readUntilMs - day.dayStartMs) / binMs);
  const firstInBin = new Map<number, number>();
  input.samples.timestamps.forEach((t, i) => {
    if (t < day.dayStartMs || t >= day.readUntilMs) return;
    const pos = Math.floor((t - day.dayStartMs) / binMs);
    if (!firstInBin.has(pos)) firstInBin.set(pos, i);
  });
  const sampled = {
    soc: input.samples.batterySocPct,
    batW: input.samples.batteryPowerW,
    gridW: input.samples.gridPowerW,
    gridV: input.samples.gridVoltageV,
    loadW: input.samples.loadPowerW,
    pvW: input.samples.pvPowerW,
  };
  expect(Object.keys(detail.series)).toEqual(Object.keys(sampled));
  for (const [name, samples] of Object.entries(sampled) as [keyof typeof sampled, (number | null)[]][]) {
    const series = detail.series[name];
    expect(series).toHaveLength(bins);
    expect(series).toHaveLength(day.soc.length);
    const expected = Array.from({ length: bins }, (_, pos) => {
      const i = firstInBin.get(pos);
      return i === undefined ? null : (samples[i] ?? null);
    });
    expect(series, name).toEqual(expected);
  }
  expect(detail.series.soc).toEqual(day.soc.map((s) => s.pct));
  const readings = [
    ...detail.dark_cut.decidedBy,
    ...detail.dark_lowbat.decidedBy,
    ...detail.no_data.ruledOut.flatMap(({ grid, soc: s }) => [grid, s]),
  ].filter((r): r is DecidingReading => r !== null && r.pos >= 0);
  for (const r of readings) expect(detail.series[r.series][r.pos]).toBe(r.v);
}

/** These read hundreds of days; the default five seconds is too little on a loaded runner. */
const LONG = 120_000;

const DATES_2026 = Array.from({ length: 365 }, (_, i) => addDaysToDateKey("2026-01-01", i));
const RANDOM_SEEDS = 400;

describe("computeSiteDayDetail — invariants", () => {

  it("covers every scenario in the fixture days", () => {
    expect(new Set(DATES_2026.map((d) => siteScenario(SITE_FIXTURE_SEED, EXAMPLE_MICROGRID, d))).size).toBe(5);
  });

  it("holds on every 2026 fixture day of the examples' microgrid", () => {
    const causes = new Set<string>();
    for (const date of DATES_2026) {
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
    for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
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

/**
 * A digest of a day's figures: its JSON with keys sorted, so a change that
 * only reorders keys is not a change of figure.
 */
function figuresDigest(day: SiteDayOperations): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted((v as Record<string, unknown>)[k])])
          )
        : v;
  return createHash("sha256").update(JSON.stringify(sorted(day))).digest("hex").slice(0, 16);
}

const FIGURE_DATES = Array.from({ length: 12 }, (_, m) => `2026-${String(m + 1).padStart(2, "0")}-01`);
const FIGURE_SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i);

/**
 * computeSiteDay's figures as main computed them before computeSiteDayDetail
 * existed (38f80d8c): for the first of each month's fixture day and the
 * random samples of FIGURE_SEEDS one digest each, and for every input of
 * the invariants above one digest together. They were captured by running
 * that commit's computeSiteDay on these inputs, so they hold only while
 * the fixture generator and randomInput give the same inputs. A change
 * that moves a figure on purpose recaptures them (and bumps
 * SITE_DAY_CALC_VERSION once it exists, evidence §11 change 5), and so
 * does one that changes the inputs, such as the fixture's new scenarios
 * (§11 change 6), from a computeSiteDay whose figures are known not to
 * have moved.
 */
const MAIN_FIXTURE_DIGESTS: Record<string, string> = {
  "2026-01-01": "4bbc5f42b3f5b389",
  "2026-02-01": "1cc44dae75b81942",
  "2026-03-01": "80893d2894e7b528",
  "2026-04-01": "c706162aa886898f",
  "2026-05-01": "07cb0e233dbaece9",
  "2026-06-01": "431cb00d20e5e7a2",
  "2026-07-01": "4b8e1bc9270f21b5",
  "2026-08-01": "54a7accb392fcaf8",
  "2026-09-01": "e5b3c72567d53117",
  "2026-10-01": "4a2c2541c1a7c94d",
  "2026-11-01": "4c46ea34d01dd06f",
  "2026-12-01": "af357bf221ec2e64",
};
const MAIN_RANDOM_DIGESTS: Record<number, string> = {
  1000: "d1a3c7b895faaa5a",
  1001: "6586599af35ab586",
  1002: "bde587eed138e728",
  1003: "ef0dea35b924554d",
  1004: "fce499ce86251585",
  1005: "f530bb1b3056f289",
  1006: "6fcc04102d3d0af8",
  1007: "db35187d75f59ecb",
  1008: "8f5fbe087da44af8",
  1009: "923eac59b003d675",
  1010: "1c03e52642c28a5e",
  1011: "e0f509f9cc14d632",
  1012: "5f3a4975af76a842",
  1013: "ee3406ee0ed93f6e",
  1014: "2ed22155c4b145a2",
  1015: "3ed84430c93dc34c",
  1016: "dd1765a0338b1fd8",
  1017: "7082553b5046c9f6",
  1018: "a1691e4453033245",
  1019: "da16f805bdeb5905",
};
const MAIN_ALL_DIGEST = "905135412b63b0a2";

describe("computeSiteDay — no figure moves", () => {
  it("gives main's figures for each named input", () => {
    for (const date of FIGURE_DATES) {
      expect(figuresDigest(computeSiteDay(fixtureInput(date))), date).toBe(MAIN_FIXTURE_DIGESTS[date]);
    }
    for (const seed of FIGURE_SEEDS) {
      expect(figuresDigest(computeSiteDay(randomInput(seed))), `seed ${seed}`).toBe(MAIN_RANDOM_DIGESTS[seed]);
    }
  }, LONG);

  it("gives main's figures for every input of the invariants", () => {
    const all = createHash("sha256");
    for (const date of DATES_2026) all.update(figuresDigest(computeSiteDay(fixtureInput(date))));
    for (let seed = 1; seed <= RANDOM_SEEDS; seed++) all.update(figuresDigest(computeSiteDay(randomInput(seed))));
    expect(all.digest("hex").slice(0, 16)).toBe(MAIN_ALL_DIGEST);
  }, LONG);
});
