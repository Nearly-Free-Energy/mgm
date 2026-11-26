import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createOpenEmsClient, OpenEmsClient } from "@/lib/openems";
import type { OpenEmsClientConfig } from "@/lib/openems";
import type { DeviceConfig, DeviceReading } from "@/lib/adapters/types";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import { OpenEmsError } from "@/lib/openems/errors";
import { addDaysToDateKey, dayKeyInZone, localHourStarts } from "@/lib/timezone/day-key";
import { energySeriesAxis } from "./energy-series";
import { MeteringError } from "./errors";
import type {
  DeviceEnergySeries,
  DeviceEnergySeriesRequest,
  MeteringProvider,
  MeteringReadRequest,
  SiteSamples,
  SiteSamplesRequest,
  SiteSources,
} from "./types";

/**
 * OpenEMS integration. This is the only place in the billing-review path that
 * knows about OpenEMS configuration, channel identifiers, or error codes.
 */
export class OpenEmsMeteringProvider implements MeteringProvider {
  constructor(private readonly supabase: SupabaseClient) {}

  async getSiteSamples(request: SiteSamplesRequest): Promise<SiteSamples> {
    try {
      return await getOpenEmsSiteSamples(this.supabase, request);
    } catch (error) {
      if (error instanceof MeteringError) throw error;
      if (error instanceof OpenEmsError) throw historyReadError(error, "site");
      console.error("Unexpected MGM site samples failure", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : "non-Error thrown",
      });
      throw new MeteringError(
        "Metering provider failed unexpectedly",
        "METERING_UNAVAILABLE",
        503,
        error
      );
    }
  }

  async getDeviceEnergySeries(request: DeviceEnergySeriesRequest): Promise<DeviceEnergySeries> {
    try {
      return await getOpenEmsEnergySeries(this.supabase, request);
    } catch (error) {
      if (error instanceof MeteringError) throw error;
      if (error instanceof OpenEmsError) throw historyReadError(error, "usage");
      console.error("Unexpected MGM energy series failure", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : "non-Error thrown",
      });
      throw new MeteringError(
        "Metering provider failed unexpectedly",
        "METERING_UNAVAILABLE",
        503,
        error
      );
    }
  }

  async getReadings(request: MeteringReadRequest) {
    try {
      const config = await resolveOpenEmsConfig(
        this.supabase,
        request.microgridId
      );
      if (!config) {
        throw new MeteringError(
          "Metering provider is not configured for this microgrid",
          "METERING_CONFIGURATION",
          503,
          { microgridId: request.microgridId }
        );
      }

      // OpenEmsClient itself only ever asks for
      // `${componentId}/ActiveConsumptionEnergy`; it never requests `_sum`.
      const client = createOpenEmsClient(config);
      const days = request.requireCompletePeriod
        ? calendarDays(request.startDate, request.endDate)
        : [];
      let readings: DeviceReading[];
      try {
        readings = await client.getReadings(
          request.devices, request.startDate, request.endDate, request.timezone
        );
      } catch (error) {
        if (!isNoEnergyData(error) || !request.requireCompletePeriod) throw error;
        // OpenEMS can reject a batched query when one channel has no history.
        // Isolate channels so that meter does not hide valid usage from peers.
        readings = await Promise.all(request.devices.map(async (device) => {
          try {
            const [reading] = await client.getReadings(
              [device], request.startDate, request.endDate, request.timezone
            );
            return reading;
          } catch (deviceError) {
            if (!isNoEnergyData(deviceError)) throw deviceError;
            return {
              deviceId: device.id,
              usageKwh: null,
              startDate: request.startDate,
              endDate: request.endDate,
            };
          }
        }));
      }
      if (!request.requireCompletePeriod) return readings;
      const missingEnergy = readings.filter((reading) => reading.usageKwh === null);
      if (missingEnergy.length) {
        console.warn("MGM OpenEMS period energy unavailable", {
          startDate: request.startDate,
          endDate: request.endDate,
          deviceIds: missingEnergy.map((reading) => reading.deviceId),
        });
      }

      // Cumulative registers retain consumption across telemetry outages.
      // Verify the opening and closing boundary bins only; interior gaps
      // must not turn valid monthly consumption into a manual-entry request.
      const devicesByEdge = new Map<string, typeof request.devices>();
      for (const device of request.devices.filter((device) =>
        readings.some((reading) => reading.deviceId === device.id && reading.usageKwh !== null)
      )) {
        const group = devicesByEdge.get(device.edgeOpenemsId) ?? [];
        group.push(device);
        devicesByEdge.set(device.edgeOpenemsId, group);
      }
      const covered = new Set<string>();
      await Promise.all([...devicesByEdge].map(async ([edgeId, devices]) => {
        const channels = devices.map((d) => `${d.componentId}/ActiveConsumptionEnergy`);
        const samplesByChannel = new Map<string, Map<string, number[]>>();
        // Keep responses bounded for long billing periods.
        for (let offset = 0; offset < days.length; offset += 31) {
          const chunk = days.slice(offset, offset + 31);
          let sample;
          try {
            sample = await client.queryHistoricCoverageSamples(
              edgeId, channels, chunk[0], chunk[chunk.length - 1], request.timezone
            );
          } catch (error) {
            if (!isNoEnergyData(error)) throw error;
            // A missing channel can also invalidate a batched coverage query.
            // Retry individually; a still-missing channel remains uncovered.
            const individual = await Promise.all(channels.map(async (channel) => {
              try {
                return { channel, sample: await client.queryHistoricCoverageSamples(
                  edgeId, [channel], chunk[0], chunk[chunk.length - 1], request.timezone
                ) };
              } catch (channelError) {
                if (!isNoEnergyData(channelError)) throw channelError;
                return { channel, sample: null };
              }
            }));
            for (const { channel, sample: single } of individual) {
              if (!single) continue;
              recordSamples(samplesByChannel, channel, single, request.timezone);
            }
            continue;
          }
          for (const channel of channels) {
            recordSamples(samplesByChannel, channel, sample, request.timezone);
          }
        }
        for (const device of devices) {
          const channel = `${device.componentId}/ActiveConsumptionEnergy`;
          const byDay = samplesByChannel.get(channel);
          if (hasPeriodBoundaries(byDay, days, request.timezone)) {
            covered.add(device.id);
          } else {
            const samples = [...(byDay?.values() ?? [])].flat().sort((a, b) => a - b);
            const boundaryDays = [...new Set([days[0], days[days.length - 1]])];
            console.warn("MGM OpenEMS coverage incomplete", {
              deviceId: device.id,
              channel,
              startDate: request.startDate,
              endDate: request.endDate,
              sampleCount: samples.length,
              firstSample: samples.length ? new Date(samples[0]).toISOString() : null,
              lastSample: samples.length ? new Date(samples[samples.length - 1]).toISOString() : null,
              exampleDays: boundaryDays.map((day) => ({
                day,
                sampleCount: byDay?.get(day)?.length ?? 0,
                first: byDay?.get(day)?.[0] ?? null,
                last: byDay?.get(day)?.at(-1) ?? null,
              })),
            });
          }
        }
      }));
      return readings.map((reading) => ({
        ...reading,
        usageKwh: covered.has(reading.deviceId) ? reading.usageKwh : null,
      }));
    } catch (error) {
      if (error instanceof MeteringError) throw error;
      if (error instanceof OpenEmsError) throw translateOpenEmsError(error);
      // Keep the client-facing error generic, but retain the exception class
      // and stack in server logs so unexpected OpenEMS response shapes can be
      // diagnosed without logging configuration or credentials.
      console.error("Unexpected MGM metering provider failure", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : "non-Error thrown",
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw new MeteringError(
        "Metering provider failed unexpectedly",
        "METERING_UNAVAILABLE",
        503,
        error
      );
    }
  }
}

