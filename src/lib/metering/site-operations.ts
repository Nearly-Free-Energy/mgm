/**
 * site-operations.ts — one local day of a site's battery, grid and supply,
 * worked out from binned samples (the daily operations view).
 *
 * Pure: no database, no vendor client, no clock. The caller passes `nowMs`
 * so a day still in progress stops at the present instead of reading the
 * rest of it as missing.
 *
 * Definitions (they follow the operator's own daily site report for a
 * hybrid-inverter site whose gateway runs on the inverter's output; if that
 * wiring or the report's definitions change, revisit them):
 * - Grid present: the bin's mean voltage on the grid meter's highest phase
 *   is at or above `GRID_PRESENT_MIN_V`. A bin is a mean, so a bin whose
 *   grid was off for most of it reads well below nominal even if the grid
 *   flickered back: half of nominal keeps such a bin inside its cut rather
 *   than splitting the cut in two (checked against a real day's 1-minute
 *   report). Revisit if the bin length or the nominal voltage changes.
 * - Dark: no samples arrived while the last known grid state was a cut.
 *   The gateway runs on the inverter's output, so it goes quiet when the
 *   battery has cut off during a cut: the houses are without power. A gap
 *   while the grid was present is reported as missing data, not as dark.
 * - A cut continues through a gap until a sample shows the grid back.
 */
import { addDaysToDateKey, startOfDayInZone } from "@/lib/timezone/day-key";
import { zonedDateTimeToUtcIso } from "@/lib/timezone/wall-clock";
import type { SiteSamples } from "./types";

/** A bin's mean voltage below this on every phase is a cut (half of 230 V). */
export const GRID_PRESENT_MIN_V = 115;
/** Battery discharge or grid import above this counts as supplying. */
export const SUPPLY_MIN_W = 50;
/** The evening selling window, local hours [start, end). */
export const EVENING_START_HOUR = 18;
/** The hour whose battery level is reported before the evening window. */
export const SOC_CHECK_HOUR = 17;

export type SiteSourceAvailability = {
  battery: boolean;
  gridMeter: boolean;
  load: boolean;
  pv: boolean;
};

export type TimeRange = { startMs: number; endMs: number };

export type EveningSupply =
  | "battery"
  | "battery_and_grid"
  | "grid"
  | "dark"
  | "no_data";

export type EveningSegment = TimeRange & { supply: EveningSupply };

/**
 * One bin's power flows, for valuing the day against a time-of-use tariff.
 * Every bin read has one, offline bins included (all powers null).
 */
export type SiteFlow = {
  atMs: number;
  /** Local wall-clock hour of the bin start in the day's timezone, 0–23. */
  hour: number;
  /** + discharge, − charge. */
  batteryW: number | null;
  /** + import, − export. */
  gridW: number | null;
  /**
   * Solar output: the solar meter clipped at 0 when the site has one, else
   * load − grid − battery clipped at 0 when all three were read, else null.
   */
  solarW: number | null;
  /** Grid state carried through gaps, as for cuts; null while unknown. */
  gridPresent: boolean | null;
};

export type SiteDayOperations = {
  date: string;
  timezone: string;
  dayStartMs: number;
  dayEndMs: number;
  /** End of the period read: the day's end, or now for today. */
  readUntilMs: number;
  resolutionMinutes: number;
  /** Start of the evening window, and local hours 0, 3, … 24 for an axis. */
  eveningStartMs: number;
  hourMarks: { hour: number; atMs: number }[];
  sources: SiteSourceAvailability;
  /** kWh; null when neither a solar meter nor the balance is available. */
  solarKwh: number | null;
  /** True when solar is load − grid − battery rather than a solar meter. */
  solarEstimated: boolean;
  /** Battery discharge during the evening window, kWh. */
  eveningDischargeKwh: number | null;
  /** Null without a grid meter, or when it gave no voltage reading. */
  cuts: TimeRange[] | null;
  cutMinutes: number | null;
  lowestSoc: { pct: number; atMs: number; duringCut: boolean } | null;
  socAtCheckHour: number | null;
  dark: TimeRange[];
  darkMinutes: number;
  /** Minutes with no samples that were not dark (gateway or link down, or
   *  no grid reading yet to tell). */
  noDataMinutes: number;
  /**
   * Share of the period read with power at the houses, 0–100, over the time
   * whose state is known (no-data time is left out).
   */
  lightsOnPct: number | null;
  /** Minutes of the period read whose state is known (read − no data). */
  knownMinutes: number;
  soc: { atMs: number; pct: number | null }[];
  evening: EveningSegment[];
  eveningHours: Record<EveningSupply, number>;
  /**
   * Per-bin flows. Large (288 entries a day): a server page strips it before
   * passing a day to a client component.
   */
  flows: SiteFlow[];
};

/**
 * A day without its per-bin flows: what a server page passes to a client
 * component (the flows are large and only the savings figures need them).
 */
