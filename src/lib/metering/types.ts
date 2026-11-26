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
  /** Fail closed if 15-minute coverage cannot verify the complete period. */
  requireCompletePeriod?: boolean;
};

/** A request-scoped metering dependency for the billing engine. */
export interface MeteringProvider {
  /**
   * Set by a provider whose figures are generated, not measured, so a view
   * can label them.
   */
  readonly synthetic?: true;
  getReadings(request: MeteringReadRequest): Promise<DeviceReading[]>;
  /**
   * Site power and battery samples for whole local days. Optional: a source
   * that cannot provide them leaves it out, and the daily operations view
   * says so instead of showing zeros.
   */
  getSiteSamples?(request: SiteSamplesRequest): Promise<SiteSamples>;
  /**
   * Energy per local day or hour for each device. Optional: a source that
   * cannot provide it leaves it out, and a tenant's usage shows no figures,
   * with the copy for that case in TENANT_USAGE_PROBLEMS
   * (src/lib/tenant-app/surface/usage-model.ts).
   */
  getDeviceEnergySeries?(request: DeviceEnergySeriesRequest): Promise<DeviceEnergySeries>;
}

/** The width of one bucket of an energy series. */
export type EnergySeriesResolution = "day" | "hour";

/**
 * Energy counted by meters, per local day or local hour, over whole local
 * days. Provider-neutral: a provider maps each device to its own counter.
 */
export type DeviceEnergySeriesRequest = {
  microgridId: string;
  devices: DeviceConfig[];
  /** Whole local days in `timezone`, `endDate` inclusive. */
  startDate: string;
  endDate: string;
  resolution: EnergySeriesResolution;
  /** The microgrid's IANA zone; passed to the source as is (no offset arithmetic). */
  timezone: string;
  /**
   * The instant the caller counts as now, epoch ms; the provider's own clock
   * when absent. A provider that sums days from hours leaves out the hours
   * that have not ended by then.
   */
  nowMs?: number;
};

/**
 * One bucket per local day ("day") or local hour ("hour") from the start of
 * `startDate` to the end of `endDate`, ascending; a day with a daylight-saving
 * change has 23 or 25 hours. `kwh[device.id][i]` is what the meter counted in
 * bucket i, or null when the source has no value for it: never a substituted
 * zero, never a value from outside the requested range.
 */
export type DeviceEnergySeries = {
  /** Bucket starts, epoch ms: local midnights, or local hour starts. */
  buckets: number[];
  kwh: Record<string, (number | null)[]>;
};

/**
 * The site devices a daily operations view reads, by what they are rather
 * than by vendor channel. A provider maps each one to its own channels.
 */
export type SiteSources = {
  battery: DeviceConfig | null;
  gridMeter: DeviceConfig | null;
  load: DeviceConfig | null;
  pv: DeviceConfig | null;
  /**
   * The tenant meters (consumption meters linked to a tenant as its
   * primary or secondary meter on the day read): what the houses themselves
   * used.
   */
  houseMeters: DeviceConfig[];
  /**
   * Linked tenant meters that cannot be read because they have no edge
   * or component id, or, in a capture, because their ids fall outside the
   * stored format (`requireStorableIds` in capability.ts; the page's reads
   * apply no format check, and if getSiteDay comes to apply it, revisit).
   * Not requested; reported so a total that leaves them out does not look
   * complete.
   */
  houseMetersUnreadable: number;
};

export type SiteSamplesRequest = {
  microgridId: string;
  sources: SiteSources;
  /** Whole local days in `timezone`, `endDate` inclusive. */
  startDate: string;
  endDate: string;
  timezone: string;
  resolutionMinutes: number;
};

/**
 * Bin-aligned samples, each array the same length as `timestamps` (epoch
 * milliseconds, bin start). `null` means no value reached the provider for
 * that bin — never a substituted zero. Power is in W (battery: + discharge,
 * − charge; grid: + import, − export), state of charge in %, voltage in V.
 */
export type SiteSamples = {
  timestamps: number[];
  batterySocPct: (number | null)[];
  batteryPowerW: (number | null)[];
  gridPowerW: (number | null)[];
  /**
   * Lowest phase voltage of the grid meter in the bin, over the phases that
   * reported (a phase with no value is ignored), so one phase down shows.
   */
  gridVoltageV: (number | null)[];
  loadPowerW: (number | null)[];
  pvPowerW: (number | null)[];
  /**
   * Each house meter's cumulative consumption counter in Wh, keyed by MGM
   * device id: one series per house meter in the request, bin-aligned like
   * the others, all null when the meter gave nothing.
   */
  houseEnergyWh: Record<string, (number | null)[]>;
  /**
   * How many distinct timestamps the source sent that could not be read as
   * instants, dropped with their values. Set only by a provider that counts
   * them; absent means not counted, never that none were dropped. A
   * generated source makes its own instants, so the fixture sets it only on
   * a window that holds a pinned day dropping some (fixture/pinned-days.ts).
   */
  unreadableTimestamps?: number;
};

/**
 * Operator-facing consumption query (issue #4). MGM-owned meter IDs in,
 * per-meter results out. `usageKwh: null` means the register was
 * unavailable — never a substituted aggregate or zero.
 */
export type MeterConsumptionQuery = {
  microgridId: string;
  deviceIds?: string[];
  tenantIds?: string[];
  startDate: string;
  endDate: string;
  timezone?: string;
};

export type DeviceConsumption = {
  deviceId: string;
  tenantId: string | null;
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
