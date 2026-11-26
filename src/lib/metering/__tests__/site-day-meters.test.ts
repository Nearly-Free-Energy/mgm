import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addDaysToDateKey, startOfDayInZone } from "@/lib/timezone/day-key";
import { zonedDateTimeToUtcIso } from "@/lib/timezone/wall-clock";
import { generateSiteSamples } from "../fixture/site-samples";
import { mulberry32 } from "../fixture/random";
import {
  HOUSE_READING_TOLERANCE_MS,
  computeSiteDay,
  computeSiteDayDetail,
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
/** Local Kampala wall-clock time on DATE, as epoch ms. */
const at = (hh: number, mm = 0) => DAY_START + (hh * 60 + mm) * MINUTE;

/** Synthetic device ids, as the §4 example's `<d1>` … `<d4>`. */
const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
const D3 = "00000000-0000-4000-8000-0000000000d3";

const SITE: SiteSourceAvailability = {
  battery: true,
  gridMeter: true,
  load: true,
  pv: false,
  houses: false,
  houseMetersUnreadable: 0,
};
const WITH_HOUSES: SiteSourceAvailability = { ...SITE, houses: true };

type Row = { soc?: number | null; volts?: number | null; meters?: Record<string, number | null> };

/**
 * Samples at the start of bin `pos` (negative in the previous day) for each
 * entry; a position without an entry is a gap. Every row has a load
 * reading, so it is online. `meterIds` are the house series the samples
 * hold, null wherever a row gives the meter no value.
 */
function samplesAt(rows: Map<number, Row>, meterIds: string[]): SiteSamples {
  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: Object.fromEntries(meterIds.map((id) => [id, []])),
  };
  for (const pos of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(pos)!;
    out.timestamps.push(DAY_START + pos * BIN_MS);
    out.batterySocPct.push(row.soc ?? null);
    out.batteryPowerW.push(null);
    out.gridPowerW.push(null);
    out.gridVoltageV.push(row.volts ?? null);
    out.loadPowerW.push(300);
    out.pvPowerW.push(null);
    for (const id of meterIds) out.houseEnergyWh[id].push(row.meters?.[id] ?? null);
  }
  return out;
}

/** Fills bins [from, to] with `row`. */
function fill(rows: Map<number, Row>, from: number, to: number, row: Row) {
  for (let pos = from; pos <= to; pos++) rows.set(pos, { ...row });
}

/** Sets meter `id`'s value at bin `pos`, which must hold a row. */
function meterAt(rows: Map<number, Row>, pos: number, id: string, wh: number | null) {
  const row = rows.get(pos)!;
  rows.set(pos, { ...row, meters: { ...row.meters, [id]: wh } });
}

/** A full day of online bins at 230 V and 60%. */
function fullDay(): Map<number, Row> {
  const rows = new Map<number, Row>();
  fill(rows, 0, 287, { volts: 230, soc: 60 });
  return rows;
}

function detailOf(
  rows: Map<number, Row>,
  options: {
    sources?: SiteSourceAvailability;
    meterIds?: string[];
    houseMeterIds?: string[];
    nowMs?: number;
  } = {}
) {
  return computeSiteDayDetail({
    date: DATE,
    timezone: KAMPALA,
    samples: samplesAt(rows, options.meterIds ?? []),
    sources: options.sources ?? WITH_HOUSES,
    resolutionMinutes: BIN_MINUTES,
    nowMs: options.nowMs ?? at(26),
    ...(options.houseMeterIds ? { houseMeterIds: options.houseMeterIds } : {}),
  });
}

