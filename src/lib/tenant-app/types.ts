/**
 * The tenant app's types (RFC mgm#197 § 3): what a signed-in tenant reads
 * about their own unit. Client-safe: types and constants only, so a GUI can
 * name the view model.
 */
import type { DeviceType } from "@/lib/types/domain";

export type TenantAppResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 500 | 503;
      code: string;
      message: string;
      field?: string;
      reason?: string;
    };

export type TenantAppFailure = Extract<TenantAppResult<never>, { ok: false }>;

export function tenantAppFailure(error: Omit<TenantAppFailure, "ok">): TenantAppFailure {
  return { ok: false, ...error };
}

/**
 * One unit as `fn_tenant_home` returns it to the tenant who holds it: the
 * tenant row's name and unit label, and the few microgrid fields a tenant may
 * see. The microgrid and organization ids are for the runtime, which checks
 * the plugin gate of that organization; the views do not show them.
 */
export type TenantUnit = {
  tenantId: string;
  displayName: string;
  unitLabel: string | null;
  microgridId: string;
  microgridName: string;
  /** The microgrid's IANA time zone; the tenant's days are built in it. */
  timezone: string;
  currency: string;
  organizationId: string;
};

/** The unit and the caller one tenant-app request acts for. */
export type TenantAppScope = {
  tenantId: string;
  /** The unit's organization, whose plugin gate the composer checked. */
  organizationId: string;
  userId: string;
  unit: TenantUnit;
};

/**
 * The meter roles the tenant home lists (listMetersInForce), for consumption
 * meters only (USAGE_DEVICE_TYPE), as billing and the metering capability's
 * house meters count them. Only the first is ever the unit's use: see
 * USAGE_METER_ROLE.
 */
export const TENANT_METER_ROLES = ["primary_consumption_meter", "secondary_meter"] as const;
export type TenantMeterRole = (typeof TENANT_METER_ROLES)[number];

/**
 * The only link role and device type whose meter is the unit's use (RFC
 * mgm#197 § 5, as decided on mgm#210 on 19 November 2026: a tenant sees
 * only their own use). That is the unit's primary consumption meter, the
 * meter billing bills the unit for (billing/generate.ts). So a secondary
 * link, which may be to another unit's primary meter, never counts, and
 * neither does a grid meter, a battery or any other device, whatever role
 * links it. listMeterAssignments reads only these links, so the capability
 * and the usage source never see another meter. The overlap trigger and
 * exclusion constraint keep one unit to one primary link a day, but a device
 * may still be two units' primary at once; each then sees its whole use, as
 * billing bills each. If billing ever bills another role or device type,
 * revisit this with it.
 */
export const USAGE_METER_ROLE = "primary_consumption_meter" satisfies TenantMeterRole;
export const USAGE_DEVICE_TYPE = "consumption_meter" satisfies DeviceType;

/** A meter assigned to the tenant, with the assignment's half-open dates. */
export type TenantMeter = {
  deviceId: string;
  name: string;
  deviceType: DeviceType;
  role: TenantMeterRole;
  /** The first day the assignment is in force, `YYYY-MM-DD`. */
  effectiveFrom: string;
  /** The first day it is no longer in force, or null while it lasts. */
  effectiveTo: string | null;
};

/** What `tenant.home` shows: the unit, its microgrid and its meters today. */
export type TenantHome = {
  tenant: { id: string; displayName: string; unitLabel: string | null };
  microgrid: { name: string; timezone: string; currency: string };
  /** Today in `microgrid.timezone`; `meters` are the ones in force on it. */
  date: string;
  meters: TenantMeter[];
};

/** A bucket's state on the tenant's calendar or day (RFC mgm#197 § 5). */
export type TenantUsageState =
  /** Every meter of the unit in force had a value; `kwh` is their sum. */
  | "data"
  /**
   * A bucket that had not ended when the figures were read: the one that
   * held the read time shows the sum so far (or null when nothing had come
   * in), and any later one up to now has null (not read yet). Never counted
   * as missing.
   */
  | "partial"
  /** A meter in force had no value, or the read failed or was refused: no figure, never a lower one. */
  | "no-data"
  /** No meter of the unit was in force. */
  | "no-meter"
  /** After now. */
  | "future";

export type TenantUsageBucket = { state: TenantUsageState; kwh: number | null };

/**
 * Why a read shows no figures at all: `unavailable`, a read that failed and
 * may pass on another try; `limited`, the unit is over its read limit;
 * `not-offered`, nothing to read for this unit (metering is off for its
 * organization, or its microgrid's provider gives no usage series), which no
 * retry changes.
 */
export type TenantUsageProblem = "unavailable" | "limited" | "not-offered";

export type TenantUsageReadInfo = {
  /** When the metering source was read, epoch ms; null when nothing was read. */
  readAt: number | null;
  /** The figures are an earlier read, served because the unit is over its limit or this read failed. */
  stale: boolean;
  /** Generated, not measured (the synthetic provider). */
  synthetic: boolean;
  problem: TenantUsageProblem | null;
};

