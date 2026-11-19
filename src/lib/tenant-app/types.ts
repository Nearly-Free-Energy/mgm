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
 * The meter roles that measure what a tenant uses, as billing and the
 * metering capability's house meters count them.
 */
export const TENANT_METER_ROLES = ["primary_consumption_meter", "secondary_meter"] as const;
export type TenantMeterRole = (typeof TENANT_METER_ROLES)[number];

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

/** The tenant app's reads, through the tenant's own client. */
export interface TenantAppRepository {
  /**
   * The tenant's consumption meters in force on `date`, read through the
   * caller's own row-level access. Rejects when the read fails.
   */
  listMetersInForce(tenantId: string, date: string): Promise<TenantMeter[]>;
}

/**
 * The tenant app capability. Read-only: a tenant writes nothing. The month
 * and day of use (RFC mgm#197 § 5) join `getHome` with the usage reads.
 */
export interface TenantAppCapabilityContract {
  getHome(): Promise<TenantAppResult<TenantHome>>;
}