export type SampleSet = {
  timestamps: Array<number | string>;
  data: Record<string, (number | null)[]>;
};

/**
 * An ISO string that names its own instant: it ends in `Z` or a `±HH:MM`
 * offset, then optionally the zone in brackets, as Java's `ZonedDateTime`
 * prints it (`2026-11-01T00:00+03:00[Africa/Kampala]`).
 */
const ZONED_ISO = /(?:Z|[+-]\d{2}:\d{2})(?:\[[^\]]+\])?$/;

/**
 * OpenEMS installations return either epoch milliseconds (or seconds) or ISO
 * strings; the stock backend sends instants in UTC, such as
 * `2026-11-04T21:00:00Z` for midnight in Kampala. A string with no `Z` or
 * offset is unreadable rather than parsed: `Date.parse` would read it in the
 * server's own zone and move every bucket by that zone's offset. The offset
 * alone fixes the instant, so a bracketed zone is dropped before parsing.
 */
export function toEpochMs(raw: number | string): number | null {
  if (typeof raw === "string" && !/^\d{10,13}$/.test(raw) && !ZONED_ISO.test(raw)) return null;
  const numeric = typeof raw === "number"
    ? raw
    : /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const timestamp = numeric === null
    ? Date.parse((raw as string).replace(/\[[^\]]*\]$/, ""))
    : numeric < 1e11 ? numeric * 1000 : numeric;
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Channels of the site sources, as OpenEMS names them, in two groups: the
 * site's own devices, and the house meters. Meter voltages are in mV, power
 * in W, the ESS state of charge in %, a meter's consumption counter in Wh.
 */