export type TenantUsageTotal = {
  /**
   * The sum of the `data` and `partial` figures. When some buckets with a
   * meter in force are `no-data`, it is the sum of the others, shown with
   * `withoutData` beside it ("312.4 kWh · 2 days missing", as decided on
   * mgm#210), never as the whole period's use. Null ("No data") when no
   * bucket has a figure, or on a problem.
   */
  kwh: number | null;
  /** Buckets with a meter in force and no figure (`no-data`): what `kwh` leaves out. */
  withoutData: number;
};

export type TenantUsageMonth = {
  tenant: TenantHome["tenant"];
  /** The unit's zone the month is built in (UTC when the stored one is invalid). */
  timezone: string;
  /** The month shown, `YYYY-MM`. */
  month: string;
  /** Today in `timezone`, `YYYY-MM-DD`. */
  today: string;
  /** `YYYY-MM`. */
  previousMonth: string;
  /** `YYYY-MM`; null for the current month. */
  nextMonth: string | null;
  /** Every day of the month, in order. */
  days: (TenantUsageBucket & { date: string })[];
  total: TenantUsageTotal;
  read: TenantUsageReadInfo;
};

export type TenantUsageDay = {
  tenant: TenantHome["tenant"];
  timezone: string;
  date: string;
  today: string;
  previousDate: string;
  /** Null for today. */
  nextDate: string | null;
  /** Meters of the unit in force on `date`. */
  meters: number;
  /** Every local hour of `date` (23–25), in order; `start` is epoch ms. */
  hours: (TenantUsageBucket & { start: number })[];
  total: TenantUsageTotal;
  read: TenantUsageReadInfo;
};

/** What the capability asks the usage source for. */
export type TenantUsageSeriesRequest = {
  /** MGM device ids, each in force for this unit on some day of the range. */
  deviceIds: string[];
  /** The earliest day any of `deviceIds` is in force for this unit, within the view. */
  startDate: string;
  /** The latest such day, inclusive, never after today. */
  endDate: string;
  resolution: "day" | "hour";
  timezone: string;
  /**
   * The capability's clock when the view was asked for, epoch ms. A day the
   * source sums from hours counts only the hours ended by then, so the
   * figure and the view's own "today" and partial day agree.
   */
  nowMs: number;
};

export type TenantUsageSeries = {
  /** Bucket starts, epoch ms: local midnights, or local hour starts. */
  buckets: number[];
  /** kWh per bucket for each requested device id; null where the source has no value. */
  kwh: Record<string, (number | null)[]>;
  synthetic: boolean;
};

export type TenantUsageSeriesResult =
  | { ok: true; series: TenantUsageSeries }
  | { ok: false; reason: "unavailable" | "metering-off" | "unsupported" };

/** A day span on which a device is another unit's primary meter: dates only, never whose. */
export type PrimaryElsewhereSpan = {
  deviceId: string;
  /** The first day of the span, `YYYY-MM-DD`. */
  effectiveFrom: string;
  /** The first day after it, or null while it lasts. */
  effectiveTo: string | null;
};

/**
 * The unit's meters' energy per local day or hour, from the metering
 * provider of the unit's microgrid. Built by TenantAppPlugin
 * (infrastructure/usage-source.ts); the capability never sees a client, a
 * provider or a vendor id.
 */
export interface TenantUsageSource {
  readSeries(request: TenantUsageSeriesRequest): Promise<TenantUsageSeriesResult>;
  /**
   * The spans overlapping [fromDate, toDate) (half-open) on which any of
   * `deviceIds` is another unit's primary consumption meter. Asked only about
   * this unit's own secondary links; an id that is not one is ignored.
   * Rejects when the read fails, so the capability fails closed.
   */
  listPrimaryElsewhere(request: {
    deviceIds: string[];
    fromDate: string;
    toDate: string;
  }): Promise<PrimaryElsewhereSpan[]>;
}

/** The tenant app's reads, through the tenant's own client. */
export interface TenantAppRepository {
  /**
   * The tenant's consumption meters in force on `date`, read through the
   * caller's own row-level access. Rejects when the read fails.
   */
  listMetersInForce(tenantId: string, date: string): Promise<TenantMeter[]>;
  /**
   * The tenant's usage meter links (USAGE_METER_ROLE to a device of
   * USAGE_DEVICE_TYPE) that cover any day from `fromDate` up to, not
   * including, `toDate` (half-open, as billing reads them), through the
   * caller's own row-level access. Rejects when the read fails.
   */
  listMeterAssignments(tenantId: string, fromDate: string, toDate: string): Promise<TenantMeter[]>;
}

/** The tenant app capability. Read-only: a tenant writes nothing. */
export interface TenantAppCapabilityContract {
  getHome(): Promise<TenantAppResult<TenantHome>>;
  /**
   * A month of the unit's use per local day. `month` (YYYY-MM) that is
   * absent, malformed, before 2000-01 or after the current month reads as
   * the current month.
   */
  getUsageMonth(input?: { month?: string }): Promise<TenantAppResult<TenantUsageMonth>>;
  /**
   * One local day of the unit's use per hour. `date` (YYYY-MM-DD) that is
   * absent, malformed, before 2000-01-01 or after today reads as today.
   */
  getUsageDay(input?: { date?: string }): Promise<TenantAppResult<TenantUsageDay>>;
}
