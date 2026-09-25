import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  currentUserCanAccessCommunity,
  currentUserCanAccessMicrogrid,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import { isCommunityManagementEnabled } from "@/lib/plugins/state";
import {
  communityFailure,
  type CommunityManagementError,
  type OrganizationScope,
} from "../types";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isMissingScope(
  scope: OrganizationScope | undefined,
  organizationId: string
): CommunityManagementError | null {
  if (!scope) {
    return communityFailure({
      status: 401,
      code: "community_unauthenticated",
      message: "Authentication required.",
    });
  }
  if (scope.organizationId !== organizationId) {
    return communityFailure({
      status: 403,
      code: "community_scope_mismatch",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });
  }
  return null;
}

export async function requirePluginEnabled(
  supabase: SupabaseClient,
  organizationId: string
): Promise<CommunityManagementError | null> {
  if (!(await isCommunityManagementEnabled(supabase, organizationId))) {
    return communityFailure({
      status: 409,
      code: "community_management_disabled",
      message:
        "Community management is disabled for this organization. Enable it in Settings → Plugins; existing records are preserved.",
    });
  }
  return null;
}

export async function requireScopedAccess(
  supabase: SupabaseClient,
  scope: OrganizationScope | undefined,
  organizationId: string,
  message: string
): Promise<CommunityManagementError | null> {
  const scopeError = isMissingScope(scope, organizationId);
  if (scopeError) return scopeError;

  // The Cordis composition already established organization access. Re-check
  // here because role rows can change between composition and the write; RLS
  // remains the final authority and maps to the same 403 below.
  if (!(await currentUserCanAccessOrg(supabase, organizationId))) {
    return communityFailure({
      status: 403,
      code: "community_forbidden",
      message,
      reason: "forbidden",
    });
  }

  return requirePluginEnabled(supabase, organizationId);
}

export async function resolveCommunityOrganizationId(
  supabase: SupabaseClient,
  communityId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("communities")
    .select("org_id")
    .eq("id", communityId)
    .maybeSingle<{ org_id: string }>();
  return data?.org_id ?? null;
}

export async function resolveMicrogridOrganizationId(
  supabase: SupabaseClient,
  microgridId: string
): Promise<{ microgridId: string; communityId: string; orgId: string } | null> {
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, community_id")
    .eq("id", microgridId)
    .maybeSingle<{ id: string; community_id: string }>();
  if (!microgrid) return null;
  const orgId = await resolveCommunityOrganizationId(
    supabase,
    microgrid.community_id
  );
  if (!orgId) return null;
  return { microgridId: microgrid.id, communityId: microgrid.community_id, orgId };
}

export async function requireCommunityAccess(
  supabase: SupabaseClient,
  communityId: string,
  message: string
): Promise<CommunityManagementError | null> {
  if (!(await currentUserCanAccessCommunity(supabase, communityId))) {
    return communityFailure({ status: 403, code: "community_forbidden", message });
  }
  return null;
}

export async function requireMicrogridAccess(
  supabase: SupabaseClient,
  microgridId: string,
  message: string
): Promise<CommunityManagementError | null> {
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return communityFailure({ status: 403, code: "community_forbidden", message });
  }
  return null;
}

export function mapRlsError(
  error: { code?: string; message?: string },
  message: string
): CommunityManagementError | null {
  if (error.code === "42501" || (error.message ?? "").includes("row-level security")) {
    return communityFailure({ status: 403, code: "community_forbidden", message });
  }
  return null;
}
