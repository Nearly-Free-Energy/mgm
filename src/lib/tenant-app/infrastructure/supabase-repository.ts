/**
 * Supabase implementation of `TenantAppRepository`.
 *
 * Composition-root module: the only place in the tenant app that touches the
 * Supabase client. The composer hands it the tenant's own client, so every
 * read here is the tenant's row-level access and nothing more: no service
 * role, no stored credential.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeviceType } from "@/lib/types/domain";
import {
  TENANT_METER_ROLES,
  type TenantAppRepository,
  type TenantMeter,
  type TenantMeterRole,
} from "../types";

/** A calendar day, as `listMetersInForce` puts it into a PostgREST filter. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Embedded<T> = T | T[] | null;

type MeterLinkRow = {
  device_id: string;
  role: TenantMeterRole;
  effective_from: string;
  effective_to: string | null;
  devices: Embedded<{ id: string; name: string; device_type: DeviceType }>;
};

function one<T>(value: Embedded<T>): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function createSupabaseTenantAppRepository(
  supabase: SupabaseClient
): TenantAppRepository {
  return {
    async listMetersInForce(tenantId: string, date: string): Promise<TenantMeter[]> {
      if (!DATE_KEY_RE.test(date)) throw new Error(`Invalid date key: ${date}`);
      // Links in force on `date`: half-open periods, as 00058 defines them
      // and billing reads them. Only the device columns the home shows are
      // read, never `config` or `openems_component_id`.
      //
      // The inner join keeps a link only while its device row is visible.
      // "Tenants can read their own devices" (20261118100100) shows a tenant
      // the device of every link of theirs, so it drops none of them; if that
      // policy stops covering links in force, meters drop out of the home
      // silently, so revisit this read with it.
      const { data, error } = await supabase
        .from("tenant_devices")
        .select("device_id, role, effective_from, effective_to, devices!inner(id, name, device_type)")
        .eq("tenant_id", tenantId)
        .in("role", [...TENANT_METER_ROLES])
        .lte("effective_from", date)
        .or(`effective_to.is.null,effective_to.gt.${date}`);
      if (error) throw new Error(`Could not read the tenant's meters: ${error.message}`);
      return ((data ?? []) as MeterLinkRow[]).flatMap((row) => {
        const device = one(row.devices);
        if (!device) return [];
        return [
          {
            deviceId: row.device_id,
            name: device.name,
            deviceType: device.device_type,
            role: row.role,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
          },
        ];
      });
    },
  };
}
