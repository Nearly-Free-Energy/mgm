/**
 * site-samples.ts — deterministic synthetic site samples for the fixture
 * metering provider: a solar, battery and grid site with house meters.
 *
 * Pure: no clock, no I/O. Each local day is generated on its own from
 * `seed|microgridId|date`, so a day's samples do not depend on the window
 * requested. Bins follow `computeSiteDay`'s layout (site-operations.ts):
 * every `resolutionMinutes` from local midnight in the site's zone, so a
 * day with a DST change has more or fewer bins.
 */
import { addDaysToDateKey, startOfDayInZone } from "@/lib/timezone/day-key";
import { isSiteResolution, LOW_BATTERY_PCT } from "../site-operations";
import type { SiteSamples, SiteSamplesRequest } from "../types";

export const SITE_FIXTURE_SEED = "mgm-fixture-site-v1";

export type SiteScenario = "clear" | "evening-cut" | "long-cut-dark" | "floor-at-dawn" | "gateway-gap";

/** Cumulative weights, out of 100, in this order. */
const SCENARIOS: [SiteScenario, number][] = [
  ["clear", 40],
  ["evening-cut", 65],
  ["long-cut-dark", 80],
  ["floor-at-dawn", 90],
  ["gateway-gap", 100],
];

type Window = [startMinute: number, endMinute: number];
const at = (hour: number, minute = 0) => hour * 60 + minute;

/** Grid cuts and gateway gaps per scenario, in local minutes of the day. */
const CUTS: Record<SiteScenario, Window[]> = {
  clear: [],
  "evening-cut": [[at(19, 10), at(20, 40)]],
  "long-cut-dark": [[at(18, 30), at(22, 30)]],
  "floor-at-dawn": [[at(5), at(6, 30)]],
  "gateway-gap": [],
};
const GATEWAY_GAPS: Record<SiteScenario, Window[]> = {
  clear: [],
  "evening-cut": [],
  "long-cut-dark": [],
  "floor-at-dawn": [],
  "gateway-gap": [[at(10), at(10, 45)]],
};

const BATTERY_WH = 10_000;
/** The battery's floor, %: the one the Operations view reads as dark. */
const SOC_FLOOR = LOW_BATTERY_PCT;
const MAX_BATTERY_W = 2_500;
const PV_PEAK_W = 3_000;
const SUNRISE = at(6, 30);
const SUNSET = at(18, 30);
/** Hours in which the battery, not the grid, carries the load: evening and night. */
const BATTERY_FROM = at(18);
const BATTERY_UNTIL = at(7);
/**
 * House counters advance by a share of this per day since the epoch, plus
 * the day's own use, which stays below it: so a counter never goes back
 * across midnight, though each day is generated on its own.
 */
const DAY_LOAD_CAP_WH = 24_000;
const COUNTER_EPOCH_MS = Date.UTC(2020, 0, 1);
/** The share of the site's load that passes through house meters. */
const HOUSES_SHARE = 0.85;

/** FNV-1a, 32 bit. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small seeded generator, uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The day's generator; its first draw picks the scenario. */
function dayRandom(seed: string, microgridId: string, date: string) {
  const random = mulberry32(fnv1a(`${seed}|${microgridId}|${date}`));
  const draw = random() * 100;
  const scenario = SCENARIOS.find(([, upTo]) => draw < upTo)?.[0] ?? "clear";
  return { random, scenario };
}

/** The scenario a microgrid's local day follows. */
export function siteScenario(seed: string, microgridId: string, date: string): SiteScenario {
  return dayRandom(seed, microgridId, date).scenario;
}

const inAny = (minute: number, windows: Window[]) =>
  windows.some(([start, end]) => minute >= start && minute < end);

const round1 = (value: number) => Math.round(value * 10) / 10;

type LocalTime = { date: string; minute: number };

