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
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";
import type {
  Community,
  Tenant,
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

    // Rejects when plugin state cannot be read, a database error included,
    // so the operations can tell "off" from "unknown" and fail closed.
    async isPluginEnabled(organizationId: string) {
      return isPluginEnabledForOrg(supabase, organizationId, "community-management");
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

    async findTenant(tenantId: string) {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, display_name, microgrid_id")
        .eq("id", tenantId)
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

    async getMicrogridCurrencyUse(microgridId: string) {
      const [microgrid, closed] = await Promise.all([
        supabase
          .from("microgrids")
          .select("id, currency")
          .eq("id", microgridId)
          .maybeSingle<{ id: string; currency: string }>(),
        supabase
          .from("billing_periods")
          .select("id", { count: "exact", head: true })
          .eq("microgrid_id", microgridId)
          .eq("status", "closed"),
      ]);
      if (microgrid.error) return { data: null, error: toError(microgrid.error) };
      if (closed.error) return { data: null, error: toError(closed.error) };
      if (!microgrid.data) return { data: null, error: null };
      return {
        data: { currency: microgrid.data.currency, closedPeriods: closed.count ?? 0 },
        error: null,
      };
    },

    async createTenant(args: Record<string, unknown>, withMeter: boolean) {
      const { data, error } = withMeter
        ? await supabase.rpc("fn_create_tenant_with_meter", args as never)
        : await supabase.rpc("fn_create_tenant", args as never);
      if (error) return { data: null, error: toError(error) };
      return { data: data as string, error: null };
    },

    async findDeviceLink(deviceId: string, excludeTenantId: string) {
      // Only OPEN links steal: closed historical links (effective_to set)
      // are replacement history, not live claims.
      const { data } = await supabase
        .from("tenant_devices")
        .select("tenant_id")
        .eq("device_id", deviceId)
        .eq("role", "primary_consumption_meter")
        .neq("tenant_id", excludeTenantId)
        .is("effective_to", null)
        .maybeSingle<{ tenant_id: string }>();
      return data ?? null;
    },

    async getOpenDeviceLink(tenantId: string) {
      const { data } = await supabase
        .from("tenant_devices")
        .select("id, device_id, effective_from")
        .eq("tenant_id", tenantId)
        .eq("role", "primary_consumption_meter")
        .is("effective_to", null)
        .maybeSingle<{ id: string; device_id: string; effective_from: string }>();
      return data ?? null;
    },

    async closeDeviceLink(linkId: string, effectiveTo: string) {
      const { error } = await supabase
        .from("tenant_devices")
        .update({ effective_to: effectiveTo })
        .eq("id", linkId);
      return error ? toError(error) : null;
    },

    async replaceDeviceLink(
      tenantId: string,
      deviceId: string,
      effectiveDate: string
    ) {
      const { data, error } = await supabase.rpc(
        "fn_replace_tenant_device",
        {
          p_tenant_id: tenantId,
          p_device_id: deviceId,
          p_effective_date: effectiveDate,
        }
      );
      if (error) return { id: null, error: toError(error) };
      return { id: data as string, error: null };
    },

    async deleteDeviceLink(linkId: string) {
      const { error } = await supabase
        .from("tenant_devices")
        .delete()
        .eq("id", linkId);
      return error ? toError(error) : null;
    },

    async updateTenantFields(id: string, patch: Record<string, unknown>) {
      const { data, error } = await supabase
        .from("tenants")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single();
      if (error) return { data: null, error: toError(error) };
      return { data: data as Tenant, error: null };
    },

    async refetchTenant(id: string) {
      const { data, error } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", id)
        .single();
      if (error) return { data: null, error: toError(error) };
      return { data: data as Tenant, error: null };
    },

    async countBillingLineItems(tenantId: string) {
      const { count, error } = await supabase
        .from("billing_line_items")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);
      if (error) return { count: null, error: toError(error) };
      return { count, error: null };
    },

    async deleteTenant(id: string) {
      const { data, error } = await supabase
        .from("tenants")
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
