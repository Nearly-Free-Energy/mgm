/**
 * Supabase implementation of `MeteringRepository`.
 *
 * Composition-root module: the ONLY place in the metering plugin allowed to
 * touch the Supabase client, auth access helpers, plugin state, hierarchy
 * reads, and device projections. The capability consumes the repository
 * interface from `../repository` — see
 * `__tests__/import-boundary.test.ts`.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { isMeteringEnabled } from "@/lib/plugins/state";
import type {
  AssignmentLink,
  ManagedDevice,
  MeteringRepository,
  RepositoryError,
  StoredConnection,
} from "../repository";

function toError(error: { code?: string; message?: string }): RepositoryError {
  return { code: error.code, message: error.message ?? "Unknown database error" };
}

export function createSupabaseMeteringRepository(
  supabase: SupabaseClient
): MeteringRepository {
  return {
    async getAuthenticatedUserId() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user?.id ?? null;
    },

    async getUserRoles() {
      return getCurrentUserRoles(supabase);
    },

    async isPluginEnabled(organizationId: string) {
      return isMeteringEnabled(supabase, organizationId);
    },

    async getMicrogridOrganization(microgridId: string) {
      const { data: microgrid } = await supabase
        .from("microgrids")
        .select("id, community_id")
        .eq("id", microgridId)
        .maybeSingle<{ id: string; community_id: string }>();
      if (!microgrid) return null;
      const { data: community } = await supabase
        .from("communities")
        .select("id, org_id")
        .eq("id", microgrid.community_id)
        .maybeSingle<{ id: string; org_id: string }>();
      if (!community) return null;
      return {
        microgridId: microgrid.id,
        communityId: community.id,
        orgId: community.org_id,
      };
    },

    async getHouseholdOrganization(householdId: string) {
      const { data: household } = await supabase
        .from("households")
        .select("id, microgrid_id")
        .eq("id", householdId)
        .maybeSingle<{ id: string; microgrid_id: string }>();
      if (!household) return null;
      const org = await this.getMicrogridOrganization(household.microgrid_id);
      if (!org) return null;
      return {
        householdId: household.id,
        microgridId: household.microgrid_id,
        orgId: org.orgId,
      };
    },

    async getDeviceOrganization(deviceId: string) {
      const { data: device } = await supabase
        .from("devices")
        .select("id, edge_id")
        .eq("id", deviceId)
        .maybeSingle<{ id: string; edge_id: string }>();
      if (!device) return null;
      const { data: edge } = await supabase
        .from("edges")
        .select("id, microgrid_id")
        .eq("id", device.edge_id)
        .maybeSingle<{ id: string; microgrid_id: string }>();
      if (!edge) return null;
      const org = await this.getMicrogridOrganization(edge.microgrid_id);
      if (!org) return null;
      return {
        deviceId: device.id,
        microgridId: edge.microgrid_id,
        orgId: org.orgId,
      };
    },

    async getStoredConnection(microgridId: string) {
      const { data: mg } = await supabase
        .from("microgrids")
        .select(
          "ems_type, ems_backend_url, ems_aws_region, ems_aws_access_key_id, ems_basic_auth_username, ems_basic_auth_password_encrypted, ems_known_edge_ids, ems_last_discover_at, ems_last_discover_status"
        )
        .eq("id", microgridId)
        .maybeSingle<{
          ems_type: "cloud_aws" | "direct_url" | null;
          ems_backend_url: string | null;
          ems_aws_region: string | null;
          ems_aws_access_key_id: string | null;
          ems_basic_auth_username: string | null;
          ems_basic_auth_password_encrypted: unknown;
          ems_known_edge_ids: string[] | null;
          ems_last_discover_at: string | null;
          ems_last_discover_status: string | null;
        }>();
      if (!mg || !mg.ems_type) return null;
      return {
        type: mg.ems_type,
        backendUrl: mg.ems_backend_url ?? "",
        region: mg.ems_aws_region,
        accessKeyId: mg.ems_aws_access_key_id,
        basicAuthUsername: mg.ems_basic_auth_username,
        hasBasicAuthPassword: mg.ems_basic_auth_password_encrypted != null,
        knownEdgeIds: mg.ems_known_edge_ids ?? [],
        lastDiscoverAt: mg.ems_last_discover_at,
        lastDiscoverStatus: mg.ems_last_discover_status,
      } satisfies StoredConnection;
    },

    async getMicrogridTimezone(microgridId: string) {
      const { data } = await supabase
        .from("microgrids")
        .select("timezone")
        .eq("id", microgridId)
        .maybeSingle<{ timezone: string }>();
      return data?.timezone ?? null;
    },

    async getManagedDevices(microgridId: string) {
      const { data: edges } = await supabase
        .from("edges")
        .select("id, openems_edge_id")
        .eq("microgrid_id", microgridId);
      const edgeIds = (edges ?? []).map((e) => e.id);
      if (edgeIds.length === 0) return [];
      const { data: devices } = await supabase
        .from("devices")
        .select("id, edge_id, name, device_type, openems_component_id")
        .in("edge_id", edgeIds);
      const edgeOpenemsById = new Map(
        (edges ?? []).map((e) => [e.id, e.openems_edge_id as string])
      );
      return ((devices ?? []) as {
        id: string;
        edge_id: string;
        name: string;
        device_type: string;
        openems_component_id: string | null;
      }[]).map((d) => ({
        id: d.id,
        name: d.name,
        edgeId: d.edge_id,
        deviceType: d.device_type,
        edgeOpenemsId: edgeOpenemsById.get(d.edge_id) ?? "",
        componentId: d.openems_component_id ?? "",
      })) satisfies ManagedDevice[];
    },

    async getMicrogridEdges(microgridId: string) {
      const { data } = await supabase
        .from("edges")
        .select("id, name, openems_edge_id")
        .eq("microgrid_id", microgridId);
      return ((data ?? []) as {
        id: string;
        name: string;
        openems_edge_id: string | null;
      }[])
        .filter((e) => e.openems_edge_id)
        .map((e) => ({
          id: e.id,
          openemsEdgeId: e.openems_edge_id as string,
          name: e.name,
        }));
    },

    async getKnownEdgeIds(microgridId: string) {
      const { data } = await supabase
        .from("microgrids")
        .select("ems_known_edge_ids")
        .eq("id", microgridId)
        .maybeSingle<{ ems_known_edge_ids: string[] | null }>();
      return data?.ems_known_edge_ids ?? [];
    },

    async getAssignmentLinks(householdId: string) {
      const { data } = await supabase
        .from("household_devices")
        .select("id, household_id, device_id, role, effective_from, effective_to")
        .eq("household_id", householdId)
        .order("effective_from", { ascending: true });
      return ((data ?? []) as {
        id: string;
        household_id: string;
        device_id: string;
        role: string;
        effective_from: string;
        effective_to: string | null;
      }[]).map((row) => ({
        id: row.id,
        householdId: row.household_id,
        deviceId: row.device_id,
        role: row.role,
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
      })) satisfies AssignmentLink[];
    },

    async insertMeterReading(input: {
      deviceId: string;
      readingKwh: number;
      readAt: string;
    }) {
      const { data, error } = await supabase
        .from("meter_readings")
        .insert({
          device_id: input.deviceId,
          reading_kwh: input.readingKwh,
          read_at: input.readAt,
        })
        .select("id")
        .single<{ id: string }>();
      if (error) return { id: null, error: toError(error) };
      return { id: data.id, error: null };
    },

    async findMeterReadingAt(deviceId: string, readAt: string) {
      const { data } = await supabase
        .from("meter_readings")
        .select("id")
        .eq("device_id", deviceId)
        .eq("read_at", readAt)
        .maybeSingle<{ id: string }>();
      return data ?? null;
    },
  };
}
