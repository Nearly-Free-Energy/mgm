import "server-only";

import { Context, type Fiber } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { ORG_MANAGER, SCOPE_ORG, SUPER_ADMIN } from "@/lib/roles";
import { isCommunityManagementEnabled } from "@/lib/plugins/state";
import { COMMUNITY_MANAGEMENT_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { CommunityManagementCapability } from "./capability";
import "./scope";
import {
  communityFailure,
  type CommunityManagementCapabilityContract,
  type CommunityManagementResult,
  type OrganizationScope,
} from "./types";
import { UUID_RE } from "./operations/shared";

export type CommunityManagementComposition = {
  scope: OrganizationScope;
  communityManagement: CommunityManagementCapabilityContract;
  dispose(): Promise<void>;
};

export const COMMUNITY_MANAGEMENT_PLUGIN_NAME = "community-management";
export { COMMUNITY_MANAGEMENT_PLUGIN_VERSION };

function organizationScopePlugin(context: Context, scope: OrganizationScope) {
  return context.provide("organizationScope", scope);
}

function communityManagementPlugin(
  context: Context,
  capability: CommunityManagementCapabilityContract
) {
  return context.provide("communityManagement", capability);
}

/**
 * Compose one authenticated, organization-scoped Cordis context per caller.
 *
 * The caller must dispose the composition in `finally`. Disposal removes the
 * provided scope/capability from the context and marks the capability
 * inactive, so a retained reference cannot write after its request ends.
 */
export async function composeCommunityManagement(options: {
  supabase: SupabaseClient;
  organizationId: string;
}): Promise<CommunityManagementResult<CommunityManagementComposition>> {
  if (!UUID_RE.test(options.organizationId)) {
    return communityFailure({
      status: 400,
      code: "community_invalid_org",
      message: "Invalid organization id — expected UUID.",
      field: "org_id",
    });
  }

  const {
    data: { user },
  } = await options.supabase.auth.getUser();
  if (!user) {
    return communityFailure({
      status: 401,
      code: "community_unauthenticated",
      message: "Authentication required.",
    });
  }

  const roles = await getCurrentUserRoles(options.supabase);
  const canAccess =
    roles.some((role) => role.role === SUPER_ADMIN) ||
    roles.some(
      (role) =>
        role.role === ORG_MANAGER &&
        role.scope_type === SCOPE_ORG &&
        role.scope_id === options.organizationId
    );
  if (!canAccess) {
    return communityFailure({
      status: 403,
      code: "community_forbidden",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });
  }

  if (!(await isCommunityManagementEnabled(options.supabase, options.organizationId))) {
    return communityFailure({
      status: 409,
      code: "community_management_disabled",
      message:
        "Community management is disabled for this organization. Enable it in Settings → Plugins; existing records are preserved.",
    });
  }

  const scope: OrganizationScope = {
    organizationId: options.organizationId,
    userId: user.id,
    roles,
  };
  const context = new Context();
  const fibers: Fiber[] = [];
  let active = true;
  const capability = new CommunityManagementCapability(
    options.supabase,
    scope,
    () => active
  );

  try {
    fibers.push(await context.plugin(organizationScopePlugin, scope));
    fibers.push(await context.plugin(communityManagementPlugin, capability));
    if (!context.communityManagement || !context.organizationScope) {
      throw new Error("Community management capability did not register");
    }
  } catch (error) {
    active = false;
    await Promise.allSettled(
      [...fibers].reverse().map((fiber) => fiber.dispose())
    );
    return communityFailure({
      status: 500,
      code: "community_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose community management: ${error.message}`
          : "Could not compose community management.",
    });
  }

  return {
    ok: true,
    data: {
      scope,
      communityManagement: context.communityManagement,
      async dispose() {
        for (const fiber of [...fibers].reverse()) await fiber.dispose();
        active = false;
      },
    },
  };
}
