import type { DeviceConfig, DeviceReading } from "@/lib/adapters/types";
import type { MeteringProviderName } from "./registry";

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

/**
 * Operator-facing consumption query (issue #4). MGM-owned meter IDs in,
 * per-meter results out. `usageKwh: null` means the register was
 * unavailable — never a substituted aggregate or zero.
 */
export type MeterConsumptionQuery = {
  microgridId: string;
  deviceIds?: string[];
  householdIds?: string[];
  startDate: string;
  endDate: string;
  timezone?: string;
};

export type DeviceConsumption = {
  deviceId: string;
  householdId: string | null;
  usageKwh: number | null;
  source: MeteringProviderName;
  readAt: string;
};

/** One effective-dated assignment link with its meter identity. */
export type AssignmentHistoryEntry = {
  deviceId: string;
  deviceName: string;
  role: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  current: boolean;
};

/** Gap between two consecutive assignment links. */
export type AssignmentGap = {
  from: string;
  to: string | null;
};

/** Safe connection-test outcome. Never carries credentials. */
export type ConnectionTestResult =
  | { ok: true; edgeCount: number; edges: { id: string; name: string }[] }
  | { ok: false; code: "auth_failed" | "unreachable" | "not_configured" | "invalid_config"; message: string };

/** A discovered meter not yet registered as an MGM device. */
export type DiscoveredMeter = {
  edgeId: string;
  componentId: string;
  name: string;
  alreadyRegistered: boolean;
};

/** Operator-supplied opening register for a meter's first billable period. */
export type OpeningRegisterInput = {
  deviceId: string;
  readingKwh: number;
  readAt: string;
};
