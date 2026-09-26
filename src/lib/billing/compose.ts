/**
 * composeBilling — one authenticated, organization-scoped Cordis context
 * per caller for the billing plugin (issue #5).
 *
 * Mirrors the metering composition: the caller selects no provider and
 * supplies no credentials. The composition wires the MBE bill engine
 * (`runGenerationFor`) to the request-scoped OpenEMS metering provider —
 * billing never constructs a vendor client itself — then disposes
 * everything in `finally`.
 */
import "server-only";

import { Context, type Fiber } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { ORG_MANAGER, SCOPE_ORG, SUPER_ADMIN } from "@/lib/roles";
import { BILLING_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { createOpenEmsMeteringProvider } from "@/lib/metering/openems-provider";
import { BillingCapability } from "./capability";
import { createSupabaseBillingRepository } from "./infrastructure/supabase-repository";
import { isRunGenerationFatal, runGenerationFor } from "./generate";
import "./scope";
import {
  billingFailure,
  type BillingCapabilityContract,
  type BillingGeneration,
  type BillingResult,
  type BillingScope,
} from "./repository";

export type BillingComposition = {
  scope: BillingScope;
  billing: BillingCapabilityContract;
  dispose(): Promise<void>;
};

export type { BillingResult } from "./repository";

export const BILLING_PLUGIN_NAME = "billing";
export { BILLING_PLUGIN_VERSION };

function billingScopePlugin(context: Context, scope: BillingScope) {
  return context.provide("billingScope", scope);
}

function billingCapabilityPlugin(
  context: Context,
  capability: BillingCapabilityContract
) {
  return context.provide("billing", capability);
}

export async function composeBilling(options: {
  supabase: SupabaseClient;
  organizationId: string;
}): Promise<BillingResult<BillingComposition>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    options.organizationId
  )) {
    return billingFailure({
      status: 400,
      code: "billing_invalid_org",
      message: "Invalid organization id — expected UUID.",
      field: "org_id",
    });
  }

  const {
    data: { user },
  } = await options.supabase.auth.getUser();
  if (!user) {
    return billingFailure({
      status: 401,
      code: "billing_unauthenticated",
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
    return billingFailure({
      status: 403,
      code: "billing_forbidden",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });
  }

  const repository = createSupabaseBillingRepository(options.supabase);
  if (!(await repository.isPluginEnabled(options.organizationId))) {
    return billingFailure({
      status: 409,
      code: "billing_disabled",
      message:
        "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.",
    });
  }

  const scope: BillingScope = {
    organizationId: options.organizationId,
    userId: user.id,
    roles,
  };
  const context = new Context();
  const fibers: Fiber[] = [];
  let active = true;
  // The MBE engine stays behind the generation delegate: the capability
  // validates scope and plugin state, then delegates. Vendor resolution
  // (OpenEMS provider) happens here, once per request.
  const generation: BillingGeneration = {
    async run(input) {
      const out = await runGenerationFor({
        supabase: options.supabase,
        periodId: input.periodId,
        householdIds: input.householdIds,
        manualReadings: input.manualReadings,
        seedReadings: input.seedReadings,
        mode: input.mode,
        actorUserId: input.actorUserId,
        meteringProvider: createOpenEmsMeteringProvider(options.supabase),
        requireEffectiveDatedAssignments: true,
      });
      if (isRunGenerationFatal(out)) return out;
      return { results: out.results };
    },
  };
  const capability = new BillingCapability(repository, scope, generation, () => active);

  try {
    fibers.push(await context.plugin(billingScopePlugin, scope));
    fibers.push(await context.plugin(billingCapabilityPlugin, capability));
    if (!context.billing || !context.billingScope) {
      throw new Error("Billing capability did not register");
    }
  } catch (error) {
    active = false;
    await Promise.allSettled(
      [...fibers].reverse().map((fiber) => fiber.dispose())
    );
    return billingFailure({
      status: 500,
      code: "billing_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose billing: ${error.message}`
          : "Could not compose billing.",
    });
  }

  return {
    ok: true,
    data: {
      scope,
      billing: capability,
      async dispose() {
        for (const fiber of [...fibers].reverse()) await fiber.dispose();
        active = false;
      },
    },
  };
}
