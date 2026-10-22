/**
 * Synthetic metering provider (issue #44). It builds on the existing
 * `FixtureMeteringProvider`: the generator produces fixture readings for the
 * requested window and the fixture provider serves them, so there is one
 * fixture path, not two.
 *
 * It answers only for meters carrying the SYNTHETIC- identifiers. Anything
 * else is refused, so it can never fabricate usage for a real meter.
 */
import { MeteringError } from "./errors";
import { FixtureMeteringProvider, type FixtureReading } from "./fixture-provider";
import type { MeteringProvider, MeteringReadRequest } from "./types";
import { findSyntheticMeter, SYNTHETIC_EDGE_ID_PREFIX } from "./synthetic/dataset";
import { DEFAULT_SYNTHETIC_SEED, periodUsage } from "./synthetic/generator";

export const SYNTHETIC_PROVIDER_NAME = "synthetic";

export class SyntheticMeteringProvider implements MeteringProvider {
  constructor(private readonly seed: string = DEFAULT_SYNTHETIC_SEED) {}

  async getReadings(request: MeteringReadRequest) {
    const fixtures: FixtureReading[] = request.devices.map((device) => {
      const meter = findSyntheticMeter(device.componentId);
      if (!meter || !device.edgeOpenemsId.startsWith(SYNTHETIC_EDGE_ID_PREFIX)) {
        throw new MeteringError(
          "Synthetic metering only serves synthetic demonstration meters",
          "METERING_INVALID_DATA",
          400,
          { deviceId: device.id, microgridId: request.microgridId }
        );
      }
      return {
        deviceId: device.id,
        startDate: request.startDate,
        endDate: request.endDate,
        timezone: request.timezone,
        usageKwh: periodUsage(this.seed, meter, request.startDate, request.endDate).usageKwh,
      };
    });
    return new FixtureMeteringProvider(fixtures).getReadings(request);
  }
}

export function createSyntheticMeteringProvider(seed?: string): MeteringProvider {
  return new SyntheticMeteringProvider(seed?.trim() || DEFAULT_SYNTHETIC_SEED);
}
