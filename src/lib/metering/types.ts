import type { DeviceConfig, DeviceReading } from "@/lib/adapters/types";

/**
 * Provider-neutral input for one billing-period meter read.
 *
 * The billing engine owns the domain IDs, stamped period timezone and date
 * window. A provider resolves any vendor-specific identifiers contained in
 * `devices` and must not substitute an aggregate/site channel for a device.
 */
export type MeteringReadRequest = {
  microgridId: string;
  devices: DeviceConfig[];
  startDate: string;
  endDate: string;
  timezone: string;
};

/** A request-scoped metering dependency for the billing engine. */
export interface MeteringProvider {
  getReadings(request: MeteringReadRequest): Promise<DeviceReading[]>;
}

