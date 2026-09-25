import "server-only";

import { Context, type Fiber } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isRunGenerationFatal,
  runGenerationFor,
  type RunGenerationOutput,
} from "@/lib/billing/generate";
import {
  createOpenEmsMeteringProvider,
  FixtureMeteringProvider,
  MeteringRegistry,
  type FixtureReading,
  type MeteringProviderName,
} from "@/lib/metering";
import { resolveReviewOnlySeedReadings } from "./review-seeds";

declare module "cordis" {
  interface Context {
    meteringRegistry?: MeteringRegistry;
    billingReview?: BillingReviewCapability;
  }
}

export type BillingReviewProvider = MeteringProviderName;

export type BillingReviewRequest = {
  periodId: string;
  householdIds?: string[];
  provider: BillingReviewProvider;
};

export type BillingReviewCompositionOptions = {
  /** User-scoped client; never a service-role client. */
  supabase: SupabaseClient;
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
    });
  }
}

export type BillingReviewComposition = {
  billingReview: BillingReviewCapability;
  dispose(): Promise<void>;
};

/**
 * Compose trusted first-party plugins for one request. The caller must dispose
 * the returned composition in `finally`; no context, client, or credential is
 * retained across Vercel requests.
 */
export async function composeBillingReview(
  options: BillingReviewCompositionOptions
): Promise<BillingReviewComposition> {
  const context = new Context();
  const registry = new MeteringRegistry();
  const fibers: Fiber[] = [];

  let billingReview: BillingReviewCapability;
  try {
    fibers.push(await context.plugin(meteringRegistryPlugin, registry));
    fibers.push(await context.plugin(openEmsProviderPlugin, {
      registry,
      supabase: options.supabase,
    }));
    if (options.fixtureReadings) {
      fibers.push(await context.plugin(fixtureProviderPlugin, {
        registry,
        readings: options.fixtureReadings,
      }));
    }
    fibers.push(
      await context.plugin(
        billingReviewPlugin,
        new BillingReviewCapability(options.supabase, registry)
      )
    );
    if (!context.billingReview) throw new Error("Cordis billing-review capability did not register");
    billingReview = context.billingReview;
  } catch (error) {
    await Promise.allSettled([...fibers].reverse().map((fiber) => fiber.dispose()));
    registry.clear();
    throw error;
  }

  return {
    billingReview,
    async dispose() {
      for (const fiber of [...fibers].reverse()) await fiber.dispose();
      // Cordis disposes plugin resources. Clearing the narrow registry as a
      // final guard ensures a capability retained accidentally by application
      // code cannot resolve a provider after its request has ended.
      registry.clear();
    },
  };
}

function meteringRegistryPlugin(context: Context, registry: MeteringRegistry) {
  context.provide("meteringRegistry", registry);
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

function billingReviewPlugin(context: Context, capability: BillingReviewCapability) {
  // The capability is intentionally narrow: the only exposed operation is
  // `preview`, whose generation mode cannot write billing records.
  context.provide("billingReview", capability);
}

export { isRunGenerationFatal };