describe("computeSiteDayDetail — the evidence document's §4 example meters", () => {
  // The §4 example's site rows (site-day-detail.test.ts), with three
  // readable meters and one unreadable one.
  const rows = new Map<number, Row>();
  rows.set(-1, { volts: 231.4, soc: 14.8 });
  fill(rows, 19, 118, { volts: 230, soc: 50 });
  rows.set(119, { volts: 229.8, soc: 63 });
  fill(rows, 129, 226, { volts: 231, soc: 60 });
  rows.set(227, { volts: 0, soc: 58 });
  fill(rows, 261, 287, { volts: 232, soc: 40 });
  meterAt(rows, 215, D1, 48211);
  meterAt(rows, 287, D1, 48903.5);
  meterAt(rows, 215, D2, 182340);
  meterAt(rows, 287, D2, 1200);
  meterAt(rows, 214, D3, 90412.5);
  const { day, detail } = detailOf(rows, {
    sources: { ...WITH_HOUSES, houseMetersUnreadable: 1 },
    meterIds: [D1, D2, D3],
    houseMeterIds: [D1, D2, D3],
  });

  it("returns the bins searched", () => {
    expect(detail.meter_window).toEqual({ start: [209, 216], end: [281, 287] });
  });

  it("returns each meter's readings and the outcome of each meter left out", () => {
    expect(detail.meter_readings).toEqual({
      [D1]: { start: [215, 48211], end: [287, 48903.5] },
      [D2]: { start: [215, 182340], end: [287, 1200] },
      [D3]: { start: [214, 90412.5], end: null },
    });
    expect(detail.meter_outcomes).toEqual({ [D2]: "backwards", [D3]: "no_end" });
  });

  it("agrees with the day's figures", () => {
    expect(day.housesEveningKwh).toBeCloseTo(0.6925, 10);
    // <d2>, <d3> and the unreadable <d4>.
    expect(day.housesEveningMetersMissing).toBe(3);
  });
});

