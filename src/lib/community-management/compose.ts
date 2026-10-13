/**
 * composeCommunityManagement — the community-management capability for one
 * authenticated, organization-scoped request on the MGM Cordis runtime
 * (docs/cordis-runtime.md).
 *
 * The caller must dispose the composition in `finally`. Disposal unloads the
 * capability plugin and marks the capability inactive, so a retained
 * reference cannot write after its request ends.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCommunityManagementEnabled } from "@/lib/plugins/state";
import { COMMUNITY_MANAGEMENT_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { authorizeOrganization, openOrganizationScope } from "@/lib/runtime/scope";
import "@/lib/runtime/services";
import { CommunityManagementCapability } from "./capability";
import { createSupabaseCommunityRepository } from "./infrastructure/supabase-repository";
import "./scope";
import {
  communityFailure,
  type CommunityManagementCapabilityContract,
  type CommunityManagementResult,
  type OrganizationScope,
} from "./types";

export type CommunityManagementComposition = {
  scope: OrganizationScope;
  communityManagement: CommunityManagementCapabilityContract;
  dispose(): Promise<void>;
};

export const COMMUNITY_MANAGEMENT_PLUGIN_NAME = "community-management";
export { COMMUNITY_MANAGEMENT_PLUGIN_VERSION };

/** The community-management capability plugin, loaded per request. */
export const CommunityManagementPlugin = {
  name: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  inject: ["mgmRequest"],
  apply(ctx: Context) {
    const request = ctx.mgmRequest;
    if (!request.userId) {
      throw new Error("Community management requires an authenticated user");
    }
    const scope: OrganizationScope = {
      organizationId: request.organizationId,
      userId: request.userId,
      roles: request.roles,
    };
    let active = true;
    // The capability consumes the repository interface — never the raw
    // client. Query, auth-plumbing, and RLS details stay behind the
    // infrastructure boundary.
    const capability = new CommunityManagementCapability(
      createSupabaseCommunityRepository(request.supabase),
      scope,
      () => active
    );
    ctx.provide("organizationScope", scope);
    ctx.provide("communityManagement", capability);
    ctx.effect(() => () => {
      active = false;
    });
  },
} satisfies Plugin.Object<void>;

export async function composeCommunityManagement(options: {
  supabase: SupabaseClient;
  organizationId: string;
}): Promise<CommunityManagementResult<CommunityManagementComposition>> {
  const access = await authorizeOrganization(options.supabase, options.organizationId);
  if (!access.ok) {
    if (access.reason === "invalid_org") {
      return communityFailure({
        status: 400,
        code: "community_invalid_org",
        message: "Invalid organization id — expected UUID.",
        field: "org_id",
      });
    }
    if (access.reason === "unauthenticated") {
      return communityFailure({
        status: 401,
        code: "community_unauthenticated",
        message: "Authentication required.",
      });
    }
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

  let requestScope: Awaited<ReturnType<typeof openOrganizationScope>> | null = null;
  try {
    requestScope = await openOrganizationScope({
      organizationId: options.organizationId,
      userId: access.user.id,
      roles: access.roles,
      supabase: options.supabase,
    });
    await requestScope.load(CommunityManagementPlugin);
    const communityManagement = requestScope.ctx.get("communityManagement");
    const scope = requestScope.ctx.get("organizationScope");
    if (!communityManagement || !scope) {
      throw new Error("Community management capability did not register");
    }
    const opened = requestScope;
    return {
      ok: true,
      data: { scope, communityManagement, dispose: () => opened.dispose() },
    };
  } catch (error) {
    await requestScope?.dispose();
    return communityFailure({
      status: 500,
      code: "community_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose community management: ${error.message}`
          : "Could not compose community management.",
    });
  }
}
