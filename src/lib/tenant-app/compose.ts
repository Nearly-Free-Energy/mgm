/**
 * composeTenantApp — the tenant app capability for one signed-in tenant's
 * request about one of their units, on the MGM Cordis runtime (RFC mgm#197
 * § 3, docs/cordis-runtime.md).
 *
 * Authorization is the tenant's own: authorizeTenant settles the session
 * with getUser(), finds the caller's tenant row for the unit and reads the
 * unit with `fn_tenant_home`. Staff rows do not reach a unit here. The
 * plugin gate is then asked about the unit's organization, and a disabled
 * tenant app refuses every call, reads included. The caller disposes the
 * composition in `finally`.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { checkGate, type GateDecision } from "@/lib/runtime/gate";
import { SCOPE_TENANT, TENANT } from "@/lib/roles";
import { authorizeTenant, openOrganizationScope } from "@/lib/runtime/scope";
import "@/lib/runtime/services";
import { TenantAppCapability } from "./capability";
import { createSupabaseTenantAppRepository } from "./infrastructure/supabase-repository";
import "./scope";
import {
  tenantAppFailure,
  type TenantAppCapabilityContract,
  type TenantAppRepository,
  type TenantAppResult,
  type TenantAppScope,
  type TenantUnit,
} from "./types";

export type TenantAppComposition = {
  scope: TenantAppScope;
  tenantApp: TenantAppCapabilityContract;
  dispose(): Promise<void>;
};

export { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION };

export type TenantAppPluginConfig = {
  repository: TenantAppRepository;
  /** The unit authorizeTenant read for this request. */
  unit: TenantUnit;
  /** The clock the capability reads "today" from; tests fix it. */
  now?: () => number;
};

/**
 * The tenant app capability plugin, loaded per request. Unloading it (when
 * the request's scope is disposed) deactivates the capability.
 *
 * It is the only capability plugin built for a scope whose
 * `mgmRequest.organizationId` is not organization access: it reads only the
 * request's user and the unit authorizeTenant read, and checks that the
 * unit is in that organization.
 */
export const TenantAppPlugin = {
  name: TENANT_APP_PLUGIN_NAME,
  inject: ["mgmRequest"],
  apply(ctx: Context, config: TenantAppPluginConfig) {
    const request = ctx.mgmRequest;
    if (!request.userId) throw new Error("The tenant app requires an authenticated user");
    if (request.organizationId !== config.unit.organizationId) {
      throw new Error("The tenant app's unit is not in the request's organization");
    }
    const scope: TenantAppScope = {
      tenantId: config.unit.tenantId,
      organizationId: request.organizationId,
      userId: request.userId,
      unit: config.unit,
    };
    let active = true;
    const capability = new TenantAppCapability(
      config.repository,
      scope,
      () => active,
      config.now
    );
    ctx.provide("tenantAppScope", scope);
    ctx.provide("tenantApp", capability);
    ctx.effect(() => () => {
      active = false;
    });
  },
} satisfies Plugin.Object<TenantAppPluginConfig>;

export async function composeTenantApp(options: {
  supabase: SupabaseClient;
  /** The unit (a `tenants.id`) the request is about. */
  tenantId: string;
  /** The clock the capability reads "today" from; tests fix it. */
  now?: () => number;
}): Promise<TenantAppResult<TenantAppComposition>> {
  const access = await authorizeTenant(options.supabase, options.tenantId);
  if (!access.ok) {
    switch (access.reason) {
      case "invalid_tenant":
        return tenantAppFailure({
          status: 400,
          code: "tenant_app_invalid_tenant",
          message: "Invalid tenant id — expected UUID.",
          field: "tenant_id",
        });
      case "unauthenticated":
        return tenantAppFailure({
          status: 401,
          code: "tenant_app_unauthenticated",
          message: "Authentication required.",
        });
      case "forbidden":
        return tenantAppFailure({
          status: 403,
          code: "tenant_app_forbidden",
          message: "Not authorized to view this unit.",
          reason: "forbidden",
        });
      case "unavailable":
        return tenantAppFailure({
          status: 503,
          code: "tenant_app_unavailable",
          message: "Could not read this unit. Retry the request.",
        });
    }
  }

  // The gate itself, asked as a write on the unit's organization, as the GUI
  // host asks it whether a plugin is live (pluginGate in
  // gui/host/server/gate-state.ts): a read alone always passes the gate,
  // and a disabled tenant app must refuse reads too. So the 409 and 503 and
  // their copy are the gate's own. The state is read with the tenant's own
  // client through `mgm_plugin_enabled_for_org`, which answers any signed-in
  // caller, tenant-only accounts included, about any organization, and
  // counts a missing tenant-app row as off; if it starts checking the
  // caller's organization access, every tenant is refused here with 503.
  // resolveTargetOrganization (@/lib/runtime/gate) returns an organization
  // target's id unchecked, so for a tenant this id is trusted only because
  // it came from `fn_tenant_home` in authorizeTenant; never pass an id taken
  // from the request here.
  let decision: GateDecision;
  try {
    decision = await checkGate(options.supabase, {
      plugin: TENANT_APP_PLUGIN_NAME,
      target: { kind: "organization", id: access.unit.organizationId },
      method: "GET",
      access: "write",
    });
  } catch (error) {
    return compositionFailed(error);
  }
  if (!decision.ok) {
    return tenantAppFailure({
      status: decision.status,
      code: decision.code,
      message: decision.message,
    });
  }

  // An organization scope for a person who may hold no access to that
  // organization: its id is only the unit's, and its roles are only the
  // caller's tenant rows, so a manager who rents carries no staff row into
  // it. Nothing but TenantAppPlugin may be loaded into this scope. Every
  // other capability plugin (community-management, metering, billing,
  // billing-review, payments) treats mgmRequest.organizationId and roles as
  // access its composer authorized with authorizeOrganization, and would
  // then rest on RLS alone, payments with its service-role writer too. The
  // composition hands out no ctx or load, so keep it that way.
  let requestScope: Awaited<ReturnType<typeof openOrganizationScope>> | null = null;
  try {
    requestScope = await openOrganizationScope({
      organizationId: access.unit.organizationId,
      userId: access.user.id,
      roles: access.roles.filter((row) => row.role === TENANT && row.scope_type === SCOPE_TENANT),
      supabase: options.supabase,
    });
    await requestScope.load(TenantAppPlugin, {
      repository: createSupabaseTenantAppRepository(options.supabase),
      unit: access.unit,
      now: options.now,
    });
    const tenantApp = requestScope.ctx.get("tenantApp");
    const scope = requestScope.ctx.get("tenantAppScope");
    if (!tenantApp || !scope) {
      throw new Error("Tenant app capability did not register");
    }
    const opened = requestScope;
    return {
      ok: true,
      data: { scope, tenantApp, dispose: () => opened.dispose() },
    };
  } catch (error) {
    await requestScope?.dispose();
    return compositionFailed(error);
  }
}

function compositionFailed(error: unknown) {
  return tenantAppFailure({
    status: 500,
    code: "tenant_app_composition_failed",
    message:
      error instanceof Error
        ? `Could not compose the tenant app: ${error.message}`
        : "Could not compose the tenant app.",
  });
}
