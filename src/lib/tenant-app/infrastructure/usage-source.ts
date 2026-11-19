/**
 * The tenant app's usage source: a unit's meters' energy per local day or
 * hour, from the metering provider of the unit's microgrid (RFC mgm#197 § 5).
 *
 * Privileged. A tenant's own client reads no `microgrids` or `edges` row (no
 * tenant policy on either; CLAUDE.md "No tenant policy on microgrids…"), so
 * provider selection, the OpenEMS edge id and the stored OpenEMS connection,
 * whose credential the provider decrypts, are read on the service role. RFC
 * § 5 decides the way out: the config read takes the tenant's row from
 * `fn_tenant_home` as its authorization. What authorizes each read:
 *
 *   - the metering plugin state: the tenant's client, `checkGate` on the
 *     unit's organization (through `mgm_plugin_enabled_for_org`, which
 *     answers any signed-in caller);
 *   - the device rows (edge uuid, component id): the tenant's client, RLS
 *     "Tenants can read their own devices", filtered to the ids the
 *     capability passes, which the tenant's own `tenant_devices` read
 *     returned;
 *   - `edges.openems_edge_id`: the service role, for the edge ids of those
 *     device rows only, and only on the microgrid `fn_tenant_home` named;
 *   - provider selection, the EMS configuration and its decrypt: the service
 *     role, for that microgrid only;
 *   - other units' primary links of this unit's secondary meters
 *     (listPrimaryElsewhere): the service role, for the device ids the
 *     tenant's own client returned as this unit's `secondary_meter` links,
 *     returning date spans only, never which unit holds them.
 *
 * So no microgrid, edge or device id is ever taken from a request (query,
 * path or body): the microgrid is the unit's, which authorizeTenant read, and
 * the devices are those the tenant's own client returned. Only consumption
 * meters are read (TENANT_USAGE_DEVICE_TYPE): a device of another type that
 * reaches readSeries has no row, so it reads as no data, never as a figure.
 * No service client is created for the metering provider before the
 * metering gate passes, or when no device is readable. The primary-links
 * read concerns MGM's own link rows, not the backend, so it runs without
 * that gate; it runs only for a unit that has secondary links in the range.
 * If it ever returns a tenant id, or takes ids the tenant's own client did
 * not return as this unit's secondary links, revisit it with CLAUDE.md "The
 * tenant app's usage reads". Nothing the backend says reaches the tenant:
 * every failure is a reason, and the server log gets a code and a status,
 * never a message.
 *
 * Only TenantAppPlugin builds this, after composeTenantApp's authorizeTenant
 * (getUser, the caller's tenant row, `fn_tenant_home`) and the tenant-app
 * gate. If this source ever takes a microgrid, edge or device id from a
 * request, runs outside TenantAppPlugin, or the composer stops running
 * authorizeTenant first, revisit it, and its reason in
 * src/lib/__tests__/service-role-session-check.test.ts with it.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeviceConfig } from "@/lib/adapters/types";
import { MeteringError } from "@/lib/metering/errors";
import { METERING_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { checkGate, type GateDecision } from "@/lib/runtime/gate";
import type { MeteringProviderFactories } from "@/lib/runtime/services";
import { isCalendarDateKey } from "@/lib/timezone/day-key";
import {
  TENANT_USAGE_DEVICE_TYPE,
  type PrimaryElsewhereSpan,
  type TenantUnit,
  type TenantUsageSeriesRequest,
  type TenantUsageSeriesResult,
  type TenantUsageSource,
} from "../types";

type DeviceRow = { id: string; edge_id: string | null; openems_component_id: string | null };
type EdgeRow = { id: string; openems_edge_id: string | null };
type PrimaryLinkRow = { device_id: string; effective_from: string; effective_to: string | null };

/** A failed step, logged by name and code only. */
class UsageReadError extends Error {
  constructor(
    readonly step: string,
    readonly code: string | undefined
  ) {
    super(`usage ${step} read failed`);
    this.name = "UsageReadError";
  }
}

