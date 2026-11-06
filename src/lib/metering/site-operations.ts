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
 * - Grid present: the bin's mean voltage on the grid meter's lowest phase
 *   is at or above `GRID_PRESENT_MIN_V`, so a cut is any phase below it,
 *   the rule the operator's other reports use. A bin is a mean, so a phase
 *   off for about a third of the bin or more averages below 170 V, and a
 *   flicker back stays inside its cut rather than splitting it in two. If
 *   the other reports' threshold or the bin length changes, revisit this.
 * - Dark: a gap (bins with no samples) that starts while the last known
 *   grid state is a cut. The gateway runs on the inverter's output, so it
 *   goes quiet when the battery has cut off during a cut: the houses are
 *   without power.
 * - Dark, inferred: a gap that starts while the last known battery level is
 *   at or below `LOW_BATTERY_PCT`, whatever the last grid reading said.
 *   With the battery at its floor the gateway dies within seconds of the
 *   grid dropping, before any sample shows the cut. Houses dark on such a
 *   site means the grid was off, so these bins also count as a cut.
 * - Any other gap is missing data, not dark, and is left out of the
 *   lights-on share.
 * - A cut continues through a gap until a sample shows the grid back.
 * - Houses used, evening: what the household meters' cumulative consumption
 *   counters advanced over the evening window (the report's "sold 18–24h").
 *   A bin's value is the counter's mean over the bin, about its reading at
 *   the bin's middle, so a meter's start is its reading in the bin before
 *   18:00 and its end its reading in the last bin read: a full window,
 *   half a bin early. A start may come from up to half an hour before that
 *   bin, or failing that from the window's first bin, never from the day
 *   before; an end, later than the start, from up to half an hour before
 *   the last bin. A meter without both, whose counter went backwards (reset
 *   or replaced), or without the identifiers to be read at all, is counted
 *   as missing and left out of the sum rather than read as zero.
 * - Battery supplied, evening: the battery's discharge over the same
 *   window. It differs from what the houses used by the grid's share,
 *   conversion losses and the site's own use.
 */
import { addDaysToDateKey, startOfDayInZone } from "@/lib/timezone/day-key";
import { zonedDateTimeToUtcIso } from "@/lib/timezone/wall-clock";
import type { SiteSamples } from "./types";

/** A bin's mean voltage below this on any phase is a cut. */
export const GRID_PRESENT_MIN_V = 170;
/**
 * The battery's discharge floor, %: at or below it the inverter stops
 * drawing on the battery. The gateway runs on the inverter's output and
 * cannot outlive the battery, so a gap that starts here is dark. If the
 * inverter's discharge cut-off setting changes, revisit this.
 */
export const LOW_BATTERY_PCT = 15;
/**
 * How long after a bin closes before its samples are read. OpenEMS stores
 * a bin's mean once the edge's values for it have reached the backend, and
 * the last minute or two of them may still be on the way: reading a bin
 * that just closed would show it short or empty. If the edges' upload
 * interval or the backend's write delay grows, revisit this.
 */
export const INGESTION_LAG_MS = 2 * 60_000;
/** Battery discharge or grid import above this counts as supplying. */
export const SUPPLY_MIN_W = 50;
/** The evening selling window, local hours [start, end). */
export const EVENING_START_HOUR = 18;
/**
 * How far a house meter's readings may sit from the window's edges: its
 * start up to this long before the bin before 18:00, its end up to this
 * long before the last bin read. A meter with a longer gap is counted as
 * missing rather than as having used less.
 */
export const HOUSE_READING_TOLERANCE_MS = 30 * 60_000;
/** The hour whose battery level is reported before the evening window. */
export const SOC_CHECK_HOUR = 17;

/**
 * The finest bin a day can be read at, in minutes. A bin is a whole number
 * of minutes that divides an hour (isSiteResolution, which computeSiteDay
 * and the fixture generator enforce), so one minute is the finest any
 * provider can be asked for. Every bound on how many bins, bands or
 * segments a day holds derives from it.
 */
export const FINEST_RESOLUTION_MINUTES = 1;
/**
 * The clock change, in hours, a day's bounds allow for. Two hours covers
 * every zone whose clocks change each year: Antarctica/Troll goes from
 * +02:00 to +00:00 each October, a 26-hour day, and Asia/Beirut's change at
 * local midnight puts its extra hour inside the evening (18:00–24:00 lasts
 * seven hours). Some zones have had larger changes (Antarctica/Casey went
 * back three hours in several years up to 2023; Pacific/Kwajalein's
 * 30 September 1969 lasted 47 hours). So this is an allowance, not the
 * largest change in the tz database: computeSiteDay refuses a day with more
 * bins than these bounds hold at the resolution it is asked for, and any
 * day it returns fits the caps that derive from them. If a zone in use
 * starts changing by more, raise this.
 */
export const CLOCK_CHANGE_ALLOWANCE_HOURS = 2;
/** Minutes in the longest local day computeSiteDay reads. */
export const MAX_DAY_MINUTES = (24 + CLOCK_CHANGE_ALLOWANCE_HOURS) * 60;
/** Minutes in the longest evening window computeSiteDay reads: 18:00–24:00 plus the allowance. */
export const MAX_EVENING_MINUTES = (24 - EVENING_START_HOUR + CLOCK_CHANGE_ALLOWANCE_HOURS) * 60;
/** The most bins one day holds, at the finest resolution on the longest day. */
export const MAX_DAY_BINS = MAX_DAY_MINUTES / FINEST_RESOLUTION_MINUTES;
/** The most bins the evening window holds, at the finest resolution. */
export const MAX_EVENING_BINS = MAX_EVENING_MINUTES / FINEST_RESOLUTION_MINUTES;

/** Whether `minutes` is a bin length a day can be read at: whole, at least the finest, dividing an hour. */
export function isSiteResolution(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= FINEST_RESOLUTION_MINUTES && 60 % minutes === 0;
}

export type SiteSourceAvailability = {
  battery: boolean;
  gridMeter: boolean;
  load: boolean;
  pv: boolean;
  /** At least one household meter is linked, readable or not. */
  houses: boolean;
  /** Linked household meters without the identifiers to read them. */
  houseMetersUnreadable: number;
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
  /**
   * End of the period read: the day's end or, for today, the end of the
   * last bin that closed at least `INGESTION_LAG_MS` ago.
   */
  readUntilMs: number;
  resolutionMinutes: number;
  /** Start of the evening window, and local hours 0, 3, … 24 for an axis. */
  eveningStartMs: number;
  hourMarks: { hour: number; atMs: number }[];
  sources: SiteSourceAvailability;
  /**
   * kWh; null when neither a solar meter nor the balance is available, or
   * when no bin had a usable reading (never a zero for missing telemetry).
   */
  solarKwh: number | null;
  /** True when solar is load − grid − battery rather than a solar meter. */
  solarEstimated: boolean;
  /**
   * Battery discharge during the evening window, kWh. Null without a
   * battery, before the window starts, or when no evening bin had a battery
   * power reading.
   */
  eveningDischargeKwh: number | null;
  /**
   * What the houses used in the evening window, kWh: the sum over house
   * meters of their counter's rise. Null without house meters, before the
   * window starts, or when no meter has both readings.
   */
  housesEveningKwh: number | null;
  /**
   * Linked house meters left out of `housesEveningKwh`: without readings at
   * both ends of the window, counter gone backwards, or not readable at all.
   */
  housesEveningMetersMissing: number;
  /** Null without a grid meter, or when it gave no voltage reading. */
  cuts: TimeRange[] | null;
  cutMinutes: number | null;
  lowestSoc: { pct: number; atMs: number; duringCut: boolean } | null;
  socAtCheckHour: number | null;
  dark: TimeRange[];
  darkMinutes: number;
  /**
   * The part of `darkMinutes` inferred from a low battery: gaps that began
   * with the battery at or below `LOW_BATTERY_PCT` and the grid not known
   * to be off.
   */
  darkInferredMinutes: number;
  /**
   * Minutes with no samples that were not dark: gaps that began with the
   * grid not known to be off and the battery above `LOW_BATTERY_PCT` or
   * unknown (gateway or link down, or nothing yet to tell).
   */
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
  /** Set when the samples came from a synthetic provider; computeSiteDay never sets it. */
  synthetic?: true;
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
  /** Dark because the gap began with the battery at its floor. */
  darkInferred: boolean;
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
  if (!isSiteResolution(resolutionMinutes)) {
    throw new RangeError("resolutionMinutes must be a whole number of minutes that divides an hour");
  }
  const binMs = resolutionMinutes * MINUTE;
  const dayStartMs = startOfDayInZone(date, timezone).getTime();
  const dayEndMs = localInstant(date, 24, timezone);
  const eveningStartMs = localInstant(date, EVENING_START_HOUR, timezone);
  // The ext's caps (site-day-ext.ts) allow one band or segment per bin of
  // these bounds; a day with more bins than they hold is refused here, so
  // every day returned parses.
  if (
    Math.ceil((dayEndMs - dayStartMs) / binMs) > MAX_DAY_BINS ||
    Math.ceil((dayEndMs - eveningStartMs) / binMs) > MAX_EVENING_BINS
  ) {
    throw new RangeError(`${date} in ${timezone} has more ${resolutionMinutes}-minute bins than a day's bounds allow`);
  }
  // Only whole bins that closed at least the ingestion lag ago; a finished
  // day reads to its end.
  const readUntilMs = Math.max(
    dayStartMs,
    Math.min(
      dayEndMs,
      dayStartMs + Math.floor((nowMs - INGESTION_LAG_MS - dayStartMs) / binMs) * binMs
    )
  );

  // Carry-in: the grid state and battery level at the last sample before
  // the day.
  let carried: boolean | null = null;
  let lastSoc: number | null = null;
  const byBin = new Map<number, number>();
  samples.timestamps.forEach((t, i) => {
    if (t < dayStartMs) {
      const v = samples.gridVoltageV[i];
      if (v !== null) carried = v >= GRID_PRESENT_MIN_V;
      const soc = samples.batterySocPct[i];
      if (soc !== null) lastSoc = soc;
      return;
    }
    if (t >= readUntilMs) return;
    const index = Math.floor((t - dayStartMs) / binMs);
    if (!byBin.has(index)) byBin.set(index, i);
  });

  const bins: Bin[] = [];
  const binCount = Math.round((readUntilMs - dayStartMs) / binMs);
  // What the current gap is, decided when it starts; null while online.
  let gap: "dark" | "inferred" | "no_data" | null = null;
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
    if (online) {
      gap = null;
      if (volts !== null) carried = volts >= GRID_PRESENT_MIN_V;
      if (soc !== null) lastSoc = soc;
    } else if (gap === null) {
      if (carried === false) gap = "dark";
      else if (lastSoc !== null && lastSoc <= LOW_BATTERY_PCT) {
        gap = "inferred";
        // The houses went dark, so the grid was off: a cut from here until
        // a voltage reading shows the grid back.
        carried = false;
      } else gap = "no_data";
    }
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
      dark: !online && (gap === "dark" || gap === "inferred"),
      darkInferred: !online && gap === "inferred",
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
  // Null rather than zero when no bin had a usable reading.
  const solarRead = flows.filter((f) => f.solarW !== null);
  const solarKwh = solarRead.length ? solarRead.reduce((sum, f) => sum + kwh(f.solarW!), 0) : null;

  const eveningBins = bins.filter((b) => b.startMs >= eveningStartMs);
  // Null before the window (no evening bins) and when no evening bin had a
  // battery power reading.
  const eveningBattery = eveningBins.filter((b) => b.batteryW !== null);
  const eveningDischargeKwh =
    sources.battery && eveningBattery.length
      ? eveningBattery.reduce((sum, b) => sum + kwh(Math.max(0, b.batteryW!)), 0)
      : null;

  // Houses: each meter's counter rise across the window. OpenEMS gives a
  // bin's mean, so a counter's value in a bin is about its reading at the
  // bin's middle; reading from the bin before 18:00 to the window's last bin
  // spans the full window, shifted half a bin earlier.
  let housesEveningKwh: number | null = null;
  let housesEveningMetersMissing = 0;
  const houseSeries = sources.houses ? Object.values(samples.houseEnergyWh ?? {}) : [];
  if (sources.houses && readUntilMs > eveningStartMs) {
    housesEveningMetersMissing = sources.houseMetersUnreadable;
    // The window's first bin, and the latest bin read so far.
    const firstEveningIndex = bins.findIndex((b) => b.startMs >= eveningStartMs);
    const lastIndex = bins.length - 1;
    const toleranceBins = Math.round(HOUSE_READING_TOLERANCE_MS / binMs);
    let total = 0;
    let counted = 0;
    for (const series of houseSeries) {
      const valueAt = (index: number) => {
        const i = byBin.get(index);
        return i === undefined ? null : series[i] ?? null;
      };
      // Start: the latest reading in the half hour before the window, else
      // the window's first bin.
      let startIndex: number | null = null;
      for (let index = firstEveningIndex - 1; index >= 0; index--) {
        if (index < firstEveningIndex - 1 - toleranceBins) break;
        if (valueAt(index) !== null) {
          startIndex = index;
          break;
        }
      }
      if (startIndex === null && firstEveningIndex >= 0 && valueAt(firstEveningIndex) !== null) {
        startIndex = firstEveningIndex;
      }
      // End: the latest reading after the start, within the half hour
      // before the last bin read. A meter that went silent earlier would
      // otherwise count as having used less.
      let endIndex: number | null = null;
      if (startIndex !== null) {
        for (let index = lastIndex; index > startIndex; index--) {
          if (index < lastIndex - toleranceBins) break;
          if (valueAt(index) !== null) {
            endIndex = index;
            break;
          }
        }
      }
      const startWh = startIndex === null ? null : valueAt(startIndex);
      const endWh = endIndex === null ? null : valueAt(endIndex);
      if (startWh === null || endWh === null || endWh < startWh) {
        housesEveningMetersMissing += 1;
        continue;
      }
      total += (endWh - startWh) / 1000;
      counted += 1;
    }
    housesEveningKwh = counted > 0 ? total : null;
  }

  // Cuts need at least one voltage reading; without one they are unknown,
  // not zero.
  const gridKnown = bins.some((b) => b.gridPresent !== null);
  const cuts =
    sources.gridMeter && gridKnown ? ranges(bins, (b) => b.gridPresent === false, binMs) : null;
  const dark = ranges(bins, (b) => b.dark, binMs);
  const noData = ranges(bins, (b) => !b.online && !b.dark, binMs);
  const darkMinutes = minutesOf(dark);
  const darkInferredMinutes = minutesOf(ranges(bins, (b) => b.darkInferred, binMs));
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
    housesEveningKwh,
    housesEveningMetersMissing,
    cuts,
    cutMinutes: cuts ? minutesOf(cuts) : null,
    lowestSoc,
    socAtCheckHour,
    dark,
    darkMinutes,
    darkInferredMinutes,
    noDataMinutes,
    lightsOnPct: knownMinutes > 0 ? (100 * (knownMinutes - darkMinutes)) / knownMinutes : null,
    knownMinutes,
    soc: bins.map((b) => ({ atMs: b.startMs, pct: b.soc })),
    evening,
    eveningHours,
    flows,
  };
}
