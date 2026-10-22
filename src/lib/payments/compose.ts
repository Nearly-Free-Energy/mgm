/**
 * composePayments — the Payments capability for one organization-scoped
 * request on the MGM Cordis runtime (docs/cordis-runtime.md).
 *
 * The caller selects no provider and supplies no credentials. Payment
 * providers live in the root `paymentProviderRegistry`; the Pesapal plugin
 * (`providers/pesapal/plugin.ts`) registers there. The capability dispatches
 * by merchant-account provider. The caller disposes in `finally`.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { appUrl } from "@/lib/config/app-url";
import {
  PAYMENTS_PLUGIN_VERSION,
  PESAPAL_PLUGIN_VERSION,
} from "@/lib/plugins/bundled";
import { authorizeOrganization, openOrganizationScope } from "@/lib/runtime/scope";
import "@/lib/runtime/services";
import { PaymentsCapability } from "./capability";
import { createSupabasePaymentsRepository } from "./infrastructure/supabase-repository";
import "./scope";
import {
  paymentsFailure,
  type PaymentsCapabilityContract,
  type PaymentsRepository,
  type PaymentsResult,
  type PaymentsScope,
  type ProviderFactory,
} from "./repository";

export type PaymentsComposition = {
  scope: PaymentsScope;
  payments: PaymentsCapabilityContract;
  dispose(): Promise<void>;
};

export type { PaymentsResult } from "./repository";

export const PAYMENTS_PLUGIN_NAME = "payments";
export const PESAPAL_PROVIDER_PLUGIN_NAME = "pesapal";
export { PAYMENTS_PLUGIN_VERSION, PESAPAL_PLUGIN_VERSION };

/**
 * Absolute application URL for payment links and the provider return URL,
 * from the server-only MGM_APP_URL (#46). See src/lib/config/app-url.ts.
 */
export function defaultAppUrl(path: string): string {
  return appUrl(path);
}

export type PaymentsPluginConfig = { repository: PaymentsRepository };

/** The Payments capability plugin, loaded per request. */
export const PaymentsPlugin = {
  name: PAYMENTS_PLUGIN_NAME,
  inject: ["mgmRequest", "paymentProviderRegistry"],
  apply(ctx: Context, config: PaymentsPluginConfig) {
    const request = ctx.mgmRequest;
    const scope: PaymentsScope = {
      organizationId: request.organizationId,
      userId: request.userId,
      roles: request.roles,
    };
    const registry = ctx.paymentProviderRegistry;
    let active = true;
    const providers: ProviderFactory = {
      forAccount: (account) => {
        if (!active) throw new Error("Payment provider plugin unavailable");
        return registry.forAccount(account);
      },
    };
    const capability = new PaymentsCapability(
      config.repository,
      scope,
      providers,
      () => active,
      defaultAppUrl
    );
    ctx.provide("paymentProviders", providers);
    ctx.provide("paymentsScope", scope);
    ctx.provide("payments", capability);
    ctx.effect(() => () => {
      active = false;
    });
  },
} satisfies Plugin.Object<PaymentsPluginConfig>;

async function loadPayments(input: {
  request: PaymentsScope & { supabase: SupabaseClient };
  repository: PaymentsRepository;
}): Promise<PaymentsResult<PaymentsComposition>> {
  let requestScope: Awaited<ReturnType<typeof openOrganizationScope>> | null = null;
  try {
    requestScope = await openOrganizationScope(input.request);
    await requestScope.load(PaymentsPlugin, { repository: input.repository });
    const payments = requestScope.ctx.get("payments");
    const scope = requestScope.ctx.get("paymentsScope");
    if (!payments || !scope) {
      throw new Error("Payments capability did not register");
    }
    const opened = requestScope;
    return { ok: true, data: { scope, payments, dispose: () => opened.dispose() } };
  } catch (error) {
    await requestScope?.dispose();
    return paymentsFailure({
      status: 500,
      code: "payments_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose payments: ${error.message}`
          : "Could not compose payments.",
    });
  }
}

export async function composePayments(options: {
  supabase: SupabaseClient;
  organizationId: string;
  /**
   * Reads (history, readiness) stay available while Payments is disabled;
   * new checkouts are gated inside the capability so the error shape stays
   * checkout-specific. Kept for call-site compatibility.
   */
  allowDisabled?: boolean;
}): Promise<PaymentsResult<PaymentsComposition>> {
  const access = await authorizeOrganization(options.supabase, options.organizationId);
  if (!access.ok) {
    if (access.reason === "invalid_org") {
      return paymentsFailure({
        status: 400,
        code: "payments_invalid_org",
        message: "Invalid organization id — expected UUID.",
        field: "org_id",
      });
    }
    if (access.reason === "unauthenticated") {
      return paymentsFailure({
        status: 401,
        code: "payments_unauthenticated",
        message: "Authentication required.",
      });
    }
    return paymentsFailure({
      status: 403,
      code: "payments_forbidden",
      message: "Not authorized to act on this organization.",
    });
  }

  return loadPayments({
    request: {
      organizationId: options.organizationId,
      userId: access.user.id,
      roles: access.roles,
      supabase: options.supabase,
    },
    repository: createSupabasePaymentsRepository(options.supabase, createServiceClient()),
  });
}

/**
 * Public (unauthenticated) composition for the webhook and the stable
 * customer redirect. No user session; scope userId is null so write paths
 * that require a manager (reconcile) stay closed. RLS is bypassed by the
 * service-role client by design — the line-item id / merchant reference is
 * the bearer token, and verification is always server-side.
 */
export async function composePaymentsPublic(options: {
  supabase: SupabaseClient;
  organizationId: string;
}): Promise<PaymentsResult<PaymentsComposition>> {
  return loadPayments({
    request: {
      organizationId: options.organizationId,
      userId: null,
      roles: [],
      supabase: options.supabase,
    },
    repository: createSupabasePaymentsRepository(options.supabase),
  });
}