describe("computeSiteDayDetail — tenant meters", () => {
  it("gives no_start, with neither reading, when bins 209–216 are empty", () => {
    const rows = fullDay();
    for (let pos = 0; pos <= 287; pos++) {
      if (pos < 209 || pos > 216) meterAt(rows, pos, D1, 1000 + pos);
    }
    const { day, detail } = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1] });
    expect(detail.meter_readings).toEqual({ [D1]: { start: null, end: null } });
    expect(detail.meter_outcomes).toEqual({ [D1]: "no_start" });
    expect(day.housesEveningKwh).toBeNull();
    expect(day.housesEveningMetersMissing).toBe(1);
  });

  it("starts from the window's first bin when the half hour before it is empty", () => {
    const rows = fullDay();
    for (let pos = 216; pos <= 287; pos++) meterAt(rows, pos, D1, 5000 + pos);
    const { detail } = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1] });
    expect(detail.meter_readings).toEqual({ [D1]: { start: [216, 5216], end: [287, 5287] } });
    expect(detail.meter_outcomes).toEqual({});
  });

  it("returns the meter window on a day without tenant meters", () => {
    const { day, detail } = detailOf(fullDay(), { sources: SITE });
    expect(detail.meter_window).toEqual({ start: [209, 216], end: [281, 287] });
    expect(detail.meter_readings).toEqual({});
    expect(detail.meter_outcomes).toEqual({});
    expect(day.housesEveningMetersMissing).toBe(0);
  });

  it("returns no meter window, and no meter, for a read that ends before 18:00", () => {
    const rows = fullDay();
    for (let pos = 0; pos <= 287; pos++) meterAt(rows, pos, D1, 1000 + pos);
    // 17:02 less the lag: the read ends at 17:00.
    const atFive = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1], nowMs: at(17, 2) });
    expect(atFive.day.readUntilMs).toBe(at(17));
    expect(atFive.detail.meter_window).toBeNull();
    expect(atFive.detail.meter_readings).toEqual({});
    expect(atFive.detail.meter_outcomes).toEqual({});
    expect(atFive.day.housesEveningMetersMissing).toBe(0);
    // A read that ends at 18:00 has read no evening bin either.
    const atSix = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1], nowMs: at(18, 2) });
    expect(atSix.day.readUntilMs).toBe(at(18));
    expect(atSix.detail.meter_window).toBeNull();
    expect(atSix.detail.meter_readings).toEqual({});
  });

  it("returns the window read so far once the evening has started", () => {
    const rows = fullDay();
    for (let pos = 0; pos <= 287; pos++) meterAt(rows, pos, D1, 1000 + pos);
    // 18:07 less the lag: the 18:00 bin is the last one read.
    const { detail } = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1], nowMs: at(18, 7) });
    expect(detail.meter_window).toEqual({ start: [209, 216], end: [210, 216] });
    expect(detail.meter_readings).toEqual({ [D1]: { start: [215, 1215], end: [216, 1216] } });
  });

  it("gives no_end, not a zero, when nothing follows the start reading early in the evening", () => {
    const rows = fullDay();
    meterAt(rows, 215, D1, 1215);
    // 18:12 less the lag: the read ends at 18:10, so the 18:05 bin is the last.
    const { day, detail } = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1], nowMs: at(18, 12) });
    expect(detail.meter_window).toEqual({ start: [209, 216], end: [211, 217] });
    expect(detail.meter_readings).toEqual({ [D1]: { start: [215, 1215], end: null } });
    expect(detail.meter_outcomes).toEqual({ [D1]: "no_end" });
    expect(day.housesEveningKwh).toBeNull();
  });

  it("gives no_start to a requested meter the provider left out, and counts it as missing", () => {
    const rows = fullDay();
    for (let pos = 0; pos <= 287; pos++) meterAt(rows, pos, D1, 1000 + pos);
    const { day, detail } = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1, D2] });
    expect(detail.meter_readings).toEqual({
      [D1]: { start: [215, 1215], end: [287, 1287] },
      [D2]: { start: null, end: null },
    });
    expect(detail.meter_outcomes).toEqual({ [D2]: "no_start" });
    expect(day.housesEveningKwh).toBeCloseTo(0.072, 10);
    expect(day.housesEveningMetersMissing).toBe(1);
    // Without the ids asked for, only the meters the samples hold are read.
    const returned = detailOf(rows, { meterIds: [D1] });
    expect(Object.keys(returned.detail.meter_readings)).toEqual([D1]);
    expect(returned.day.housesEveningMetersMissing).toBe(0);
  });

  it("reads only the meters asked for, not every series the samples hold", () => {
    const rows = fullDay();
    for (let pos = 0; pos <= 287; pos++) {
      meterAt(rows, pos, D1, 1000 + pos);
      meterAt(rows, pos, D2, 2000 + pos);
    }
    const { day, detail } = detailOf(rows, { meterIds: [D1, D2], houseMeterIds: [D2] });
    expect(Object.keys(detail.meter_readings)).toEqual([D2]);
    expect(day.housesEveningKwh).toBeCloseTo(0.072, 10);
  });

  it("counts a meter whose end reading equals its start at zero, not as backwards", () => {
    // A vacant unit: the counter does not move across the evening.
    const rows = fullDay();
    meterAt(rows, 215, D1, 5000);
    meterAt(rows, 287, D1, 5000);
    const { day, detail } = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1] });
    expect(detail.meter_readings).toEqual({ [D1]: { start: [215, 5000], end: [287, 5000] } });
    expect(detail.meter_outcomes).toEqual({});
    expect(day.housesEveningKwh).toBe(0);
    expect(day.housesEveningMetersMissing).toBe(0);
  });

  it("reads a meter asked for twice once", () => {
    const rows = fullDay();
    for (let pos = 0; pos <= 287; pos++) meterAt(rows, pos, D1, 1000 + pos);
    const { day } = detailOf(rows, { meterIds: [D1], houseMeterIds: [D1, D1] });
    expect(day.housesEveningKwh).toBeCloseTo(0.072, 10);
  });
});

// ---------------------------------------------------------------------------
// Invariants, over generated fixture days and seeded random samples.
// ---------------------------------------------------------------------------

/** The examples' microgrid (surface/examples.ts). */
const EXAMPLE_MICROGRID = "00000000-0000-4000-8000-0000000000a1";
const device = (id: string) => ({ id, edgeOpenemsId: "SYNTHETIC-EDGE-EXAMPLE", componentId: `meter-${id}` });
const FIXTURE_METERS = [D1, D2, D3];
const FIXTURE_SOURCES: SiteSources = {
  battery: device("battery"),
  gridMeter: device("grid"),
  load: device("load"),
  pv: null,
  houseMeters: FIXTURE_METERS.map(device),
  houseMetersUnreadable: 1,
};

/** A fixture day with three readable tenant meters and one unreadable one; the meters asked for are left to the caller. */
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
    sources: { ...WITH_HOUSES, houseMetersUnreadable: 1 },
    resolutionMinutes: BIN_MINUTES,
    nowMs: Date.parse(`${addDaysToDateKey(date, 2)}T00:00:00Z`),
  };
}