export type SiteDaySummary = Omit<SiteDayOperations, "flows">;

type Bin = {
  startMs: number;
  online: boolean;
  soc: number | null;
  batteryW: number | null;
  gridW: number | null;
  volts: number | null;
  loadW: number | null;
  pvW: number | null;
  /** Grid state, carried through gaps; null while still unknown. */
  gridPresent: boolean | null;
  dark: boolean;
};

const MINUTE = 60_000;

/**
 * The instant a local wall-clock hour starts on `date`. An hour that a DST
 * change skips resolves to the first instant at or after it, so every hour
 * of a real day has an answer.
 */
function localInstant(date: string, hour: number, timezone: string): number {
  if (hour === 0) return startOfDayInZone(date, timezone).getTime();
  if (hour >= 24) return startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime();
  const wall = `${date}T${String(hour).padStart(2, "0")}:00`;
  const iso = zonedDateTimeToUtcIso(wall, timezone);
  if (iso) return Date.parse(iso);
  const clock = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const wallAt = (ms: number) => {
    const p = Object.fromEntries(clock.formatToParts(ms).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  // Binary-search the first millisecond of the day whose wall clock is not
  // before the requested hour.
  let low = startOfDayInZone(date, timezone).getTime();
  let high = startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime();
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (wallAt(mid) < wall) low = mid + 1;
    else high = mid;
  }
  return low;
}

function ranges(bins: Bin[], test: (bin: Bin) => boolean, binMs: number): TimeRange[] {
  const out: TimeRange[] = [];
  for (const bin of bins) {
    if (!test(bin)) continue;
    const last = out.at(-1);
    if (last && last.endMs === bin.startMs) last.endMs = bin.startMs + binMs;
    else out.push({ startMs: bin.startMs, endMs: bin.startMs + binMs });
  }
  return out;
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/** The local wall-clock hour (0–23) of an instant in `timezone`. */
function localHour(ms: number, timezone: string): number {
  let formatter = hourFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    });
    hourFormatters.set(timezone, formatter);
  }
  return Number(formatter.format(ms)) % 24;
}

const minutesOf = (list: TimeRange[]) =>
  list.reduce((sum, r) => sum + (r.endMs - r.startMs) / MINUTE, 0);

/**
 * Work out one local day. `samples` may start before the day (the previous
 * day's tail tells whether the day began in a cut); bins outside the day
 * only feed that carried state.
 */