function siteChannels(sources: SiteSources) {
  const channels: { group: "site" | "houses"; edgeId: string; channel: string }[] = [];
  const add = (group: "site" | "houses", device: DeviceConfig | null, suffixes: string[]) => {
    if (!device?.edgeOpenemsId || !device.componentId) return;
    for (const suffix of suffixes) {
      channels.push({
        group,
        edgeId: device.edgeOpenemsId,
        channel: `${device.componentId}/${suffix}`,
      });
    }
  };
  add("site", sources.battery, ["Soc", "ActivePower"]);
  add("site", sources.gridMeter, ["ActivePower", "VoltageL1", "VoltageL2", "VoltageL3"]);
  add("site", sources.load, ["ActivePower"]);
  add("site", sources.pv, ["ActivePower"]);
  for (const meter of sources.houseMeters) add("houses", meter, ["ActiveConsumptionEnergy"]);
  return channels;
}

/** At most this many one-channel retries of a batch run at once. */
const SINGLE_CHANNEL_CONCURRENCY = 4;

/**
 * Runs `task` over `items`, at most `limit` at a time, keeping order. Once a
 * task fails, no further task starts.
 */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        out[index] = await task(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * One batch of channels, or, when OpenEMS refuses the batch because a
 * channel in it has no history, each channel on its own. Each set comes with
 * the channels it was asked for; a channel that still has no history gives
 * no set.
 */
export async function queryBatchOrEach(
  channels: string[],
  query: (channels: string[]) => Promise<SampleSet>
): Promise<{ channels: string[]; set: SampleSet }[]> {
  try {
    return [{ channels, set: await query(channels) }];
  } catch (error) {
    if (!isNoEnergyData(error)) throw error;
    // A channel with no history fails the whole batch; one by one, the
    // others still answer and the missing one stays null. A few at a time,
    // so a batch of many house meters does not become a burst of requests.
    const single = await mapLimited(channels, SINGLE_CHANNEL_CONCURRENCY, async (channel) => {
      try {
        return { channels: [channel], set: await query([channel]) };
      } catch (channelError) {
        if (!isNoEnergyData(channelError)) throw channelError;
        return null;
      }
    });
    return single.filter((entry) => entry !== null);
  }
}

async function querySiteEdge(
  client: ReturnType<typeof createOpenEmsClient>,
  edgeId: string,
  channels: string[],
  request: SiteSamplesRequest,
  /** The page read's one deadline, shared by every request and retry. */
  signal: AbortSignal
): Promise<SampleSet[]> {
  const sets = await queryBatchOrEach(channels, (list) => client.queryHistoricSamples(
    edgeId, list, request.startDate, request.endDate, request.timezone,
    request.resolutionMinutes, { signal }
  ));
  return sets.map(({ set }) => set);
}

/** A meter's consumption counter, as OpenEMS names its channel. */
const consumptionChannel = (componentId: string) => `${componentId}/ActiveConsumptionEnergy`;

const HOUR_MS = 3_600_000;

/**
 * Implements `MeteringProvider.getDeviceEnergySeries` for OpenEMS, with
 * queryHistoricTimeseriesEnergyPerPeriod per edge, always per hour.
 *
 * - `"hour"`: each local hour's Wh as the backend gives it, null where it has
 *   none. The hour holding the read carries what was counted so far.
 * - `"day"`: a local day is the sum of its local hours, as the synthetic
 *   provider sums them (`fixture/meter-energy.ts`). An hour that starts at or
 *   after now is not counted; an hour that has ended without a value makes
 *   the day null, never a lower number; the hour holding now counts when it
 *   has a value and is not missing when it has none yet (its first sample may
 *   not have arrived). A day that starts at or after now is null.
 */
async function getOpenEmsEnergySeries(
  supabase: SupabaseClient,
  request: DeviceEnergySeriesRequest
): Promise<DeviceEnergySeries> {
  // Validates the request before anything is read.
  const axis = energySeriesAxis(request);

  // A device without OpenEMS identifiers is not requested; its series stays
  // all null. Channels are grouped and deduplicated per edge only: component
  // ids such as `meter0` repeat on every edge, so a channel name never
  // identifies a meter on its own.
  const channelsByEdge = new Map<string, string[]>();
  for (const device of request.devices) {
    if (!device.edgeOpenemsId || !device.componentId) continue;
    const channels = channelsByEdge.get(device.edgeOpenemsId) ?? [];
    const channel = consumptionChannel(device.componentId);
    if (!channels.includes(channel)) channels.push(channel);
    channelsByEdge.set(device.edgeOpenemsId, channels);
  }
  const noValues = (): (number | null)[] => axis.buckets.map(() => null);
  if (channelsByEdge.size === 0) {
    // Nothing to read: no configuration is resolved, no credential decrypted.
    return {
      buckets: axis.buckets,
      kwh: Object.fromEntries(request.devices.map((device) => [device.id, noValues()])),
    };
  }

  const config = await resolveOpenEmsConfig(supabase, request.microgridId);
  if (!config) {
    throw new MeteringError(
      "Metering provider is not configured for this microgrid",
      "METERING_CONFIGURATION",
      503,
      { microgridId: request.microgridId }
    );
  }
  const client = createOpenEmsClient(config);
  // One deadline for the whole read, however many requests and retries it
  // takes: once it passes, the client starts no further request.
  const signal = AbortSignal.timeout(OpenEmsClient.PAGE_READ_TIMEOUT_MS);

  // The local hours of the requested days, whatever the resolution: a day
  // is summed from its hours below.
  const days: { date: string; first: number; count: number }[] = [];
  const hourStarts: number[] = [];
  for (let date = request.startDate; date <= request.endDate; date = addDaysToDateKey(date, 1)) {
    const starts = localHourStarts(date, request.timezone);
    days.push({ date, first: hourStarts.length, count: starts.length });
    hourStarts.push(...starts);
  }
  const hourIndex = new Map(hourStarts.map((start, i) => [start, i]));

  // Lead day (spike on RFC mgm#197, 17 November 2026): the backend returns
  // the first two hourly buckets of any range as null, so the range starts
  // a day before the requested start. Trailing day: the backend stamps each
  // hour at its end (below), and a range ending on `endDate` stops at the
  // bucket stamped 23:00, so the hour 23:00 to 24:00 of `endDate` comes back
  // only when the range runs to the next day. Hours outside the requested
  // days are dropped below and never leave this function. A null inside the
  // requested range is real missing data and stays null. If the backend stops
  // leaving the first buckets empty, the lead day is merely wasted; if it
  // ever leaves more than a day empty, the lead must grow.
  // ENERGY_SERIES_MAX_DAYS applies to the request, not to these two days.
  const fromDate = addDaysToDateKey(request.startDate, -1);
  const toDate = addDaysToDateKey(request.endDate, 1);

  // Wh per local hour, keyed `${edgeId}|${channel}`: one value per hour, or
  // null; `seen` marks the hours a response has already given a value for.
  const values = new Map<string, { wh: (number | null)[]; seen: boolean[] }>();
  await Promise.all([...channelsByEdge].map(async ([edgeId, channels]) => {
    const sets = await queryBatchOrEach(channels, (list) => client.queryEnergyPerPeriod(
      edgeId, list, fromDate, toDate, request.timezone, "Hours", { signal }
    ));
    for (const { channels: asked, set } of sets) {
      const times = set.timestamps.map(toEpochMs);
      const unreadable = times.filter((time) => time === null).length;
      // A response whose instants mostly cannot be read is not missing
      // data: say so rather than show every bucket as missing.
      if (set.timestamps.length && unreadable * 2 > set.timestamps.length) {
        console.error("MGM energy series: unreadable OpenEMS timestamps", {
          edgeId,
          count: set.timestamps.length,
          unreadable,
          examples: set.timestamps
            .filter((_, i) => times[i] === null)
            .slice(0, 3)
            .map((raw) => String(raw).slice(0, 64)),
        });
        throw new MeteringError(
          "OpenEMS returned this usage in a form MGM could not read. Try again shortly.",
          "METERING_INVALID_DATA",
          502,
          { edgeId, count: set.timestamps.length, unreadable }
        );
      }
      // Only the channels this set was asked for: a set never fills another
      // request's channel.
      for (const channel of asked) {
        const raw = set.data[channel];
        if (!raw) continue;
        const key = `${edgeId}|${channel}`;
        const entry = values.get(key) ?? {
          wh: hourStarts.map(() => null),
          seen: hourStarts.map(() => false),
        };
        values.set(key, entry);
        for (let i = 0; i < times.length; i++) {
          const time = times[i];
          // The backend stamps an hourly bucket with the END of its hour: the
          // bucket stamped 15:00 holds 14:00 to 15:00, and while that hour
          // runs it already holds what was counted so far. Observed on NFE's
          // backend (OpenEMS 2026.x with InfluxDB), 19 November 2026: 118
          // hours of two meters matched their counters' rise over the hour
          // before each stamp, not the hour after it. Matched exactly against
          // the local hour starts, so a stamp off the hour, or a source that
          // leaves an hour out, shifts no other value. If a backend stamps an
          // hour at its start, every hour reads one hour late and this offset
          // must go.
          const index = time === null ? undefined : hourIndex.get(time - HOUR_MS);
          if (index === undefined) continue;
          if (entry.seen[index]) {
            console.error("MGM energy series: two OpenEMS values for one bucket", {
              edgeId,
              channel,
              bucket: new Date(hourStarts[index]).toISOString(),
            });
            throw new MeteringError(
              "OpenEMS returned this usage with ambiguous buckets. Try again shortly.",
              "METERING_INVALID_DATA",
              502,
              { edgeId, channel }
            );
          }
          entry.seen[index] = true;
          const value = raw[i];
          // A negative value is a counter reset, not energy used.
          entry.wh[index] =
            typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
        }
      }
    }
  }));

  // Days are summed from hours rather than read per day: the same backend
  // stamps a daily bucket at local midnight but fills it with the UTC day,
  // 03:00 to 03:00 in Kampala (observed alongside the hours above). If daily
  // buckets ever follow the requested zone, days could be read directly
  // again. A gap in telemetry leaves its hour null rather than carrying its
  // energy into the next hour, which is why an ended hour without a value
  // makes its day null.
  const nowMs = request.nowMs ?? Date.now();
  const toSeries = (wh: (number | null)[]): (number | null)[] => {
    if (request.resolution === "hour") {
      return wh.map((value) => (value === null ? null : value / 1000));
    }
    return days.map(({ first, count }) => {
      if (hourStarts[first] >= nowMs) return null;
      let dayWh = 0;
      for (let i = first; i < first + count; i++) {
        const start = hourStarts[i];
        if (start >= nowMs) break;
        const value = wh[i];
        if (value !== null) dayWh += value;
        else if (start + HOUR_MS <= nowMs) return null;
      }
      return dayWh / 1000;
    });
  };

  // Looked up by edge and channel, never by the channel alone; each device
  // gets its own array, so two devices on one channel never share one.
  return {
    buckets: axis.buckets,
    kwh: Object.fromEntries(request.devices.map((device) => {
      const wh = device.edgeOpenemsId && device.componentId
        ? values.get(`${device.edgeOpenemsId}|${consumptionChannel(device.componentId)}`)?.wh
        : undefined;
      return [device.id, wh ? toSeries(wh) : noValues()];
    })),
  };
}

/** Implements `MeteringProvider.getSiteSamples` for OpenEMS. */
async function getOpenEmsSiteSamples(
  supabase: SupabaseClient,
  request: SiteSamplesRequest
): Promise<SiteSamples> {
  const config = await resolveOpenEmsConfig(supabase, request.microgridId);
  if (!config) {
    throw new MeteringError(
      "Metering provider is not configured for this microgrid",
      "METERING_CONFIGURATION",
      503,
      { microgridId: request.microgridId }
    );
  }
  const client = createOpenEmsClient(config);
  // One deadline for the whole read, however many requests and retries it
  // takes: once it passes, the client starts no further request.
  const signal = AbortSignal.timeout(OpenEmsClient.PAGE_READ_TIMEOUT_MS);
  // One batch per edge for the site's devices and another for its house
  // meters, so a meter without history (a new one, say) does not make the
  // site's channels be retried one by one.
  const batches = new Map<string, { edgeId: string; channels: string[] }>();
  for (const { group, edgeId, channel } of siteChannels(request.sources)) {
    const key = `${group}|${edgeId}`;
    const batch = batches.get(key) ?? { edgeId, channels: [] };
    if (!batch.channels.includes(channel)) batch.channels.push(channel);
    batches.set(key, batch);
  }

  // One value per (edge, channel, instant), keyed by bin start.
  const values = new Map<string, Map<number, number>>();
  const instants = new Set<number>();
  // The raw timestamps dropped as unreadable, each once however many
  // responses repeat it (an edge's site and house batches, one-channel
  // retries).
  const dropped = new Set<number | string>();
  await Promise.all([...batches.values()].map(async ({ edgeId, channels }) => {
    for (const set of await querySiteEdge(client, edgeId, channels, request, signal)) {
      const times = set.timestamps.map(toEpochMs);
      const unreadable = times.filter((time) => time === null).length;
      // A response whose instants mostly cannot be read is not an empty
      // day: say so rather than show the day as missing data. It has its
      // own code, so it is not taken for other data MGM could not use; the
      // tenant usage read (getOpenEmsEnergySeries) refuses the same case as
      // METERING_INVALID_DATA. A minority is dropped and counted below.
      if (set.timestamps.length && unreadable * 2 > set.timestamps.length) {
        console.error("MGM site samples: unreadable OpenEMS timestamps", {
          edgeId,
          count: set.timestamps.length,
          unreadable,
          examples: set.timestamps
            .filter((_, i) => times[i] === null)
            .slice(0, 3)
            .map((raw) => String(raw).slice(0, 64)),
        });
        throw new MeteringError(
          "OpenEMS returned this day's data in a form MGM could not read. Try again shortly.",
          "METERING_UNREADABLE_TIMESTAMPS",
          502,
          { edgeId, count: set.timestamps.length, unreadable }
        );
      }
      set.timestamps.forEach((raw, i) => {
        if (times[i] === null) dropped.add(raw);
      });
      for (const time of times) if (time !== null) instants.add(time);
      for (const channel of channels) {
        const series = set.data[channel];
        if (!series) continue;
        const key = `${edgeId}|${channel}`;
        const map = values.get(key) ?? new Map<number, number>();
        series.forEach((value, i) => {
          const time = times[i];
          if (time !== null && typeof value === "number" && Number.isFinite(value)) {
            map.set(time, value);
          }
        });
        values.set(key, map);
      }
    }
  }));

  const timestamps = [...instants].sort((a, b) => a - b);
  const read = (device: DeviceConfig | null, suffix: string, divisor = 1) =>
    timestamps.map((time) => {
      if (!device?.edgeOpenemsId || !device.componentId) return null;
      const value = values
        .get(`${device.edgeOpenemsId}|${device.componentId}/${suffix}`)
        ?.get(time);
      return value === undefined ? null : value / divisor;
    });
  const phases = ["VoltageL1", "VoltageL2", "VoltageL3"].map((suffix) =>
    read(request.sources.gridMeter, suffix, 1000)
  );
  // The lowest phase that reported: a cut is any phase down. A phase with
  // no value (a single-phase meter's L2 and L3, say) is ignored.
  return {
    timestamps,
    batterySocPct: read(request.sources.battery, "Soc"),
    batteryPowerW: read(request.sources.battery, "ActivePower"),
    gridPowerW: read(request.sources.gridMeter, "ActivePower"),
    gridVoltageV: timestamps.map((_, i) => {
      const present = phases
        .map((phase) => phase[i])
        .filter((value): value is number => value !== null);
      return present.length ? Math.min(...present) : null;
    }),
    loadPowerW: read(request.sources.load, "ActivePower"),
    pvPowerW: read(request.sources.pv, "ActivePower"),
    houseEnergyWh: Object.fromEntries(
      request.sources.houseMeters.map((meter) => [
        meter.id,
        read(meter, "ActiveConsumptionEnergy"),
      ])
    ),
    unreadableTimestamps: dropped.size,
  };
}

export function isNoEnergyData(error: unknown): error is OpenEmsError {
  return error instanceof OpenEmsError &&
    error.code === "OPENEMS_HTTP_ERROR" &&
    (error.details as { status?: number } | undefined)?.status === 400 &&
    error.message.includes("Energy values are not available for query");
}

function recordSamples(
  samplesByChannel: Map<string, Map<string, number[]>>,
  channel: string,
  sample: { timestamps: Array<number | string>; data: Record<string, (number | null)[]> },
  timezone: string
) {
  const values = sample.data[channel] ?? [];
  const byDay = samplesByChannel.get(channel) ?? new Map<string, number[]>();
  for (let i = 0; i < sample.timestamps.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    // Invalid instants never provide coverage evidence.
    const timestamp = toEpochMs(sample.timestamps[i]);
    if (timestamp === null) continue;
    const day = dayKeyInZone(timestamp, timezone);
    const bins = byDay.get(day) ?? [];
    bins.push(timestamp);
    byDay.set(day, bins);
  }
  samplesByChannel.set(channel, byDay);
}

function calendarDays(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const day = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(`${endDate}T00:00:00Z`);
  while (day <= last) {
    if (days.length >= 366) {
      throw new MeteringError(
        "A billing period longer than 366 days cannot be verified against OpenEMS coverage.",
        "METERING_INVALID_DATA",
        422
      );
    }
    days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

function hasPeriodBoundaries(
  byDay: Map<string, number[]> | undefined,
  days: string[],
  timezone: string
): boolean {
  if (!days.length) return false;
  const opening = byDay?.get(days[0]);
  const closing = byDay?.get(days[days.length - 1]);
  if (!opening?.length || !closing?.length) return false;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // These are the boundary bins of OpenEMS's 15-minute historic query.
  // Its energy query calculates the cumulative register difference; samples
  // here establish that the result does not cover only part of the period.
  return opening.some((timestamp) => formatter.format(timestamp) === "00:00") &&
    closing.some((timestamp) => formatter.format(timestamp) === "23:45");
}

/**
 * MGM's pilot database deliberately does not contain the legacy
 * `microgrids.ems_*` credential columns or their decrypt RPCs. When an MGM
 * OpenEMS environment is configured, its exact microgrid binding is checked
 * before any database lookup. A partial configuration or a different
 * microgrid is never allowed to fall back to the database path.
 *
 * The OpenEMS identity configured through these variables must be read-only;
 * this provider only calls historic energy reads, but server code cannot turn
 * a write-capable backend identity into a safe one.
 */
async function resolveOpenEmsConfig(
  supabase: SupabaseClient,
  requestedMicrogridId: string
): Promise<OpenEmsClientConfig | null> {
  const microgridId = process.env.MGM_OPENEMS_MICROGRID_ID;
  const url = process.env.MGM_OPENEMS_URL;
  const username = process.env.MGM_OPENEMS_USERNAME;
  const password = process.env.MGM_OPENEMS_PASSWORD;
  const anyPilotConfig = Boolean(microgridId || url || username || password);

  if (!anyPilotConfig) {
    // Compatibility for the inherited legacy schema and its existing tests.
    return getMicrogridEmsConfig(supabase, requestedMicrogridId);
  }

  if (!microgridId || !url) {
    throw new MeteringError(
      "Pilot OpenEMS configuration is incomplete",
      "METERING_CONFIGURATION",
      503
    );
  }
  if (microgridId !== requestedMicrogridId) {
    throw new MeteringError(
      "Pilot OpenEMS is not configured for this microgrid",
      "METERING_CONFIGURATION",
      403
    );
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new MeteringError(
      "Pilot OpenEMS credentials are incomplete",
      "METERING_CONFIGURATION",
      503
    );
  }

  return {
    type: "direct_url",
    url,
    ...(username && password ? { username, password } : {}),
  };
}

export function createOpenEmsMeteringProvider(
  supabase: SupabaseClient
): MeteringProvider {
  return new OpenEmsMeteringProvider(supabase);
}

/**
 * The history reads whose failures get fixed copy: the operations page's
 * site read, and a meter energy series (a tenant's usage). `log` heads the
 * server log line; `fallback` is the sentence for a failure with no more
 * specific one.
 */
const HISTORY_READS = {
  site: {
    log: "MGM site samples: OpenEMS failed",
    fallback: "OpenEMS could not provide this day's data. Try again shortly.",
  },
  usage: {
    log: "MGM energy series: OpenEMS failed",
    fallback: "OpenEMS could not provide this usage. Try again shortly.",
  },
} as const;

/**
 * What a history read says when OpenEMS fails it. The client's own
 * messages name the backend URL and quote its replies, so they go to the
 * server log only; the caller gets a plain sentence per kind of failure,
 * and keeps the MeteringError code and status of `translateOpenEmsError`.
 */
function historyReadMessage(code: string, subject: keyof typeof HISTORY_READS): string {
  switch (code) {
    case "OPENEMS_UNREACHABLE":
      return "OpenEMS did not answer in time. Try again shortly.";
    case "OPENEMS_AUTH_FAILED":
    case "OPENEMS_FORBIDDEN":
      return "OpenEMS refused MGM's sign-in. Check the OpenEMS connection under Setup.";
    case "OPENEMS_NOT_CONFIGURED":
    case "OPENEMS_INVALID_CONFIG":
    case "OPENEMS_INVALID_BACKEND_URL":
    case "OPENEMS_REDIRECT":
      return "The OpenEMS connection for this microgrid is not set up correctly. Check it under Setup.";
    default:
      return HISTORY_READS[subject].fallback;
  }
}

function historyReadError(error: OpenEmsError, subject: keyof typeof HISTORY_READS): MeteringError {
  console.error(HISTORY_READS[subject].log, {
    code: error.code,
    message: error.message,
  });
  const translated = translateOpenEmsError(error);
  return new MeteringError(
    historyReadMessage(error.code, subject),
    translated.code,
    translated.statusCode,
    { openemsCode: error.code }
  );
}

function translateOpenEmsError(error: OpenEmsError): MeteringError {
  if (error.code === "OPENEMS_AUTH_FAILED" || error.code === "OPENEMS_FORBIDDEN") {
    return new MeteringError(error.message, "METERING_UNAUTHORIZED", error.statusCode, error.details);
  }
  if (
    error.code === "OPENEMS_NOT_CONFIGURED" ||
    error.code === "OPENEMS_INVALID_CONFIG" ||
    error.code === "OPENEMS_INVALID_BACKEND_URL"
  ) {
    return new MeteringError(error.message, "METERING_CONFIGURATION", error.statusCode, error.details);
  }
  if (error.code === "DEVICE_INVALID_DATA_SOURCE") {
    return new MeteringError(error.message, "METERING_INVALID_DATA", error.statusCode, error.details);
  }
  return new MeteringError(error.message, "METERING_UNAVAILABLE", error.statusCode, error.details);
}
