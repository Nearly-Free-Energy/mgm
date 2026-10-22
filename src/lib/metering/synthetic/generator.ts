/**
 * Deterministic synthetic meter readings (issue #44).
 *
 * Pure functions of (seed, meter, day): no clock, no randomness outside the
 * seeded generator, no I/O. The same inputs always give the same output, on
 * any machine. Missing data is `null`, never zero.
 */
import { MeteringError } from "../errors";
import {
  BOUNDARY_GAP_DAY,
  INTERIOR_GAP,
  type SyntheticMeter,
  type SyntheticProfile,
} from "./dataset";

export const DEFAULT_SYNTHETIC_SEED = "mgm-synthetic-demo-v1";
export const MAX_SYNTHETIC_DAYS = 366;

/** Daily usage band per profile, in kWh. */
export const DAILY_KWH_RANGE: Record<SyntheticProfile, readonly [number, number]> = {
  low: [0.3, 1.2],
  typical: [1.0, 3.5],
  high: [3.0, 8.0],
  "interior-gap": [1.0, 3.5],
  "boundary-gap": [1.0, 3.5],
  "no-data": [1.0, 3.5],
};

const WEEKEND_FACTOR = 1.15;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small seeded generator returning [0, 1). */
function seeded(seedValue: number): () => number {
  let a = seedValue;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function invalid(message: string, details?: unknown): MeteringError {
  return new MeteringError(message, "METERING_INVALID_DATA", 400, details);
}

function parseDay(day: string): Date {
  const match = DAY_RE.exec(day);
  if (!match) throw invalid(`Invalid date "${day}"; expected YYYY-MM-DD`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw invalid(`Invalid calendar date "${day}"`);
  }
  return date;
}

/** Every YYYY-MM-DD from `startDate` to `endDate`, inclusive. */
export function daysInRange(startDate: string, endDate: string): string[] {
  const start = parseDay(startDate);
  const end = parseDay(endDate);
  if (end < start) throw invalid("Period end is before period start", { startDate, endDate });
  const days: string[] = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (days.length >= MAX_SYNTHETIC_DAYS) {
      throw invalid(`Synthetic readings cover at most ${MAX_SYNTHETIC_DAYS} days`);
    }
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/** True when the meter has no reading on this day. */
export function readingMissing(meter: SyntheticMeter, day: string): boolean {
  switch (meter.profile) {
    case "no-data":
      return true;
    case "interior-gap":
      return day >= INTERIOR_GAP.from && day <= INTERIOR_GAP.to;
    case "boundary-gap":
      return day === BOUNDARY_GAP_DAY;
    default:
      return false;
  }
}

/**
 * One day's consumption in integer watt-hours (so sums never drift), for a
 * day the meter actually reported. Independent of every other day.
 */
export function dailyUsageWh(seed: string, meter: SyntheticMeter, day: string): number {
  const date = parseDay(day);
  const [min, max] = DAILY_KWH_RANGE[meter.profile];
  const next = seeded(fnv1a(`${seed}|${meter.componentId}|${day}`));
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const kwh = (min + (max - min) * next()) * (weekend ? WEEKEND_FACTOR : 1);
  return Math.round(kwh * 1000);
}

export type SyntheticPeriodUsage = {
  /** kWh over the inclusive window, or null when it cannot be established. */
  usageKwh: number | null;
  /** Days without a reading inside the window (informational). */
  missingDays: string[];
};

/**
 * Period consumption as a cumulative register would show it: usage between
 * the opening and closing reading. If either boundary day has no reading the
 * result is null (not zero, not an estimate). Interior gaps do not hide
 * consumption, because the register keeps counting through them.
 */
export function periodUsage(
  seed: string,
  meter: SyntheticMeter,
  startDate: string,
  endDate: string
): SyntheticPeriodUsage {
  const days = daysInRange(startDate, endDate);
  const missingDays = days.filter((day) => readingMissing(meter, day));
  if (readingMissing(meter, days[0]) || readingMissing(meter, days[days.length - 1])) {
    return { usageKwh: null, missingDays };
  }
  const wh = days.reduce((sum, day) => sum + dailyUsageWh(seed, meter, day), 0);
  return { usageKwh: wh / 1000, missingDays };
}
