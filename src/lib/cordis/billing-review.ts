import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isRunGenerationFatal,
  runGenerationFor,
  type RunGenerationOutput,
} from "@/lib/billing/generate";
import {
  FixtureMeteringProvider,
  MeteringRegistry,
  type FixtureReading,
  type MeteringProviderName,
} from "@/lib/metering";
import { openOrganizationScope } from "@/lib/runtime/scope";
import "@/lib/runtime/services";
import { resolveReviewOnlySeedReadings } from "./review-seeds";

declare module "cordis" {
  interface Context {
    meteringRegistry?: MeteringRegistry;
    billingReview?: BillingReviewCapability;
  }
}

export const BILLING_REVIEW_PLUGIN_NAME = "billing-review";

export type BillingReviewProvider = MeteringProviderName;

export type BillingReviewRequest = {
  periodId: string;
  householdIds?: string[];
  provider: BillingReviewProvider;
};

export type BillingReviewCompositionOptions = {
  /** User-scoped client; never a service-role client. */
  supabase: SupabaseClient;
  /** The organization that owns the reviewed period (resolved by the route). */
  organizationId: string;
  /**
   * The reviewer. Review access is the MGM reviewer allowlist; the period
   * itself is still read through RLS, so the reviewer must also be able to
   * see it (super_admin or org_manager of its organization).
   */
  userId?: string | null;
  /** Fixture registration is opt-in and only used by tests/demos. */
  fixtureReadings?: readonly FixtureReading[];
};

/**
 * The application capability invoked by the review route. It exposes only the
 * no-write billing preview and receives a provider selected by its caller.
 */
export class BillingReviewCapability {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly registry: MeteringRegistry
  ) {}

  async preview(request: BillingReviewRequest): Promise<RunGenerationOutput> {
    let seedReadings;
    try {
      seedReadings = await resolveReviewOnlySeedReadings(
        this.supabase,
        request.periodId,
        request.householdIds
      );
    } catch {
      return {
        kind: "fatal",
        status: 500,
        body: {
          error: "Unable to resolve imported starting registers for review",
          code: "METERING_UNAVAILABLE",
        },
      };
    }
    let meteringProvider;
    try {
      meteringProvider = this.registry.resolve(request.provider);
    } catch {
      return {
        kind: "fatal",
        status: 503,
        body: { error: "Metering provider is not available", code: "METERING_CONFIGURATION" },
      };
    }
    return runGenerationFor({
      supabase: this.supabase,
      periodId: request.periodId,
      householdIds: request.householdIds,
      mode: "preview",
      actorUserId: null,
      seedReadings,
      meteringProvider,
      requireEffectiveDatedAssignments: true,
    });
  }
}

export type BillingReviewComposition = {
  billingReview: BillingReviewCapability;
  dispose(): Promise<void>;
};

type BillingReviewPluginConfig = { fixtureReadings?: readonly FixtureReading[] };

/**
 * The review capability plugin. It is intentionally narrow: the only exposed
 * operation is `preview`, whose generation mode cannot write billing records.
 * Metering sources come from the root registry; fixture registration is
 * opt-in per request and absent from the production route.
 */
export const BillingReviewPlugin = {
  name: BILLING_REVIEW_PLUGIN_NAME,
  inject: ["mgmRequest", "meteringProviders"],
  apply(ctx: Context, config: BillingReviewPluginConfig) {
    const request = ctx.mgmRequest;
    const registry = new MeteringRegistry();
    for (const name of ctx.meteringProviders.names()) {
      registry.register(name, ctx.meteringProviders.create(name, request.supabase));
    }
    if (config.fixtureReadings) {
      registry.register("fixture", new FixtureMeteringProvider(config.fixtureReadings));
    }
    ctx.provide("meteringRegistry", registry);
    ctx.provide("billingReview", new BillingReviewCapability(request.supabase, registry));
    // Clearing the narrow registry on unload ensures a capability retained
    // accidentally by application code cannot resolve a provider after its
    // request has ended.
    ctx.effect(() => () => registry.clear());
  },
} satisfies Plugin.Object<BillingReviewPluginConfig>;

/**
 * Compose the review capability for one request on the MGM runtime. The
 * caller must dispose the returned composition in `finally`; no client or
 * credential is retained across requests.
 */
export async function composeBillingReview(
  options: BillingReviewCompositionOptions
): Promise<BillingReviewComposition> {
  const scope = await openOrganizationScope({
    organizationId: options.organizationId,
    userId: options.userId ?? null,
    // The review capability reads only through RLS and never consults roles.
    roles: [],
    supabase: options.supabase,
  });
  try {
    await scope.load(BillingReviewPlugin, { fixtureReadings: options.fixtureReadings });
    const billingReview = scope.ctx.get("billingReview");
    if (!billingReview) throw new Error("Cordis billing-review capability did not register");
    return { billingReview, dispose: () => scope.dispose() };
  } catch (error) {
    await scope.dispose();
    throw error;
  }
}

export { isRunGenerationFatal };
