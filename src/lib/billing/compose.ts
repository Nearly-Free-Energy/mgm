/**
 * composeBilling — the billing capability for one authenticated,
 * organization-scoped request on the MGM Cordis runtime (issue #5,
 * docs/cordis-runtime.md).
 *
 * The caller selects no provider and supplies no credentials. The billing
 * plugin injects the root `meteringProviders` registry and binds the OpenEMS
 * source to the caller's client — billing never constructs a vendor client
 * itself. The caller disposes the composition in `finally`.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BILLING_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { authorizeOrganization, openOrganizationScope } from "@/lib/runtime/scope";
import "@/lib/runtime/services";
import { BillingCapability } from "./capability";
import { createSupabaseBillingRepository } from "./infrastructure/supabase-repository";
import { isRunGenerationFatal, runGenerationFor } from "./generate";
import "./scope";
import {
  billingFailure,
  type BillingCapabilityContract,
  type BillingGeneration,
  type BillingRepository,
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

export type BillingPluginConfig = { repository: BillingRepository };

/** The billing capability plugin, loaded per request. */
export const BillingPlugin = {
  name: BILLING_PLUGIN_NAME,
  inject: ["mgmRequest", "meteringProviders"],
  apply(ctx: Context, config: BillingPluginConfig) {
    const request = ctx.mgmRequest;
    if (!request.userId) throw new Error("Billing requires an authenticated user");
    const scope: BillingScope = {
      organizationId: request.organizationId,
      userId: request.userId,
      roles: request.roles,
    };
    const meteringProviders = ctx.meteringProviders;
    let active = true;
    // The bill engine stays behind the generation delegate: the capability
    // validates scope and plugin state, then delegates. The metering source
    // is resolved from the root registry once per generation run.
    const generation: BillingGeneration = {
      async run(input) {
        const out = await runGenerationFor({
          supabase: request.supabase,
          periodId: input.periodId,
          householdIds: input.householdIds,
          manualReadings: input.manualReadings,
          seedReadings: input.seedReadings,
          mode: input.mode,
          actorUserId: input.actorUserId,
          meteringProvider: meteringProviders.forRequest(request.supabase),
          requireEffectiveDatedAssignments: true,
          allowUsageOnlyReadings: true,
        });
        if (isRunGenerationFatal(out)) return out;
        return { results: out.results };
      },
    };
    const capability = new BillingCapability(
      config.repository,
      scope,
      generation,
      () => active
    );
    ctx.provide("billingScope", scope);
    ctx.provide("billing", capability);
    ctx.effect(() => () => {
      active = false;
    });
  },
} satisfies Plugin.Object<BillingPluginConfig>;

export async function composeBilling(options: {
  supabase: SupabaseClient;
  organizationId: string;
  /**
   * Skip the plugin check. Only for callers that gate the request themselves
   * (`checkGate`/`gateRoute`); `route-surface.test.ts` does not count a call
   * with this set as gating, so the route must. If that test stops reading
   * this option, revisit.
   */
  readOnly?: boolean;
}): Promise<BillingResult<BillingComposition>> {
  const access = await authorizeOrganization(options.supabase, options.organizationId);
  if (!access.ok) {
    if (access.reason === "invalid_org") {
      return billingFailure({
        status: 400,
        code: "billing_invalid_org",
        message: "Invalid organization id — expected UUID.",
        field: "org_id",
      });
    }
    if (access.reason === "unauthenticated") {
      return billingFailure({
        status: 401,
        code: "billing_unauthenticated",
        message: "Authentication required.",
      });
    }
    return billingFailure({
      status: 403,
      code: "billing_forbidden",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    });
  }

  const repository = createSupabaseBillingRepository(options.supabase);
  if (!options.readOnly) {
    // Read through `isPluginEnabledForOrg`, as `MgmGate.check` does, not
    // `isBillingEnabled`: supabase-js resolves a failed read as `{ error }`
    // rather than rejecting, which that helper reads as disabled (409) and
    // this call throws on. So an unreadable state fails closed with the
    // gate's 503 code and copy, before any scope opens. Each write re-checks
    // with the same codes and copy (`requirePlugin` in capability.ts). If the
    // gate's read, code or copy changes, change them here and there too.
    let enabled: boolean;
    try {
      enabled = await isPluginEnabledForOrg(
        options.supabase,
        options.organizationId,
        BILLING_PLUGIN_NAME
      );
    } catch {
      return billingFailure({
        status: 503,
        code: "billing_gate_unavailable",
        message: "Could not verify whether Billing is enabled. Retry the request.",
      });
    }
    if (!enabled) {
      return billingFailure({
        status: 409,
        code: "billing_disabled",
        message:
          "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.",
      });
    }
  }

  let requestScope: Awaited<ReturnType<typeof openOrganizationScope>> | null = null;
  try {
    requestScope = await openOrganizationScope({
      organizationId: options.organizationId,
      userId: access.user.id,
      roles: access.roles,
      supabase: options.supabase,
    });
    await requestScope.load(BillingPlugin, { repository });
    const billing = requestScope.ctx.get("billing");
    const scope = requestScope.ctx.get("billingScope");
    if (!billing || !scope) {
      throw new Error("Billing capability did not register");
    }
    const opened = requestScope;
    return {
      ok: true,
      data: { scope, billing, dispose: () => opened.dispose() },
    };
  } catch (error) {
    await requestScope?.dispose();
    return billingFailure({
      status: 500,
      code: "billing_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose billing: ${error.message}`
          : "Could not compose billing.",
    });
  }
}
