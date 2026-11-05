/**
 * composeMetering — the metering capability for one authenticated,
 * organization-scoped request on the MGM Cordis runtime (issue #4,
 * docs/cordis-runtime.md).
 *
 * The caller selects no provider and supplies no credentials. Metering
 * sources come from the root `meteringProviders` registry (the OpenEMS
 * platform plugin registers there); the fixture source is opt-in per request
 * for tests and demos. The caller disposes the composition in `finally`.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { METERING_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { authorizeOrganization, openOrganizationScope } from "@/lib/runtime/scope";
import "@/lib/runtime/services";
import { FixtureMeteringProvider, type FixtureReading } from "./fixture-provider";
import { MeteringRegistry } from "./registry";
import { MeteringCapability } from "./capability";
import { createOpenEmsConnection } from "./infrastructure/openems-connection";
import { createSupabaseMeteringRepository } from "./infrastructure/supabase-repository";
import "./scope";
import {
  meteringFailure,
  type MeteringCapabilityContract,
  type MeteringRepository,
  type MeteringResult,
  type MeteringScope,
} from "./repository";

export type MeteringComposition = {
  scope: MeteringScope;
  metering: MeteringCapabilityContract;
  dispose(): Promise<void>;
};

export type { MeteringResult } from "./repository";

export const METERING_PLUGIN_NAME = "metering";
export { METERING_PLUGIN_VERSION };

export type MeteringPluginConfig = {
  repository: MeteringRepository;
  /** Fixture registration is opt-in and only used by tests/demos. */
  fixtureReadings?: readonly FixtureReading[];
};

/**
 * The metering capability plugin. Loaded into a request scope; unloads (and
 * deactivates the capability) when the request's `mgmRequest` goes away.
 */
export const MeteringPlugin = {
  name: METERING_PLUGIN_NAME,
  inject: ["mgmRequest", "meteringProviders"],
  apply(ctx: Context, config: MeteringPluginConfig) {
    const request = ctx.mgmRequest;
    if (!request.userId) throw new Error("Metering requires an authenticated user");
    const scope: MeteringScope = {
      organizationId: request.organizationId,
      userId: request.userId,
      roles: request.roles,
    };
    const registry = new MeteringRegistry();
    for (const name of ctx.meteringProviders.names()) {
      registry.register(name, ctx.meteringProviders.create(name, request.supabase));
    }
    if (config.fixtureReadings) {
      registry.register("fixture", new FixtureMeteringProvider(config.fixtureReadings));
    }
    let active = true;
    const capability = new MeteringCapability(
      config.repository,
      scope,
      registry,
      createOpenEmsConnection(request.supabase, config.repository),
      () => active
    );
    ctx.provide("meteringScope", scope);
    ctx.provide("meteringRegistry", registry);
    ctx.provide("metering", capability);
    ctx.effect(() => () => {
      active = false;
      registry.clear();
    });
  },
} satisfies Plugin.Object<MeteringPluginConfig>;

export async function composeMetering(options: {
  supabase: SupabaseClient;
  organizationId: string;
  /** Fixture registration is opt-in and only used by tests/demos. */
  fixtureReadings?: readonly FixtureReading[];
}): Promise<MeteringResult<MeteringComposition>> {
  const access = await authorizeOrganization(options.supabase, options.organizationId);
  if (!access.ok) {
    if (access.reason === "invalid_org") {
      return meteringFailure({
        status: 400,
        code: "metering_invalid_org",
        message: "Invalid organization id — expected UUID.",
        field: "org_id",
      });
    }
    if (access.reason === "unauthenticated") {
      return meteringFailure({
        status: 401,
        code: "metering_unauthenticated",
        message: "Authentication required.",
      });
    }
    return meteringFailure({
      status: 403,
      code: "metering_forbidden",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });
  }

  const repository = createSupabaseMeteringRepository(options.supabase);
  // Read through `isPluginEnabledForOrg`, as `MgmGate.check` does, not
  // `isMeteringEnabled`: supabase-js resolves a failed read as `{ error }`
  // rather than rejecting, which that helper reads as disabled (409) and this
  // call throws on. So an unreadable state fails closed with the gate's 503
  // code and copy, before any scope opens. Each gated call re-checks with the
  // same codes and copy (`requirePlugin` in capability.ts). If the gate's
  // read, code or copy changes, change them here and there too.
  let enabled: boolean;
  try {
    enabled = await isPluginEnabledForOrg(
      options.supabase,
      options.organizationId,
      METERING_PLUGIN_NAME
    );
  } catch {
    return meteringFailure({
      status: 503,
      code: "metering_gate_unavailable",
      message: "Could not verify whether Metering is enabled. Retry the request.",
    });
  }
  if (!enabled) {
    return meteringFailure({
      status: 409,
      code: "metering_disabled",
      message:
        "Metering is disabled for this organization. Enable it in Settings → Plugins; configuration, assignments, and readings are preserved.",
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
    await requestScope.load(MeteringPlugin, {
      repository,
      fixtureReadings: options.fixtureReadings,
    });
    const metering = requestScope.ctx.get("metering");
    const scope = requestScope.ctx.get("meteringScope");
    if (!metering || !scope) {
      throw new Error("Metering capability did not register");
    }
    const opened = requestScope;
    return {
      ok: true,
      data: { scope, metering, dispose: () => opened.dispose() },
    };
  } catch (error) {
    await requestScope?.dispose();
    return meteringFailure({
      status: 500,
      code: "metering_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose metering: ${error.message}`
          : "Could not compose metering.",
    });
  }
}
