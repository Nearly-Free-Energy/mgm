import type { DeviceReading } from "@/lib/adapters/types";
import { MeteringError } from "./errors";
import type { MeteringProvider, MeteringReadRequest } from "./types";

export type FixtureReading = {
  deviceId: string;
  startDate: string;
  endDate: string;
  timezone: string;
  usageKwh: number | null;
};

/**
 * Deterministic provider for demonstrations and tests. There is no implicit
 * zero: an omitted fixture is a data error, so a missing reading cannot turn
 * into a bill with zero consumption.
 */
export class FixtureMeteringProvider implements MeteringProvider {
  constructor(private readonly readings: readonly FixtureReading[]) {}

  async getReadings(request: MeteringReadRequest): Promise<DeviceReading[]> {
    return request.devices.map((device) => {
      const reading = this.readings.find(
        (candidate) =>
          candidate.deviceId === device.id &&
          candidate.startDate === request.startDate &&
          candidate.endDate === request.endDate &&
          candidate.timezone === request.timezone
      );
      if (!reading) {
        throw new MeteringError(
          `Fixture reading is missing for device ${device.id}`,
          "METERING_INVALID_DATA",
          400,
          { deviceId: device.id, microgridId: request.microgridId }
        );
      }
      return {
        deviceId: device.id,
        usageKwh: reading.usageKwh,
        startDate: request.startDate,
        endDate: request.endDate,
      };
    });
  }
}

