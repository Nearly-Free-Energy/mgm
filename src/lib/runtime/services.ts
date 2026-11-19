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
import type { MgmSurface } from "@/lib/gui/surface";
import type { MeteringProvider } from "@/lib/metering/types";
import { MeteringError } from "@/lib/metering/errors";
import type { MeteringProviderName } from "@/lib/metering/registry";
import type { ProviderFactory } from "@/lib/payments/repository";
import type { MailSenderSettings, MailTransport, MailTransportFactory } from "@/lib/email/types";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { MgmGate } from "./gate";

/**
 * The caller and organization one request acts for. The community
 * management, metering, billing and payments capability plugins take
 * `organizationId` and `roles` as access their composer has already
 * authorized with authorizeOrganization; billing-review gets no roles and
 * reads only through RLS (composeBillingReview). In a tenant-app scope
 * (composeTenantApp) they are not organization access: the organization is
 * only the tenant's unit's, and the roles only the tenant's rows, so
 * nothing else is loaded there (openOrganizationScope).
 */
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
export type MeteringProviderSelection = {
  /** Provider-owned lookup of configuration; no vendor knowledge in consumers. */
  supports?: (supabase: SupabaseClient, microgridId: string) => Promise<boolean>;
  /** Compatibility source for existing microgrids without a provider selection. */
  fallback?: boolean;
};

export class MeteringProviderFactories {
  private readonly factories = new Map<MeteringProviderName, {
    factory: MeteringProviderFactory; selection: MeteringProviderSelection;
  }>();

  register(name: MeteringProviderName, factory: MeteringProviderFactory,
    selection: MeteringProviderSelection = {}): () => void {
    if (this.factories.has(name)) throw new Error(`Metering provider "${name}" is already registered`);
    const entry = { factory, selection };
    this.factories.set(name, entry);
    return () => { if (this.factories.get(name) === entry) this.factories.delete(name); };
  }

  has(name: MeteringProviderName): boolean { return this.factories.has(name); }
  names(): MeteringProviderName[] { return [...this.factories.keys()]; }

  create(name: MeteringProviderName, supabase: SupabaseClient): MeteringProvider {
    const entry = this.factories.get(name);
    if (!entry) throw new Error(`Metering provider "${name}" is not registered`);
    return entry.factory(supabase);
  }

  /**
   * The one provider for this microgrid: a provider whose `supports` matches
   * comes ahead of a fallback. None or several → MeteringError 503; an error
   * a selector throws (a MeteringError such as the synthetic mixed-edge 409,
   * or a failed lookup) passes through, so selection never falls back silently.
   */
  async select(supabase: SupabaseClient, microgridId: string): Promise<MeteringProviderName> {
    const matches: MeteringProviderName[] = [];
    const fallbacks: MeteringProviderName[] = [];
    for (const [name, { selection }] of this.factories) {
      if (selection.supports && !await selection.supports(supabase, microgridId)) continue;
      (selection.fallback ? fallbacks : matches).push(name);
    }
    const selected = matches.length ? matches : fallbacks;
    if (selected.length !== 1) {
      throw new MeteringError(selected.length ? "Ambiguous metering provider configuration" : "No metering provider configured", "METERING_CONFIGURATION", 503, { microgridId });
    }
    return selected[0];
  }

  /** Bind routing to the caller, resolving each microgrid through provider plugins. */
  forRequest(supabase: SupabaseClient): MeteringProvider {
    return { getReadings: async (request) =>
      this.create(await this.select(supabase, request.microgridId), supabase).getReadings(request) };
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

/**
 * Root registry of mail transports, keyed by the settings' `kind` (RFC #186).
 * A transport is built per send from settings the caller has already
 * authorized and decrypted; the registry holds factories only.
 */
export class MailTransportRegistry {
  private readonly factories = new Map<MailSenderSettings["kind"], MailTransportFactory>();

  register(kind: MailSenderSettings["kind"], factory: MailTransportFactory): () => void {
    if (this.factories.has(kind)) {
      throw new Error(`Mail transport "${kind}" is already registered`);
    }
    this.factories.set(kind, factory);
    return () => {
      if (this.factories.get(kind) === factory) this.factories.delete(kind);
    };
  }

  has(kind: MailSenderSettings["kind"]): boolean {
    return this.factories.has(kind);
  }

  create(settings: MailSenderSettings): MailTransport {
    const factory = this.factories.get(settings.kind);
    if (!factory) throw new Error(`Mail transport "${settings.kind}" is not registered`);
    return factory(settings);
  }
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
    /** The write side only; the host reads through MgmRuntime.mgmSurface. */
    mgmSurface: MgmSurface;
    meteringProviders: MeteringProviderFactories;
    paymentProviderRegistry: PaymentProviderRegistry;
    mailTransports: MailTransportRegistry;
    mgmRequest: MgmRequest;
  }
}

export type CordisContext = Context;
