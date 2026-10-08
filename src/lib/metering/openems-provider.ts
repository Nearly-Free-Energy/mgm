import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createOpenEmsClient } from "@/lib/openems";
import type { OpenEmsClientConfig } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import { OpenEmsError } from "@/lib/openems/errors";
import { dayKeyInZone } from "@/lib/timezone/day-key";
import { MeteringError } from "./errors";
import type { MeteringProvider, MeteringReadRequest } from "./types";

/**
 * OpenEMS integration. This is the only place in the billing-review path that
 * knows about OpenEMS configuration, channel identifiers, or error codes.
 */
export class OpenEmsMeteringProvider implements MeteringProvider {
  constructor(private readonly supabase: SupabaseClient) {}

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
      const readings = await client.getReadings(
        request.devices,
        request.startDate,
        request.endDate,
        request.timezone
      );
      if (!request.requireCompletePeriod) return readings;

      // A daily energy bucket can be numeric even when the meter first
      // reported midway through that day. Check 15-minute samples across
      // each local day, including both boundaries and any interior gaps.
      const devicesByEdge = new Map<string, typeof request.devices>();
      for (const device of request.devices) {
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
          const sample = await client.queryHistoricCoverageSamples(
            edgeId, channels, chunk[0], chunk[chunk.length - 1], request.timezone
          );
          for (const channel of channels) {
            const values = sample.data[channel] ?? [];
            const byDay = samplesByChannel.get(channel) ?? new Map<string, number[]>();
            for (let i = 0; i < sample.timestamps.length; i++) {
              if (!Number.isFinite(values[i])) continue;
              const timestamp = sample.timestamps[i];
              const day = dayKeyInZone(timestamp, request.timezone);
              const bins = byDay.get(day) ?? [];
              bins.push(timestamp);
              byDay.set(day, bins);
            }
            samplesByChannel.set(channel, byDay);
          }
        }
        for (const device of devices) {
          const channel = `${device.componentId}/ActiveConsumptionEnergy`;
          const byDay = samplesByChannel.get(channel);
          if (days.every((day) => hasCompleteDay(byDay?.get(day), request.timezone))) {
            covered.add(device.id);
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
      throw new MeteringError(
        "Metering provider failed unexpectedly",
        "METERING_UNAVAILABLE",
        503,
        error
      );
    }
  }
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

function hasCompleteDay(timestamps: number[] | undefined, timezone: string): boolean {
  if (!timestamps?.length) return false;
  const sorted = [...new Set(timestamps)].sort((a, b) => a - b);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const first = formatter.format(sorted[0]);
  const last = formatter.format(sorted[sorted.length - 1]);
  if (first !== "00:00" || last !== "23:45") return false;
  return sorted.every((timestamp, index) =>
    index === 0 || timestamp - sorted[index - 1] === 15 * 60 * 1000
  );
}

/**
 * MGM's pilot database deliberately does not contain the legacy MBE
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
    // Compatibility for the inherited MBE schema and its existing tests.
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