const RANDOM_ZONES = ["Africa/Kampala", "Europe/London", "America/New_York", "UTC"];
const RANDOM_DATES = ["2026-03-08", "2026-03-29", "2026-06-15", "2026-10-25", "2026-11-01", "2026-11-10"];
const RANDOM_RESOLUTIONS = [5, 5, 15, 60];
const METER_KINDS = ["steady", "gappy", "reset", "late", "silent", "omitted"] as const;

/**
 * Random samples for the day before and the day itself, with up to five
 * tenant meters: steady, with random empty runs, reset mid-evening,
 * silent from a random time, never reporting, or left out of the samples
 * altogether. `requested` is every meter, the left-out ones included.
 * Runs of empty bins, bins with two samples (only the first counts) and
 * unfinished days (a third of them ending within an hour of 18:00) vary
 * the window.
 */
function randomInput(seed: number): { input: SiteDayInput; requested: string[] } {
  const random = mulberry32(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const timezone = pick(RANDOM_ZONES);
  const date = pick(RANDOM_DATES);
  const resolutionMinutes = pick(RANDOM_RESOLUTIONS);
  const binMs = resolutionMinutes * MINUTE;
  const carryStartMs = startOfDayInZone(addDaysToDateKey(date, -1), timezone).getTime();
  const dayStartMs = startOfDayInZone(date, timezone).getTime();
  const dayEndMs = startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime();
  const meterCount = Math.floor(random() * 6);
  const meters = Array.from({ length: meterCount }, (_, k) => ({
    id: `00000000-0000-4000-8000-${String(seed).padStart(8, "0")}${String(k).padStart(4, "0")}`,
    kind: pick(METER_KINDS),
    counter: Math.round(random() * 1_000_000),
    // For "reset" and "late", an instant in the day's afternoon or evening.
    changeAt: dayStartMs + (15 + random() * 9) * 60 * MINUTE,
    nullChance: random() * 0.5,
    reset: false,
  }));
  const kept = meters.filter((m) => m.kind !== "omitted");
  const gapChance = 0.01 + random() * 0.1;
  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: Object.fromEntries(kept.map((m) => [m.id, []])),
  };
  let gapLeft = 0;
  for (let t = carryStartMs; t < dayEndMs + binMs; t += binMs) {
    if (gapLeft > 0) {
      gapLeft--;
      continue;
    }
    if (random() < gapChance) {
      gapLeft = Math.floor(random() * 30);
      continue;
    }
    const samplesInBin = random() < 0.15 ? 2 : 1;
    for (let k = 0; k < samplesInBin; k++) {
      const ts = t + k * Math.floor(binMs / 3);
      out.timestamps.push(ts);
      out.batterySocPct.push(random() < 0.2 ? null : Math.round(random() * 1000) / 10);
      out.batteryPowerW.push(null);
      out.gridPowerW.push(null);
      out.gridVoltageV.push(random() < 0.2 ? null : 230);
      out.loadPowerW.push(Math.round(random() * 1500));
      out.pvPowerW.push(null);
      for (const m of kept) {
        m.counter += Math.round(random() * 40) / 2;
        let value: number | null = m.counter;
        if (m.kind === "silent") value = null;
        if (m.kind === "gappy" && random() < m.nullChance) value = null;
        if (m.kind === "late" && ts >= m.changeAt) value = null;
        if (m.kind === "reset" && ts >= m.changeAt && !m.reset) {
          m.counter = Math.round(random() * 100);
          m.reset = true;
          value = m.counter;
        }
        out.houseEnergyWh[m.id].push(value);
      }
    }
  }
  const unreadable = Math.floor(random() * 3);
  const houses = meters.length + unreadable > 0 && random() < 0.85;
  const finished = random() < 0.6;
  // A third of the unfinished days end within an hour of 18:00 either way.
  const sixPm = Date.parse(zonedDateTimeToUtcIso(`${date}T18:00`, timezone)!);
  const nowMs = finished
    ? dayEndMs + 2 * 60 * MINUTE
    : random() < 1 / 3
      ? sixPm + Math.floor((random() * 2 - 1) * 60 * MINUTE)
      : dayStartMs + Math.floor(random() * (dayEndMs - dayStartMs));
  return {
    input: {
      date,
      timezone,
      samples: out,
      sources: { ...SITE, houses, houseMetersUnreadable: houses ? unreadable : 0 },
      resolutionMinutes,
      nowMs,
    },
    requested: meters.map((m) => m.id),
  };
}

