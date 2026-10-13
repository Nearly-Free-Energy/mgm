/**
 * Service declarations for the MGM Cordis runtime.
 *
 * Platform services live on the long-lived root context and hold no request
 * data. `mgmRequest` is provided once per request inside an isolated child
 * context (see `scope.ts`). Capability services (`metering`, `billing`, …)
 * keep their existing declarations next to their plugins.
 */
import "server-only";

import type { Context } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BundledPlugin, MgmPluginName } from "@/lib/plugins/bundled";
import type { MeteringProvider } from "@/lib/metering/types";
import type { MeteringProviderName } from "@/lib/metering/registry";
import type { ProviderFactory } from "@/lib/payments/repository";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { MgmGate } from "./gate";

/** The caller and organization one request acts for. */
export type MgmRequest = {
  organizationId: string;
  /** Null only for public payment surfaces (webhook, customer redirect). */
  userId: string | null;
  roles: UserRoleRecord[];
  /** The caller's RLS-scoped client (service-role only for public payments). */
  supabase: SupabaseClient;
};

export type MeteringProviderFactory = (supabase: SupabaseClient) => MeteringProvider;

/** Root registry of metering sources. Factories bind to a request's client. */
export class MeteringProviderFactories {
  private readonly factories = new Map<MeteringProviderName, MeteringProviderFactory>();

  register(name: MeteringProviderName, factory: MeteringProviderFactory): () => void {
    if (this.factories.has(name)) {
      throw new Error(`Metering provider "${name}" is already registered`);
    }
    this.factories.set(name, factory);
    return () => {
      if (this.factories.get(name) === factory) this.factories.delete(name);
    };
  }

  has(name: MeteringProviderName): boolean {
    return this.factories.has(name);
  }

  names(): MeteringProviderName[] {
    return [...this.factories.keys()];
  }

  create(name: MeteringProviderName, supabase: SupabaseClient): MeteringProvider {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Metering provider "${name}" is not registered`);
    return factory(supabase);
  }
}

/** Root registry of payment providers, keyed by merchant-account provider. */
export class PaymentProviderRegistry implements ProviderFactory {
  private readonly factories = new Map<string, ProviderFactory>();

  register(provider: string, factory: ProviderFactory): () => void {
    if (this.factories.has(provider)) {
      throw new Error(`Payment provider "${provider}" is already registered`);
    }
    this.factories.set(provider, factory);
    return () => {
      if (this.factories.get(provider) === factory) this.factories.delete(provider);
    };
  }

  has(provider: string): boolean {
    return this.factories.has(provider);
  }

  names(): string[] {
    return [...this.factories.keys()];
  }

  forAccount: ProviderFactory["forAccount"] = async (account) => {
    const factory = this.factories.get(account.provider);
    if (!factory) {
      return {
        ok: false,
        code: "payments_unknown_provider",
        message: `Unknown provider: ${account.provider}`,
      };
    }
    return factory.forAccount(account);
  };
}

export type MgmCatalog = {
  plugins: readonly BundledPlugin[];
  get(name: string): BundledPlugin | undefined;
  isCore(name: MgmPluginName): boolean;
};

declare module "cordis" {
  interface Context {
    mgmCatalog: MgmCatalog;
    mgmGate: MgmGate;
    meteringProviders: MeteringProviderFactories;
    paymentProviderRegistry: PaymentProviderRegistry;
    mgmRequest: MgmRequest;
  }
}

export type CordisContext = Context;