function localClock(timezone: string): (ms: number) => LocalTime {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (ms) => {
    const p = Object.fromEntries(format.formatToParts(ms).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
  };
}

type DayState = {
  scenario: SiteScenario;
  random: () => number;
  cloud: number;
  socPct: number;
  /** Load served so far today, Wh. */
  servedWh: number;
  dayIndex: number;
};

function startDay(seed: string, microgridId: string, date: string): DayState {
  const { random, scenario } = dayRandom(seed, microgridId, date);
  const cloud =
    scenario === "long-cut-dark" ? 0.25 + 0.1 * random() : 0.6 + 0.4 * random();
  // floor-at-dawn starts low enough to reach the floor in the small hours.
  const socPct =
    scenario === "floor-at-dawn" ? 31 + 2 * random()
    : scenario === "long-cut-dark" ? 25 + 5 * random()
    : 45 + 25 * random();
  return {
    scenario,
    random,
    cloud,
    socPct,
    servedWh: 0,
    dayIndex: Math.round((Date.parse(`${date}T00:00:00Z`) - COUNTER_EPOCH_MS) / 86_400_000),
  };
}

/**
 * Samples from local midnight of `startDate` to local midnight after
 * `endDate`, one bin every `resolutionMinutes`. A source that is null in
 * `request.sources` gives an all-null series, never zeros; a gap (gateway
 * down, or dark because the battery is at its floor in a cut) is null in
 * every series.
 */
export function generateSiteSamples(
  request: SiteSamplesRequest,
  seed: string = SITE_FIXTURE_SEED,
): SiteSamples {
  const { microgridId, sources, timezone, resolutionMinutes } = request;
  if (!isSiteResolution(resolutionMinutes)) {
    throw new RangeError("resolutionMinutes must be a whole number of minutes that divides an hour");
  }
  const binMs = resolutionMinutes * 60_000;
  const hours = resolutionMinutes / 60;
  const startMs = startOfDayInZone(request.startDate, timezone).getTime();
  const endMs = startOfDayInZone(addDaysToDateKey(request.endDate, 1), timezone).getTime();
  const clock = localClock(timezone);

  const houseIds = sources.houseMeters.map((meter) => meter.id);
  const houseWeights = houseIds.map((id) => 1 + (fnv1a(`${seed}|${id}|weight`) % 1000) / 1000);
  const weightSum = houseWeights.reduce((sum, w) => sum + w, 0);
  const houseBaseWh = houseIds.map((id) => 1_000_000 + (fnv1a(`${seed}|${id}|base`) % 1_000_000));

  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: Object.fromEntries(houseIds.map((id) => [id, []])),
  };

  let day: DayState | null = null;
  let dayDate = "";
  for (let t = startMs; t < endMs; t += binMs) {
    const local = clock(t);
    if (local.date !== dayDate) {
      dayDate = local.date;
      day = startDay(seed, microgridId, local.date);
    }
    const d = day as DayState;
    const minute = local.minute;
    const mid = minute + resolutionMinutes / 2;
    const noise = (spread: number) => (d.random() * 2 - 1) * spread;

    const pvW =
      mid > SUNRISE && mid < SUNSET
        ? Math.max(0, PV_PEAK_W * d.cloud * Math.sin((Math.PI * (mid - SUNRISE)) / (SUNSET - SUNRISE)) + noise(60))
        : 0;
    const evening = minute >= at(18) && minute < at(23);
    const loadW = Math.max(0, (evening ? 1_500 : 400) + noise(evening ? 120 : 40));
    const voltage = 230 + noise(4);
    const inCut = inAny(minute, CUTS[d.scenario]);
    const gatewayDown = inAny(minute, GATEWAY_GAPS[d.scenario]);
    const dark = inCut && d.socPct <= SOC_FLOOR && loadW > pvW;

    const maxDischargeW = Math.min(MAX_BATTERY_W, (((d.socPct - SOC_FLOOR) / 100) * BATTERY_WH) / hours);
    const maxChargeW = Math.min(MAX_BATTERY_W, (((100 - d.socPct) / 100) * BATTERY_WH) / hours);
    const deficitW = loadW - pvW;
    let batteryW = 0;
    if (dark) batteryW = 0;
    else if (deficitW < 0) batteryW = -Math.min(-deficitW, maxChargeW);
    else if (inCut || minute >= BATTERY_FROM || minute < BATTERY_UNTIL) {
      batteryW = Math.min(deficitW, maxDischargeW);
    }
    // In a cut the grid carries nothing; what the battery and solar cannot
    // cover is not served.
    const gridW = inCut || dark ? 0 : loadW - pvW - batteryW;
    const servedW = dark ? 0 : inCut ? Math.min(loadW, pvW + batteryW) : loadW;
    d.socPct = Math.min(100, Math.max(SOC_FLOOR, d.socPct - ((batteryW * hours) / BATTERY_WH) * 100));
    const servedBeforeWh = d.servedWh;
    d.servedWh += servedW * hours;

    const offline = gatewayDown || dark;
    const value = (present: unknown, v: number) => (offline || present === null ? null : v);
    out.timestamps.push(t);
    out.batterySocPct.push(value(sources.battery, round1(d.socPct)));
    out.batteryPowerW.push(value(sources.battery, Math.round(batteryW)));
    out.gridPowerW.push(value(sources.gridMeter, Math.round(gridW)));
    out.gridVoltageV.push(value(sources.gridMeter, inCut ? 0 : round1(voltage)));
    out.loadPowerW.push(value(sources.load, Math.round(loadW)));
    out.pvPowerW.push(value(sources.pv, Math.round(pvW)));
    // A counter's bin value is about its reading at the bin's middle.
    const servedMidWh = (servedBeforeWh + d.servedWh) / 2;
    houseIds.forEach((id, i) => {
      const share = (HOUSES_SHARE * houseWeights[i]) / weightSum;
      const counter = houseBaseWh[i] + share * (d.dayIndex * DAY_LOAD_CAP_WH + servedMidWh);
      out.houseEnergyWh[id].push(offline ? null : Math.round(counter));
    });
  }
  return out;
}
