/**
 * Supabase implementation of `CommunityManagementRepository`.
 *
 * Composition-root module: this is the ONLY place in the
 * community-management plugin allowed to touch the Supabase client, auth
 * access helpers, plugin state, hierarchy queries, and public-column
 * projections. Domain operations and the capability consume the repository
 * interface from `../types` — see `__tests__/import-boundary.test.ts`.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import {
  getHierarchyLevels,
  type HierarchyScope,
} from "@/lib/hierarchy";
import { isCommunityManagementEnabled } from "@/lib/plugins/state";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";
import type {
  Community,
  Household,
  Microgrid,
} from "@/lib/types/domain";
import type {
  CommunityManagementRepository,
  HierarchyLevel,
  RepositoryError,
  RepositoryResult,
} from "../types";
import type {
  CommunityCreateInput,
  CommunityUpdateInput,
  MicrogridCreateInput,
  MicrogridUpdateInput,
} from "../types";

function toError(error: { code?: string; message?: string }): RepositoryError {
  return { code: error.code, message: error.message ?? "Unknown database error" };
}

export function createSupabaseCommunityRepository(
  supabase: SupabaseClient
): CommunityManagementRepository {
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
      return isCommunityManagementEnabled(supabase, organizationId);
    },

    async getCommunityOrganizationId(communityId: string) {
      const { data } = await supabase
        .from("communities")
        .select("org_id")
        .eq("id", communityId)
        .maybeSingle<{ org_id: string }>();
      return data?.org_id ?? null;
    },

    async getMicrogridOrganization(microgridId: string) {
      const { data: microgrid } = await supabase
        .from("microgrids")
        .select("id, community_id")
        .eq("id", microgridId)
        .maybeSingle<{ id: string; community_id: string }>();
      if (!microgrid) return null;
      const orgId = await this.getCommunityOrganizationId(
        microgrid.community_id
      );
      if (!orgId) return null;
      return {
        microgridId: microgrid.id,
        communityId: microgrid.community_id,
        orgId,
      };
    },

    async findHousehold(householdId: string) {
      const { data, error } = await supabase
        .from("households")
        .select("id, display_name, microgrid_id")
        .eq("id", householdId)
        .maybeSingle<{ id: string; display_name: string; microgrid_id: string }>();
      if (error) return { data: null, error: toError(error) };
      return { data, error: null };
    },

    async insertCommunity(row: CommunityCreateInput) {
      const { data, error } = await supabase
        .from("communities")
        .insert(row)
        .select("*")
        .single();
      if (error) return { data: null, error: toError(error) };
      return { data: data as Community, error: null };
    },

    async updateCommunity(id: string, patch: CommunityUpdateInput) {
      const { data, error } = await supabase
        .from("communities")
        .update(patch)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error) return { data: null, error: toError(error) };
      return { data: (data as Community | null) ?? null, error: null };
    },

    async insertMicrogrid(row: MicrogridCreateInput) {
      const { data, error } = await supabase
        .from("microgrids")
        .insert(row)
        .select(MICROGRID_PUBLIC_COLUMNS)
        .single();
      if (error) return { data: null, error: toError(error) };
      return { data: data as Microgrid, error: null };
    },

    async updateMicrogrid(id: string, patch: MicrogridUpdateInput) {
      const { data, error } = await supabase
        .from("microgrids")
        .update(patch)
        .eq("id", id)
        .select(MICROGRID_PUBLIC_COLUMNS)
        .maybeSingle();
      if (error) return { data: null, error: toError(error) };
      return { data: (data as Microgrid | null) ?? null, error: null };
    },

    async createHousehold(args: Record<string, unknown>, withMeter: boolean) {
      const { data, error } = withMeter
        ? await supabase.rpc("fn_create_household_with_meter", args as never)
        : await supabase.rpc("fn_create_household", args as never);
      if (error) return { data: null, error: toError(error) };
      return { data: data as string, error: null };
    },

    async findDeviceLink(deviceId: string, excludeHouseholdId: string) {
      const { data } = await supabase
        .from("household_devices")
        .select("household_id")
        .eq("device_id", deviceId)
        .eq("role", "primary_consumption_meter")
        .neq("household_id", excludeHouseholdId)
        .maybeSingle<{ household_id: string }>();
      return data ?? null;
    },

    async clearDeviceLinks(householdId: string) {
      const { error } = await supabase
        .from("household_devices")
        .delete()
        .eq("household_id", householdId)
        .eq("role", "primary_consumption_meter");
      return error ? toError(error) : null;
    },

    async insertDeviceLink(householdId: string, deviceId: string) {
      const { error } = await supabase.from("household_devices").insert({
        household_id: householdId,
        device_id: deviceId,
        role: "primary_consumption_meter",
      });
      return error ? toError(error) : null;
    },

    async updateHouseholdFields(id: string, patch: Record<string, unknown>) {
      const { data, error } = await supabase
        .from("households")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single();
      if (error) return { data: null, error: toError(error) };
      return { data: data as Household, error: null };
    },

    async refetchHousehold(id: string) {
      const { data, error } = await supabase
        .from("households")
        .select("*")
        .eq("id", id)
        .single();
      if (error) return { data: null, error: toError(error) };
      return { data: data as Household, error: null };
    },

    async countBillingLineItems(householdId: string) {
      const { count, error } = await supabase
        .from("billing_line_items")
        .select("id", { count: "exact", head: true })
        .eq("household_id", householdId);
      if (error) return { count: null, error: toError(error) };
      return { count, error: null };
    },

    async deleteHousehold(id: string) {
      const { data, error } = await supabase
        .from("households")
        .delete()
        .eq("id", id)
        .select("id");
      if (error) return { data: null, error: toError(error) };
      return {
        data: (data ?? []) as { id: string }[],
        error: null,
      };
    },

    async resolveHierarchyLevels(
      scope: HierarchyScope
    ): Promise<HierarchyLevel[]> {
      return getHierarchyLevels(supabase, scope);
    },
  };
}

export type { RepositoryError, RepositoryResult };