/**
 * Checks a day's meter detail against the rule the module comment states,
 * worked out here from the samples rather than from the loop.
 */
function expectMeterInvariants(input: SiteDayInput, day: SiteDayOperations, detail: SiteDayDetail) {
  const binMs = input.resolutionMinutes * MINUTE;
  const binCount = Math.round((day.readUntilMs - day.dayStartMs) / binMs);
  let firstEvening = -1;
  for (let i = 0; i < binCount; i++) {
    if (day.dayStartMs + i * binMs >= day.eveningStartMs) {
      firstEvening = i;
      break;
    }
  }
  const last = binCount - 1;
  const tol = Math.round(HOUSE_READING_TOLERANCE_MS / binMs);
  const startLo = Math.max(0, firstEvening - 1 - tol);
  const endLo = Math.max(0, last - tol);
  if (firstEvening < 0) expect(detail.meter_window).toBeNull();
  else expect(detail.meter_window).toEqual({ start: [startLo, firstEvening], end: [endLo, last] });

  const searched = input.sources.houses && day.readUntilMs > day.eveningStartMs;
  const ids = searched ? [...new Set(input.houseMeterIds ?? Object.keys(input.samples.houseEnergyWh))] : [];
  expect(Object.keys(detail.meter_readings).sort()).toEqual([...ids].sort());
  for (const id of Object.keys(detail.meter_outcomes)) expect(ids).toContain(id);

  const firstInBin = new Map<number, number>();
  input.samples.timestamps.forEach((t, i) => {
    if (t < day.dayStartMs || t >= day.readUntilMs) return;
    const pos = Math.floor((t - day.dayStartMs) / binMs);
    if (!firstInBin.has(pos)) firstInBin.set(pos, i);
  });
  const valueAt = (id: string, pos: number) => {
    const i = firstInBin.get(pos);
    return i === undefined ? null : (input.samples.houseEnergyWh[id]?.[i] ?? null);
  };
  const noneIn = (id: string, from: number, to: number) => {
    for (let pos = from; pos <= to; pos++) expect(valueAt(id, pos), `${id} at ${pos}`).toBeNull();
  };

  let total = 0;
  let counted = 0;
  for (const id of ids) {
    const { start, end } = detail.meter_readings[id];
    const outcome = detail.meter_outcomes[id];
    if (start === null) {
      expect(end).toBeNull();
      expect(outcome).toBe("no_start");
      if (firstEvening >= 0) noneIn(id, startLo, firstEvening);
      continue;
    }
    const [startPos, startWh] = start;
    expect(valueAt(id, startPos)).toBe(startWh);
    // The latest reading in the half hour before the window, else the
    // window's first bin.
    expect(startPos).toBeGreaterThanOrEqual(startLo);
    expect(startPos).toBeLessThanOrEqual(firstEvening);
    if (startPos < firstEvening) noneIn(id, startPos + 1, firstEvening - 1);
    else noneIn(id, startLo, firstEvening - 1);
    if (end === null) {
      expect(outcome).toBe("no_end");
      noneIn(id, Math.max(startPos + 1, last - tol), last);
      continue;
    }
    const [endPos, endWh] = end;
    expect(valueAt(id, endPos)).toBe(endWh);
    expect(endPos).toBeGreaterThan(startPos);
    expect(endPos).toBeGreaterThanOrEqual(last - tol);
    noneIn(id, endPos + 1, last);
    if (endWh < startWh) {
      expect(outcome).toBe("backwards");
    } else {
      expect(outcome).toBeUndefined();
      total += (endWh - startWh) / 1000;
      counted += 1;
    }
  }
  expect(day.housesEveningMetersMissing).toBe(
    searched ? Object.keys(detail.meter_outcomes).length + input.sources.houseMetersUnreadable : 0
  );
  if (counted === 0) expect(day.housesEveningKwh).toBeNull();
  else expect(day.housesEveningKwh).toBeCloseTo(total, 9);
}

