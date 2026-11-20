/**
 * energy-series.ts — the bucket axis of a meter energy series
 * (`MeteringProvider.getDeviceEnergySeries`), shared by every provider so
 * they validate a request the same way and return the same buckets.
 *
 * Pure: no clock, no I/O.
 */
import {
  addDaysToDateKey,
  isCalendarDateKey,
  localHourStarts,
  startOfDayInZone,
} from "@/lib/timezone/day-key";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { MeteringError } from "./errors";
import type { DeviceEnergySeriesRequest } from "./types";

/**
 * The longest range, in whole local days, each resolution may be asked for.
 * A month at most per day: the tenant usage asks for one month, and the
 * OpenEMS provider reads days from hours over the request plus a day each
 * side (getOpenEmsEnergySeries), so 31 days is 33 days of hourly buckets,
 * about 800 a channel, in one backend call. On NFE's backend that read took
 * about 1.5 s for two meters (19 November 2026). If a caller needs more,
 * or a provider reads it differently, revisit.
 */
export const ENERGY_SERIES_MAX_DAYS = { day: 31, hour: 7 } as const;

export type EnergySeriesAxis = {
  /** Bucket starts, epoch ms, ascending: local midnights, or local hour starts. */
  buckets: number[];
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
 * The buckets a request asks for.
 *
 * - `"day"`: one bucket per local day, starting at its first instant.
 * - `"hour"`: one bucket per local hour start (`localHourStarts`), so a day
 *   with a daylight-saving change has 23 or 25.
 *
 * Where a source's value lands is the provider's to decide, since sources
 * stamp their buckets differently (the OpenEMS backend stamps an hour at its
 * end; `openems-provider.ts`).
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
    return { buckets: dates.map((date) => startOfDayInZone(date, timezone).getTime()) };
  }
  return { buckets: dates.flatMap((date) => localHourStarts(date, timezone)) };
}