export function computeSiteDay(input: {
  date: string;
  timezone: string;
  samples: SiteSamples;
  sources: SiteSourceAvailability;
  resolutionMinutes: number;
  nowMs: number;
}): SiteDayOperations {
  const { date, timezone, samples, sources, resolutionMinutes, nowMs } = input;
  const binMs = resolutionMinutes * MINUTE;
  const dayStartMs = startOfDayInZone(date, timezone).getTime();
  const dayEndMs = localInstant(date, 24, timezone);
  // Only whole bins that have started; today stops at the current bin.
  const readUntilMs = Math.max(
    dayStartMs,
    Math.min(dayEndMs, dayStartMs + Math.ceil((nowMs - dayStartMs) / binMs) * binMs)
  );

  // Carry-in: the grid state at the last sample before the day.
  let carried: boolean | null = null;
  const byBin = new Map<number, number>();
  samples.timestamps.forEach((t, i) => {
    if (t < dayStartMs) {
      const v = samples.gridVoltageV[i];
      if (v !== null) carried = v >= GRID_PRESENT_MIN_V;
      return;
    }
    if (t >= readUntilMs) return;
    const index = Math.floor((t - dayStartMs) / binMs);
    if (!byBin.has(index)) byBin.set(index, i);
  });

  const bins: Bin[] = [];
  const binCount = Math.round((readUntilMs - dayStartMs) / binMs);
  for (let index = 0; index < binCount; index++) {
    const i = byBin.get(index);
    const pick = (series: (number | null)[]) => (i === undefined ? null : series[i] ?? null);
    const soc = pick(samples.batterySocPct);
    const batteryW = pick(samples.batteryPowerW);
    const gridW = pick(samples.gridPowerW);
    const volts = pick(samples.gridVoltageV);
    const loadW = pick(samples.loadPowerW);
    const pvW = pick(samples.pvPowerW);
    const online = [soc, batteryW, gridW, volts, loadW, pvW].some((v) => v !== null);
    if (volts !== null) carried = volts >= GRID_PRESENT_MIN_V;
    bins.push({
      startMs: dayStartMs + index * binMs,
      online,
      soc,
      batteryW,
      gridW,
      volts,
      loadW,
      pvW,
      gridPresent: carried,
      dark: !online && carried === false,
    });
  }

  const kwh = (watts: number) => (watts * resolutionMinutes) / 60 / 1000;

  // Solar: a solar meter if there is one, else the balance at the inverter
  // (what the load drew that neither the grid nor the battery supplied).
  const solarEstimated = !sources.pv && sources.load && sources.battery && sources.gridMeter;
  const solarWOf = (b: Bin): number | null => {
    if (sources.pv) return b.pvW !== null ? Math.max(0, b.pvW) : null;
    if (!solarEstimated) return null;
    if (b.loadW === null || b.batteryW === null || b.gridW === null) return null;
    return Math.max(0, b.loadW - b.gridW - b.batteryW);
  };
  const flows: SiteFlow[] = bins.map((b) => ({
    atMs: b.startMs,
    hour: localHour(b.startMs, timezone),
    batteryW: b.batteryW,
    gridW: b.gridW,
    solarW: solarWOf(b),
    gridPresent: b.gridPresent,
  }));
  const solarKwh =
    sources.pv || solarEstimated
      ? flows.reduce((sum, f) => sum + (f.solarW !== null ? kwh(f.solarW) : 0), 0)
      : null;

  const eveningStartMs = localInstant(date, EVENING_START_HOUR, timezone);
  const eveningBins = bins.filter((b) => b.startMs >= eveningStartMs);
  const eveningDischargeKwh = sources.battery
    ? eveningBins.reduce(
        (sum, b) => sum + (b.batteryW !== null ? kwh(Math.max(0, b.batteryW)) : 0),
        0
      )
    : null;

  // Cuts need at least one voltage reading; without one they are unknown,
  // not zero.
  const gridKnown = bins.some((b) => b.gridPresent !== null);
  const cuts =
    sources.gridMeter && gridKnown ? ranges(bins, (b) => b.gridPresent === false, binMs) : null;
  const dark = ranges(bins, (b) => b.dark, binMs);
  const noData = ranges(bins, (b) => !b.online && !b.dark, binMs);
  const darkMinutes = minutesOf(dark);
  const noDataMinutes = minutesOf(noData);
  // Time with no data and no known cut is neither lit nor dark: it is left
  // out of the share rather than counted as lit.
  const knownMinutes = (readUntilMs - dayStartMs) / MINUTE - noDataMinutes;

  let lowestSoc: SiteDayOperations["lowestSoc"] = null;
  for (const b of bins) {
    if (b.soc === null) continue;
    if (!lowestSoc || b.soc < lowestSoc.pct) {
      lowestSoc = { pct: b.soc, atMs: b.startMs, duringCut: b.gridPresent === false };
    }
  }

  const checkMs = localInstant(date, SOC_CHECK_HOUR, timezone);
  const checkBin = bins.find((b) => b.startMs === checkMs);
  const socAtCheckHour = checkBin?.soc ?? null;

  const supplyOf = (b: Bin): EveningSupply => {
    if (b.dark) return "dark";
    if (!b.online) return "no_data";
    const discharging = b.batteryW !== null && b.batteryW > SUPPLY_MIN_W;
    const importing = b.gridPresent !== false && b.gridW !== null && b.gridW > SUPPLY_MIN_W;
    if (discharging && importing) return "battery_and_grid";
    if (discharging || b.gridPresent === false) return "battery";
    // Grid state not yet known (no voltage reading so far): import is
    // evidence of the grid; otherwise do not guess.
    if (b.gridPresent === null && b.gridW !== null && b.gridW > SUPPLY_MIN_W) return "grid";
    return b.gridPresent ? "grid" : "no_data";
  };
  const evening: EveningSegment[] = [];
  for (const b of eveningBins) {
    const supply = supplyOf(b);
    const last = evening.at(-1);
    if (last && last.supply === supply && last.endMs === b.startMs) last.endMs = b.startMs + binMs;
    else evening.push({ startMs: b.startMs, endMs: b.startMs + binMs, supply });
  }
  const eveningHours: Record<EveningSupply, number> = {
    battery: 0,
    battery_and_grid: 0,
    grid: 0,
    dark: 0,
    no_data: 0,
  };
  for (const s of evening) eveningHours[s.supply] += (s.endMs - s.startMs) / 3_600_000;

  return {
    date,
    timezone,
    dayStartMs,
    dayEndMs,
    readUntilMs,
    resolutionMinutes,
    eveningStartMs,
    hourMarks: [0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => ({
      hour,
      atMs: localInstant(date, hour, timezone),
    })),
    sources,
    solarKwh,
    solarEstimated,
    eveningDischargeKwh,
    cuts,
    cutMinutes: cuts ? minutesOf(cuts) : null,
    lowestSoc,
    socAtCheckHour,
    dark,
    darkMinutes,
    noDataMinutes,
    lightsOnPct: knownMinutes > 0 ? (100 * (knownMinutes - darkMinutes)) / knownMinutes : null,
    knownMinutes,
    soc: bins.map((b) => ({ atMs: b.startMs, pct: b.soc })),
    evening,
    eveningHours,
    flows,
  };
}
