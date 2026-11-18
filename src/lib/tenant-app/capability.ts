/**
 * TenantAppCapability — what a signed-in tenant reads about their own unit
 * (RFC mgm#197 § 3).
 *
 * Import boundary: consumes the repository interface only, never a database
 * client, so every read goes through the tenant's own client in the
 * repository the composer built.
 */
import "server-only";

import { dayKeyInZone } from "@/lib/timezone/day-key";
import { validateTimezone } from "@/lib/validation/timezone";
import {
  tenantAppFailure,
  type TenantAppCapabilityContract,
  type TenantAppFailure,
  type TenantAppRepository,
  type TenantAppResult,
  type TenantAppScope,
  type TenantHome,
  type TenantMeter,
  type TenantMeterRole,
} from "./types";

const ROLE_ORDER: Record<TenantMeterRole, number> = {
  primary_consumption_meter: 0,
  secondary_meter: 1,
};

export class TenantAppCapability implements TenantAppCapabilityContract {
  constructor(
    private readonly repo: TenantAppRepository,
    private readonly scope: TenantAppScope,
    private readonly isActive: () => boolean,
    /** The clock "today" is read from; tests fix it. */
    private readonly now: () => number = Date.now
  ) {}

  private ensureActive(): TenantAppFailure | null {
    if (this.isActive()) return null;
    return tenantAppFailure({
      status: 500,
      code: "tenant_app_composition_disposed",
      message: "Tenant app composition has been disposed.",
    });
  }

  /**
   * The unit, its microgrid and the meters assigned to it today. "Today" is
   * the microgrid's day, as the tenant's calendar will be; a stored zone that
   * is not a valid IANA id reads as UTC, as the metering capability does.
   */
  async getHome(): Promise<TenantAppResult<TenantHome>> {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const { unit } = this.scope;
    const timezone = validateTimezone(unit.timezone) ? "UTC" : unit.timezone;
    const date = dayKeyInZone(this.now(), timezone);

    let meters: TenantMeter[];
    try {
      meters = await this.repo.listMetersInForce(unit.tenantId, date);
    } catch {
      return tenantAppFailure({
        status: 503,
        code: "tenant_app_unavailable",
        message: "Could not read the unit's meters. Retry the request.",
      });
    }

    return {
      ok: true,
      data: {
        tenant: { id: unit.tenantId, displayName: unit.displayName, unitLabel: unit.unitLabel },
        microgrid: { name: unit.microgridName, timezone, currency: unit.currency },
        date,
        meters: [...meters].sort(
          (a, b) =>
            ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
            a.name.localeCompare(b.name) ||
            a.deviceId.localeCompare(b.deviceId)
        ),
      },
    };
  }
}
