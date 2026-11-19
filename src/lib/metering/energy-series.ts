/**
 * energy-series.ts — the bucket axis of a meter energy series
 * (`MeteringProvider.getDeviceEnergySeries`), shared by every provider so
 * they validate a request the same way and place a value in the same bucket.
 *
 * Pure: no clock, no I/O.
 */
import {
  addDaysToDateKey,
  dayKeyInZone,
  isCalendarDateKey,
  localHourStarts,
  startOfDayInZone,
} from "@/lib/timezone/day-key";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { MeteringError } from "./errors";
import type { DeviceEnergySeriesRequest } from "./types";

/** The longest range, in whole local days, each resolution may be asked for. */
export const ENERGY_SERIES_MAX_DAYS = { day: 62, hour: 7 } as const;

export type EnergySeriesAxis = {
  /** Bucket starts, epoch ms, ascending: local midnights, or local hour starts. */
  buckets: number[];
  /** The bucket index an instant belongs to, or undefined when it is outside the range. */
  indexOf(epochMs: number): number | undefined;
};

function invalid(message: string, request: DeviceEnergySeriesRequest): MeteringError {
  return new MeteringError(message, "METERING_INVALID_DATA", 400, {
    microgridId: request.microgridId,
    startDate: request.startDate,
    endDate: request.endDate,
    resolution: request.resolution,
  });
}

/**
 * The buckets a request asks for, and where an instant falls among them.
 *
 * - `"day"`: one bucket per local day, starting at its first instant; an
 *   instant belongs to the day it falls on in `timezone`, so a bucket stamped
 *   at local midnight and one stamped at any later instant of the day land
 *   on the same cell.
 * - `"hour"`: one bucket per local hour start (`localHourStarts`); an instant
 *   belongs to a bucket only when it is that bucket's start exactly, so a
 *   source that leaves a bucket out shifts no other value.
 *
 * Throws MeteringError METERING_INVALID_DATA 400 for a malformed date, an
 * end before the start, an unknown resolution or zone, or a range over
 * ENERGY_SERIES_MAX_DAYS.
 */
export function energySeriesAxis(request: DeviceEnergySeriesRequest): EnergySeriesAxis {
  const { startDate, endDate, resolution, timezone } = request;
  if (!isCalendarDateKey(startDate) || !isCalendarDateKey(endDate)) {
    throw invalid("An energy series needs its start and end as YYYY-MM-DD dates.", request);
  }
  if (endDate < startDate) {
    throw invalid("An energy series cannot end before it starts.", request);
  }
  if (resolution !== "day" && resolution !== "hour") {
    throw invalid("An energy series is read per day or per hour.", request);
  }
  if (!isSupportedTimezone(timezone)) {
    throw invalid("An energy series needs a valid IANA time zone.", request);
  }
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addDaysToDateKey(date, 1)) {
    if (dates.length === ENERGY_SERIES_MAX_DAYS[resolution]) {
      throw invalid(
        `An energy series per ${resolution} covers at most ${ENERGY_SERIES_MAX_DAYS[resolution]} days.`,
        request
      );
    }
    dates.push(date);
  }

  if (resolution === "day") {
    const index = new Map(dates.map((date, i) => [date, i]));
    return {
      buckets: dates.map((date) => startOfDayInZone(date, timezone).getTime()),
      indexOf: (epochMs) =>
        Number.isFinite(epochMs) ? index.get(dayKeyInZone(epochMs, timezone)) : undefined,
    };
  }
  const buckets = dates.flatMap((date) => localHourStarts(date, timezone));
  const index = new Map(buckets.map((start, i) => [start, i]));
  return { buckets, indexOf: (epochMs) => index.get(epochMs) };
}