/** These read hundreds of days; the default five seconds is too little on a loaded runner. */
const LONG = 120_000;

const DATES_2026 = Array.from({ length: 365 }, (_, i) => addDaysToDateKey("2026-01-01", i));
const RANDOM_SEEDS = 400;

describe("computeSiteDayDetail — tenant meter invariants", () => {
  it("hold on every 2026 fixture day of the examples' microgrid", () => {
    const outcomes = new Set<string>();
    let counted = 0;
    for (const date of DATES_2026) {
      const input = { ...fixtureInput(date), houseMeterIds: FIXTURE_METERS };
      const { day, detail } = computeSiteDayDetail(input);
      expectMeterInvariants(input, day, detail);
      for (const o of Object.values(detail.meter_outcomes)) outcomes.add(o);
      counted += Object.keys(detail.meter_readings).length - Object.keys(detail.meter_outcomes).length;
    }
    // No fixture scenario leaves a meter out of the evening yet (evidence
    // §11 change 6 adds those); the random samples reach every outcome.
    expect(outcomes).toEqual(new Set());
    expect(counted).toBe(3 * DATES_2026.length);
  }, LONG);

  it("hold on seeded random samples, with and without the meters asked for", () => {
    const outcomes = new Set<string>();
    let beforeEvening = 0;
    for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
      const { input, requested } = randomInput(seed);
      for (const asked of [input, { ...input, houseMeterIds: requested }]) {
        const { day, detail } = computeSiteDayDetail(asked);
        expectMeterInvariants(asked, day, detail);
        for (const o of Object.values(detail.meter_outcomes)) outcomes.add(o);
        if (detail.meter_window === null) beforeEvening += 1;
      }
    }
    expect(outcomes).toEqual(new Set(["no_start", "no_end", "backwards"]));
    expect(beforeEvening).toBeGreaterThan(0);
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

/**
 * computeSiteDay's figures for the inputs above, tenant meters included, as
 * computed before the meters asked for were an input: captured by running
 * main's computeSiteDay (38f80d8c) on these inputs, one digest over all the
 * fixture days and one over all the random seeds. Asking for exactly the
 * meters the samples hold, or for none, must give the same figures; asking
 * for a meter the samples leave out is the one intended change, so the
 * random inputs ask for the meters their samples hold. They hold only
 * while the fixture generator and randomInput give the same inputs; a
 * change that moves a figure on purpose recaptures them (and bumps
 * SITE_DAY_CALC_VERSION once it exists, evidence §11 change 5).
 */
const MAIN_FIXTURE_DIGEST = "0b5ffdf70cdc8cca";
const MAIN_RANDOM_DIGEST = "6f86f64d26057797";

describe("computeSiteDay — no figure moves with tenant meters", () => {
  it("gives main's figures whether or not the meters the samples hold are asked for", () => {
    const fixture = createHash("sha256");
    const fixtureAsked = createHash("sha256");
    for (const date of DATES_2026) {
      const input = fixtureInput(date);
      fixture.update(figuresDigest(computeSiteDay(input)));
      fixtureAsked.update(figuresDigest(computeSiteDay({ ...input, houseMeterIds: FIXTURE_METERS })));
    }
    const random = createHash("sha256");
    const randomAsked = createHash("sha256");
    for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
      const { input } = randomInput(seed);
      random.update(figuresDigest(computeSiteDay(input)));
      const held = Object.keys(input.samples.houseEnergyWh);
      randomAsked.update(figuresDigest(computeSiteDay({ ...input, houseMeterIds: held })));
    }
    const digests = {
      fixture: fixture.digest("hex").slice(0, 16),
      fixtureAsked: fixtureAsked.digest("hex").slice(0, 16),
      random: random.digest("hex").slice(0, 16),
      randomAsked: randomAsked.digest("hex").slice(0, 16),
    };
    expect(digests).toEqual({
      fixture: MAIN_FIXTURE_DIGEST,
      fixtureAsked: MAIN_FIXTURE_DIGEST,
      random: MAIN_RANDOM_DIGEST,
      randomAsked: MAIN_RANDOM_DIGEST,
    });
  }, LONG);
});
