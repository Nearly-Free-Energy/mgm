import type { DeviceReading } from "@/lib/adapters/types";
import { MeteringError } from "./errors";
import type {
  MeteringProvider,
  MeteringReadRequest,
  SiteSamples,
  SiteSamplesRequest,
} from "./types";

/**
 * Edge ids reserved for synthetic data. The fixture provider generates site
 * samples only for devices on such edges, so it can never stand in for a
 * real meter.
 */
export const SYNTHETIC_EDGE_ID_PREFIX = "SYNTHETIC-EDGE-";

export const isSyntheticEdgeId = (edgeId: string): boolean =>
  edgeId.startsWith(SYNTHETIC_EDGE_ID_PREFIX);

export type FixtureProviderOptions = {
  /** Generates site samples; without it, getSiteSamples answers 503. */
  siteSamples?: (request: SiteSamplesRequest) => SiteSamples;
};

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
 * into a bill with zero consumption. Everything it gives is synthetic.
 */
export class FixtureMeteringProvider implements MeteringProvider {
  readonly synthetic = true as const;

  constructor(
    private readonly readings: readonly FixtureReading[],
    private readonly options: FixtureProviderOptions = {}
  ) {}

  async getSiteSamples(request: SiteSamplesRequest): Promise<SiteSamples> {
    const { battery, gridMeter, load, pv, houseMeters } = request.sources;
    for (const device of [battery, gridMeter, load, pv, ...houseMeters]) {
      if (device && !isSyntheticEdgeId(device.edgeOpenemsId)) {
        throw new MeteringError(
          `Synthetic site data is generated only for edges whose id starts with ${SYNTHETIC_EDGE_ID_PREFIX}`,
          "METERING_INVALID_DATA",
          400,
          { deviceId: device.id, microgridId: request.microgridId }
        );
      }
    }
    if (!this.options.siteSamples) {
      throw new MeteringError(
        "This fixture provider has no site sample generator",
        "METERING_CONFIGURATION",
        503
      );
    }
    return this.options.siteSamples(request);
  }

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
