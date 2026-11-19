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
  USAGE_DEVICE_TYPE,
  USAGE_METER_ROLE,
  type TenantAppRepository,
  type TenantMeter,
  type TenantMeterRole,
} from "../types";

/** A calendar day, as the reads below put it into a PostgREST filter. */
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

/**
 * The links as meters; a link whose device row is not visible, or whose
 * device is not a consumption meter, is left out. The reads already filter
 * on the device type; this keeps the rule if that embed filter ever stops
 * applying.
 */
function toMeters(rows: MeterLinkRow[]): TenantMeter[] {
  return rows.flatMap((row) => {
    const device = one(row.devices);
    if (!device || device.device_type !== USAGE_DEVICE_TYPE) return [];
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
      //
      // The device-type filter on the embed drops the link row too (an inner
      // join): a grid meter, battery, PV meter or inverter linked to the unit
      // is never one of its meters, on the home or the calendar
      // (USAGE_DEVICE_TYPE).
      const { data, error } = await supabase
        .from("tenant_devices")
        .select("device_id, role, effective_from, effective_to, devices!inner(id, name, device_type)")
        .eq("tenant_id", tenantId)
        .in("role", [...TENANT_METER_ROLES])
        .eq("devices.device_type", USAGE_DEVICE_TYPE)
        .lte("effective_from", date)
        .or(`effective_to.is.null,effective_to.gt.${date}`);
      if (error) throw new Error(`Could not read the tenant's meters: ${error.message}`);
      return toMeters((data ?? []) as MeterLinkRow[]);
    },

    async listMeterAssignments(tenantId: string, fromDate: string, toDate: string): Promise<TenantMeter[]> {
      if (!DATE_KEY_RE.test(fromDate)) throw new Error(`Invalid date key: ${fromDate}`);
      if (!DATE_KEY_RE.test(toDate)) throw new Error(`Invalid date key: ${toDate}`);
      // Links that cover any day of [fromDate, toDate): half-open on both
      // sides, as 00058 defines a link's period and billing reads it. A link
      // that ends on `fromDate` covers none of the range; one that starts on
      // `toDate` neither. The tenant app clips each link to its own days.
      // Same columns and the same inner join as listMetersInForce, so the
      // same note applies: a link drops out if its device row stops being
      // visible to the tenant. The vendor columns are not read here; the
      // usage source reads them. Only the unit's primary consumption meter
      // is its use (USAGE_METER_ROLE): the filter on the joined device
      // drops a link to any other kind of device with the inner join.
      const { data, error } = await supabase
        .from("tenant_devices")
        .select("device_id, role, effective_from, effective_to, devices!inner(id, name, device_type)")
        .eq("tenant_id", tenantId)
        .eq("role", USAGE_METER_ROLE)
        .eq("devices.device_type", USAGE_DEVICE_TYPE)
        .lt("effective_from", toDate)
        .or(`effective_to.is.null,effective_to.gt.${fromDate}`)
        .order("effective_from");
      if (error) throw new Error(`Could not read the tenant's meters: ${error.message}`);
      return toMeters((data ?? []) as MeterLinkRow[]);
    },
  };
}
