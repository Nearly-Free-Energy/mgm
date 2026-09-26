/**
 * composeMetering — one authenticated, organization-scoped Cordis context
 * per caller for the metering plugin (issue #4).
 *
 * Mirrors the community-management composition: the caller selects no
 * provider and supplies no credentials. The composition registers the
 * provider registry (OpenEMS always; fixture only when explicitly
 * configured for tests/demos), the OpenEMS connection plugin, and the
 * metering capability, then disposes everything in `finally`.
 */
import "server-only";

import { Context, type Fiber } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { ORG_MANAGER, SCOPE_ORG, SUPER_ADMIN } from "@/lib/roles";
import { METERING_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { createOpenEmsMeteringProvider } from "./openems-provider";
import { FixtureMeteringProvider, type FixtureReading } from "./fixture-provider";
import { MeteringRegistry } from "./registry";
import { MeteringCapability } from "./capability";
import { createOpenEmsConnection } from "./infrastructure/openems-connection";
import { createSupabaseMeteringRepository } from "./infrastructure/supabase-repository";
import "./scope";
import {
  meteringFailure,
  type MeteringCapabilityContract,
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

function meteringScopePlugin(context: Context, scope: MeteringScope) {
  return context.provide("meteringScope", scope);
}

function meteringRegistryPlugin(context: Context, registry: MeteringRegistry) {
  return context.provide("meteringRegistry", registry);
}

function openEmsProviderPlugin(
  _context: Context,
  config: { registry: MeteringRegistry; supabase: SupabaseClient }
) {
  return config.registry.register(
    "openems",
    createOpenEmsMeteringProvider(config.supabase)
  );
}

function fixtureProviderPlugin(
  _context: Context,
  config: { registry: MeteringRegistry; readings: readonly FixtureReading[] }
) {
  return config.registry.register(
    "fixture",
    new FixtureMeteringProvider(config.readings)
  );
}

function meteringCapabilityPlugin(
  context: Context,
  capability: MeteringCapabilityContract
) {
  return context.provide("metering", capability);
}

export async function composeMetering(options: {
  supabase: SupabaseClient;
  organizationId: string;
  /** Fixture registration is opt-in and only used by tests/demos. */
  fixtureReadings?: readonly FixtureReading[];
}): Promise<MeteringResult<MeteringComposition>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    options.organizationId
  )) {
    return meteringFailure({
      status: 400,
      code: "metering_invalid_org",
      message: "Invalid organization id — expected UUID.",
      field: "org_id",
    });
  }

  const {
    data: { user },
  } = await options.supabase.auth.getUser();
  if (!user) {
    return meteringFailure({
      status: 401,
      code: "metering_unauthenticated",
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
    return meteringFailure({
      status: 403,
      code: "metering_forbidden",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });
  }

  const repository = createSupabaseMeteringRepository(options.supabase);
  if (!(await repository.isPluginEnabled(options.organizationId))) {
    return meteringFailure({
      status: 409,
      code: "metering_disabled",
      message:
        "Metering is disabled for this organization. Enable it in Settings → Plugins; configuration, assignments, and readings are preserved.",
    });
  }

  const scope: MeteringScope = {
    organizationId: options.organizationId,
    userId: user.id,
    roles,
  };
  const context = new Context();
  const registry = new MeteringRegistry();
  const fibers: Fiber[] = [];
  let active = true;
  const capability = new MeteringCapability(
    repository,
    scope,
    registry,
    createOpenEmsConnection(options.supabase, repository),
    () => active
  );

  try {
    fibers.push(await context.plugin(meteringScopePlugin, scope));
    fibers.push(await context.plugin(meteringRegistryPlugin, registry));
    fibers.push(
      await context.plugin(openEmsProviderPlugin, {
        registry,
        supabase: options.supabase,
      })
    );
    if (options.fixtureReadings) {
      fibers.push(
        await context.plugin(fixtureProviderPlugin, {
          registry,
          readings: options.fixtureReadings,
        })
      );
    }
    fibers.push(await context.plugin(meteringCapabilityPlugin, capability));
    if (!context.metering) {
      throw new Error("Metering capability did not register");
    }
  } catch (error) {
    active = false;
    registry.clear();
    await Promise.allSettled(
      [...fibers].reverse().map((fiber) => fiber.dispose())
    );
    return meteringFailure({
      status: 500,
      code: "metering_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose metering: ${error.message}`
          : "Could not compose metering.",
    });
  }

  return {
    ok: true,
    data: {
      scope,
      metering: capability,
      async dispose() {
        for (const fiber of [...fibers].reverse()) await fiber.dispose();
        registry.clear();
        active = false;
      },
    },
  };
}
