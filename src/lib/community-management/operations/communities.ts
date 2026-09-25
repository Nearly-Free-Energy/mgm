import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Community } from "@/lib/types/domain";
import {
  communityFailure,
  type CommunityCreateInput,
  type CommunityManagementError,
  type CommunityManagementResult,
  type CommunityUpdateInput,
  type OrganizationScope,
} from "../types";
import {
  readOptionalString,
  requirePluginEnabled,
  requireScopedAccess,
  resolveCommunityOrganizationId,
  mapRlsError,
  UUID_RE,
} from "./shared";

const OPTIONAL_STRING_FIELDS = [
  "address_line1",
  "address_line2",
  "address_city",
  "address_region",
  "address_country",
  "address_postal_code",
  "geography_notes",
] as const;

function parseCreateInput(
  body: unknown
): CommunityManagementResult<CommunityCreateInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return communityFailure({
      status: 400,
      code: "community_invalid_body",
      message: "Invalid JSON body",
    });
  }
  const record = body as Record<string, unknown>;
  const orgId = typeof record.org_id === "string" ? record.org_id : "";
  if (!UUID_RE.test(orgId)) {
    return communityFailure({
      status: 400,
      code: "community_invalid_org",
      message: "Invalid org_id — expected UUID.",
      field: "org_id",
    });
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return communityFailure({
      status: 422,
      code: "community_name_required",
      message: "Name is required.",
      field: "name",
    });
  }
  return {
    ok: true,
    data: {
      org_id: orgId,
      name,
      address_line1: readOptionalString(record.address_line1),
      address_line2: readOptionalString(record.address_line2),
      address_city: readOptionalString(record.address_city),
      address_region: readOptionalString(record.address_region),
      address_country: readOptionalString(record.address_country),
      address_postal_code: readOptionalString(record.address_postal_code),
      geography_notes: readOptionalString(record.geography_notes),
    },
  };
}

function parseUpdateInput(
  body: unknown
): CommunityManagementResult<CommunityUpdateInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return communityFailure({
      status: 400,
      code: "community_invalid_body",
      message: "Invalid JSON body",
    });
  }
  const record = body as Record<string, unknown>;
  const updates: CommunityUpdateInput = {};

  if ("name" in record) {
    if (typeof record.name !== "string" || !record.name.trim()) {
      return communityFailure({
        status: 422,
        code: "community_name_required",
        message: "Name is required.",
        field: "name",
      });
    }
    updates.name = record.name.trim();
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (field in record) {
      const value = record[field];
      updates[field] = typeof value === "string" && value.trim() ? value.trim() : null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return communityFailure({
      status: 400,
      code: "community_empty_diff",
      message: "No fields to update.",
    });
  }

  return { ok: true, data: updates };
}

export async function createCommunityOperation(
  supabase: SupabaseClient,
  scope: OrganizationScope | undefined,
  body: unknown
): Promise<CommunityManagementResult<Community>> {
  const parsed = parseCreateInput(body);
  if (!parsed.ok) return parsed;

  const accessError = await requireScopedAccess(
    supabase,
    scope,
    parsed.data.org_id,
    "Not authorized to add communities to this organization."
  );
  if (accessError) return accessError;

  const { data, error } = await supabase
    .from("communities")
    .insert(parsed.data)
    .select("*")
    .single();

  if (error) {
    const rlsError = mapRlsError(
      error,
      "Not authorized to add communities to this organization."
    );
    if (rlsError) return rlsError;
    return communityFailure({
      status: 500,
      code: "community_create_failed",
      message: `Failed to create community: ${error.message}`,
    });
  }

  return { ok: true, data: data as Community };
}

export async function updateCommunityOperation(
  supabase: SupabaseClient,
  scope: OrganizationScope | undefined,
  id: string,
  body: unknown
): Promise<CommunityManagementResult<Community>> {
  if (!UUID_RE.test(id)) {
    return communityFailure({
      status: 400,
      code: "community_invalid_id",
      message: "Invalid community id — expected UUID.",
    });
  }

  const parsed = parseUpdateInput(body);
  if (!parsed.ok) return parsed;

  // Preserve the route contract: an inaccessible or missing community is a
  // 403 here because the access helper cannot distinguish the two cases.
  const orgId = await resolveCommunityOrganizationId(supabase, id);
  if (!orgId) {
    return communityFailure({
      status: 403,
      code: "community_forbidden",
      message: "Not authorized to update this community.",
    });
  }

  const accessError = await requireScopedAccess(
    supabase,
    scope,
    orgId,
    "Not authorized to update this community."
  );
  if (accessError) return accessError;

  const { data, error } = await supabase
    .from("communities")
    .update(parsed.data)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    const rlsError = mapRlsError(
      error,
      "Not authorized to update this community."
    );
    if (rlsError) return rlsError;
    return communityFailure({
      status: 500,
      code: "community_update_failed",
      message: `Failed to update community: ${error.message}`,
    });
  }
  if (!data) {
    return communityFailure({
      status: 404,
      code: "community_not_found",
      message: "Community not found.",
    });
  }

  return { ok: true, data: data as Community };
}

export async function assertCommunityPluginForOrganization(
  supabase: SupabaseClient,
  organizationId: string
): Promise<CommunityManagementError | null> {
  return requirePluginEnabled(supabase, organizationId);
}