function logFailure(error: unknown): void {
  if (error instanceof MeteringError) {
    console.error("[tenant-app] usage read failed", { code: error.code, status: error.statusCode });
  } else if (error instanceof UsageReadError) {
    console.error("[tenant-app] usage read failed", { step: error.step, code: error.code ?? null });
  } else {
    console.error("[tenant-app] usage read failed", {
      code: error instanceof Error ? error.name : typeof error,
    });
  }
}

export function createTenantUsageSource(options: {
  /** The tenant's own client: the metering gate and the device rows are read through it. */
  supabase: SupabaseClient;
  /** The unit authorizeTenant read; its microgrid is the only one read. */
  unit: TenantUnit;
  /** The root registry, ctx.meteringProviders, which TenantAppPlugin injects. */
  providers: MeteringProviderFactories;
}): TenantUsageSource {
  const { supabase, unit, providers } = options;

  return {
    async readSeries(request: TenantUsageSeriesRequest): Promise<TenantUsageSeriesResult> {
      if (request.deviceIds.length === 0) {
        return { ok: true, series: { buckets: [], kwh: {}, synthetic: false } };
      }

      // Read only while metering is on for the unit's organization, as the
      // metering capability re-checks before each provider call: this read
      // is a provider call the tenant app makes for metering. It is asked
      // only for an uncached read, so after metering is turned off nothing
      // more is read from the backend, but a figure the capability cached
      // before then can still be served (../usage-throttle.ts). The target
      // is an organization, so the gate reads no organization row, only
      // `mgm_plugin_enabled_for_org` with the tenant's token; if that
      // function starts checking organization access, every tenant reads
      // "metering-off" here (it answers false) or "unavailable" (it raises).
      // The id is fn_tenant_home's, never the request's.
      let gate: GateDecision;
      try {
        gate = await checkGate(supabase, {
          plugin: METERING_PLUGIN_NAME,
          target: { kind: "organization", id: unit.organizationId },
          method: "GET",
          access: "write",
        });
      } catch (error) {
        logFailure(error);
        return { ok: false, reason: "unavailable" };
      }
      if (!gate.ok) {
        // 409 is the refusal: metering is off. A 503 is the gate failing
        // to read the plugin state, which may pass on the next try.
        if (gate.status === 409) return { ok: false, reason: "metering-off" };
        console.error("[tenant-app] usage read failed", { code: gate.code, status: gate.status });
        return { ok: false, reason: "unavailable" };
      }

      try {
        // The device rows through the tenant's own row-level access: a device
        // id the tenant holds no link to returns nothing, and neither does a
        // device that is not a consumption meter.
        const devices = await supabase
          .from("devices")
          .select("id, edge_id, openems_component_id")
          .in("id", request.deviceIds)
          .eq("device_type", TENANT_USAGE_DEVICE_TYPE);
        if (devices.error) throw new UsageReadError("devices", devices.error.code);
        const deviceRows = ((devices.data ?? []) as DeviceRow[]).filter(
          (row) => request.deviceIds.includes(row.id) && row.edge_id && row.openems_component_id
        );
        const edgeIds = [...new Set(deviceRows.map((row) => row.edge_id as string))];

        const kwh: Record<string, (number | null)[]> = {};
        if (edgeIds.length === 0) {
          // Nothing readable: nothing is sent, and every device reads as no data.
          for (const id of request.deviceIds) kwh[id] = [];
          return { ok: true, series: { buckets: [], kwh, synthetic: false } };
        }

        // Loaded on first use, so a view that reads no usage never needs the key.
        const { createServiceClient } = await import("@/lib/supabase/service");
        const service = createServiceClient();
        // Only those devices' edges, and only on the unit's own microgrid: a
        // meter linked to this unit on another microgrid's edge stays unread.
        const edges = await service
          .from("edges")
          .select("id, openems_edge_id")
          .in("id", edgeIds)
          .eq("microgrid_id", unit.microgridId);
        if (edges.error) throw new UsageReadError("edges", edges.error.code);
        const edgeOpenemsIds = new Map<string, string>();
        for (const row of (edges.data ?? []) as EdgeRow[]) {
          if (edgeIds.includes(row.id) && row.openems_edge_id) edgeOpenemsIds.set(row.id, row.openems_edge_id);
        }
        const configs: DeviceConfig[] = deviceRows.flatMap((row) => {
          const edgeOpenemsId = edgeOpenemsIds.get(row.edge_id as string);
          return edgeOpenemsId
            ? [{ id: row.id, edgeOpenemsId, componentId: row.openems_component_id as string }]
            : [];
        });
        if (configs.length === 0) {
          for (const id of request.deviceIds) kwh[id] = [];
          return { ok: true, series: { buckets: [], kwh, synthetic: false } };
        }

        const name = await providers.select(service, unit.microgridId);
        const provider = providers.create(name, service);
        if (!provider.getDeviceEnergySeries) return { ok: false, reason: "unsupported" };
        const series = await provider.getDeviceEnergySeries({
          microgridId: unit.microgridId,
          devices: configs,
          startDate: request.startDate,
          endDate: request.endDate,
          resolution: request.resolution,
          timezone: request.timezone,
        });
        for (const id of request.deviceIds) {
          const values = Object.hasOwn(series.kwh, id) && configs.some((config) => config.id === id)
            ? series.kwh[id]
            : undefined;
          kwh[id] = values ? [...values] : series.buckets.map(() => null);
        }
        return {
          ok: true,
          series: { buckets: [...series.buckets], kwh, synthetic: provider.synthetic === true },
        };
      } catch (error) {
        logFailure(error);
        return { ok: false, reason: "unavailable" };
      }
    },

    async listPrimaryElsewhere({ deviceIds, fromDate, toDate }): Promise<PrimaryElsewhereSpan[]> {
      try {
        if (!isCalendarDateKey(fromDate) || !isCalendarDateKey(toDate)) {
          throw new UsageReadError("primary-links", "invalid_date");
        }
        if (deviceIds.length === 0) return [];

        // The tenant's own client first ("Tenants can read their own meter
        // assignments"): which of these ids are this unit's secondary links.
        // Only those are asked about on the service role.
        const own = await supabase
          .from("tenant_devices")
          .select("device_id")
          .eq("tenant_id", unit.tenantId)
          .eq("role", "secondary_meter")
          .in("device_id", deviceIds);
        if (own.error) throw new UsageReadError("secondary-links", own.error.code);
        const confirmed = [
          ...new Set(
            ((own.data ?? []) as { device_id: string }[])
              .map((row) => row.device_id)
              .filter((id) => deviceIds.includes(id))
          ),
        ].sort();
        if (confirmed.length === 0) return [];

        // Other units' primary links of those devices, on the service role:
        // a tenant reads no other unit's links. Every other unit counts, on
        // any microgrid, since leaving out more days is the side that shows
        // the tenant nothing that is not theirs. Dates only: the unit is
        // never selected.
        const { createServiceClient } = await import("@/lib/supabase/service");
        const rows = await createServiceClient()
          .from("tenant_devices")
          .select("device_id, effective_from, effective_to")
          .in("device_id", confirmed)
          .eq("role", "primary_consumption_meter")
          .neq("tenant_id", unit.tenantId)
          .lt("effective_from", toDate)
          .or(`effective_to.is.null,effective_to.gt.${fromDate}`);
        if (rows.error) throw new UsageReadError("primary-links", rows.error.code);
        return ((rows.data ?? []) as PrimaryLinkRow[])
          .filter((row) => confirmed.includes(row.device_id))
          .map((row) => ({
            deviceId: row.device_id,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
          }));
      } catch (error) {
        logFailure(error);
        throw error;
      }
    },
  };
}
