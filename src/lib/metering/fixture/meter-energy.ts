/**
 * meter-energy.ts — deterministic synthetic energy for one meter, per local
 * hour and per local day, for the fixture provider's
 * `getDeviceEnergySeries` (the tenant usage views and their examples).
 *
 * Pure: no clock (the caller passes `nowMs`), no I/O. Each (meter, day) is
 * generated on its own from `seed|microgridId|deviceId|date`, so a meter's
 * figures never depend on the range or on the other meters asked for.
 *
 * Not `generateSiteSamples`: its house counters weight each meter by the
 * other meters in the same request and leave whole bins null in gateway
 * gaps and dark time, so a meter's figures there change with what else is
 * read. These figures are generated, not measured, and do not reconcile
 * with the site samples of the same microgrid.
 */
import {
  addDaysToDateKey,
  localHourStarts,
  startOfDayInZone,
} from "@/lib/timezone/day-key";
import { energySeriesAxis } from "../energy-series";
import type { DeviceEnergySeries, DeviceEnergySeriesRequest } from "../types";
import { fnv1a, mulberry32 } from "./random";

export const METER_FIXTURE_SEED = "mgm-fixture-meter-v1";

export type MeterEnergyOptions = {
  seed?: string;
  /**
   * Buckets that start at or after `nowMs` are null, and the bucket holding it
   * counts only up to it, so today reads as a partial day, as a real meter's.
   * Omitted: every bucket is whole.
   */
  nowMs?: number;
};

/** What a meter uses in a day, Wh: from this up to DAY_MAX_WH. */
const DAY_MIN_WH = 600;
const DAY_MAX_WH = 4_000;
/** The chance that a day has a block of hours the meter did not report. */
const GAP_CHANCE = 0.07;
const GAP_HOURS = 3;
/** Each hour's weight varies by up to this share either way. */
const HOUR_NOISE = 0.2;
const HOUR_MS = 3_600_000;

/** An hour's share of the day by its local hour: busier at breakfast, most in the evening. */
function hourWeight(hour: number): number {
  if (hour >= 6 && hour < 8) return 2;
  if (hour >= 18 && hour < 22) return 4;
  return 1;
}

const hourFormats = new Map<string, Intl.DateTimeFormat>();

function localHour(epochMs: number, timezone: string): number {
  let format = hourFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" });
    hourFormats.set(timezone, format);
  }
  return Number(format.format(epochMs));
}

/**
 * Wh a synthetic meter counts in each local hour of `date`: a function of
 * (seed, microgridId, deviceId, date) only, laid on the hours `date` has in
 * `timezone` (23 or 25 on a daylight-saving day). Integer Wh; null for the
 * hours of a block the meter "did not report". A day's hours sum to its day.
 */
export function syntheticMeterDay(
  seed: string,
  microgridId: string,
  deviceId: string,
  date: string,
  timezone: string
): { starts: number[]; wh: (number | null)[] } {
  const random = mulberry32(fnv1a(`${seed}|${microgridId}|${deviceId}|${date}`));
  const starts = localHourStarts(date, timezone);
  // Every draw is made whatever the earlier ones gave, so a day's figures
  // depend on nothing but its inputs.
  const dayWh = DAY_MIN_WH + random() * (DAY_MAX_WH - DAY_MIN_WH);
  const gap = random() < GAP_CHANCE;
  const gapStart = Math.floor(random() * Math.max(1, starts.length - GAP_HOURS + 1));
  const weights = starts.map(
    (start) => hourWeight(localHour(start, timezone)) * (1 + (random() * 2 - 1) * HOUR_NOISE)
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return {
    starts,
    wh: weights.map((weight, i) =>
      gap && i >= gapStart && i < gapStart + GAP_HOURS ? null : Math.round((dayWh * weight) / total)
    ),
  };
}

/**
 * A synthetic meter energy series for each device of `request`, from
 * `syntheticMeterDay`: kWh per local hour, or per local day as the sum of its
 * hours (null when any of its hours up to `nowMs` did not report). With
 * `nowMs`, hours that start at or after it are null and the hour holding it
 * counts only up to it; a day's sum then covers only its hours up to now, and
 * a day that starts at or after now is null.
 *
 * Throws MeteringError METERING_INVALID_DATA 400 for a request
 * `energySeriesAxis` refuses.
 */
export function generateDeviceEnergySeries(
  request: DeviceEnergySeriesRequest,
  options: MeterEnergyOptions = {}
): DeviceEnergySeries {
  const axis = energySeriesAxis(request);
  const seed = options.seed ?? METER_FIXTURE_SEED;
  const { nowMs } = options;
  const { microgridId, timezone } = request;
  const dates: string[] = [];
  for (let date = request.startDate; date <= request.endDate; date = addDaysToDateKey(date, 1)) {
    dates.push(date);
  }

  const kwh: Record<string, (number | null)[]> = {};
  for (const device of request.devices) {
    const values: (number | null)[] = [];
    for (const date of dates) {
      const { starts, wh } = syntheticMeterDay(seed, microgridId, device.id, date, timezone);
      const dayEnd = startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime();
      const hours: (number | null)[] = [];
      // The day's sum so far; null once an hour up to now did not report.
      let dayWh: number | null = 0;
      for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const value = wh[i];
        if (nowMs !== undefined && start >= nowMs) {
          // Not reached yet: neither counted nor missing.
          hours.push(null);
        } else if (value === null) {
          hours.push(null);
          dayWh = null;
        } else {
          const end = Math.min(start + HOUR_MS, starts[i + 1] ?? dayEnd);
          const counted = nowMs !== undefined && nowMs < end
            ? Math.round((value * (nowMs - start)) / (end - start))
            : value;
          hours.push(counted);
          if (dayWh !== null) dayWh += counted;
        }
      }
      if (request.resolution === "hour") {
        values.push(...hours.map((value) => (value === null ? null : value / 1000)));
      } else {
        const started = nowMs === undefined || starts[0] < nowMs;
        values.push(started && dayWh !== null ? dayWh / 1000 : null);
      }
    }
    if (values.length !== axis.buckets.length) {
      // localHourStarts lays out both, so this cannot differ; if it ever
      // does, a value would sit in the wrong bucket.
      throw new RangeError("Synthetic meter energy does not match the series axis");
    }
    kwh[device.id] = values;
  }
  return { buckets: axis.buckets, kwh };
}
