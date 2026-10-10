/**
 * composePayments — one authenticated, organization-scoped Cordis context
 * per caller for the Payments plugin.
 *
 * Mirrors the billing composition: the caller selects no provider and
 * supplies no credentials. Provider resolution (Pesapal implementation)
 * happens here, once per request, behind the provider-neutral factory.
 */
import "server-only";

import { Context, type Fiber } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { ORG_MANAGER, SCOPE_ORG, SUPER_ADMIN } from "@/lib/roles";
import {
  PAYMENTS_PLUGIN_VERSION,
  PESAPAL_PLUGIN_VERSION,
} from "@/lib/plugins/bundled";
import { PaymentsCapability } from "./capability";
import { createSupabasePaymentsRepository } from "./infrastructure/supabase-repository";
import { PesapalPaymentProvider, baseUrlForSandbox } from "./providers/pesapal/provider";
import "./scope";
import {
  paymentsFailure,
  type MerchantAccountSecret,
  type PaymentsCapabilityContract,
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

function paymentsScopePlugin(context: Context, scope: PaymentsScope) {
  return context.provide("paymentsScope", scope);
}

function paymentsCapabilityPlugin(
  context: Context,
  capability: PaymentsCapabilityContract
) {
  return context.provide("payments", capability);
}

function defaultAppUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  if (base) return `${base}${path}`;
  const callbackBase = (process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL ?? "").replace(/\/+$/, "");
  if (callbackBase) {
    try {
      const url = new URL(callbackBase);
      return `${url.origin}${path}`;
    } catch {
      return path;
    }
  }
  return path;
}

const providerFactory: ProviderFactory = {
  async forAccount(account: MerchantAccountSecret) {
    if (account.provider !== "pesapal") {
      return { ok: false, code: "payments_unknown_provider", message: `Unknown provider: ${account.provider}` };
    }
    if (!account.consumer_key || !account.base_url) {
      return {
        ok: false,
        code: "payments_invalid_config",
        message: "Merchant account is missing consumer key or base URL.",
      };
    }
    if (!account.ipn_id) {
      return {
        ok: false,
        code: "payments_ipn_not_registered",
        message:
          "Payment provider is configured but no IPN has been registered yet. Run Save & test connection to register the IPN URL.",
      };
    }
    try {
      return {
        ok: true,
        provider: new PesapalPaymentProvider({
          consumerKey: account.consumer_key,
          consumerSecret: account.secret,
          baseUrl: account.base_url || baseUrlForSandbox(account.sandbox),
          ipnId: account.ipn_id,
        }),
      };
    } catch (error) {
      return {
        ok: false,
        code: "payments_invalid_config",
        message: error instanceof Error ? error.message : "Invalid provider configuration.",
      };
    }
  },
};

export async function composePayments(options: {
  supabase: SupabaseClient;
  organizationId: string;
  allowDisabled?: boolean;
}): Promise<PaymentsResult<PaymentsComposition>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.organizationId)) {
    return paymentsFailure({
      status: 400,
      code: "payments_invalid_org",
      message: "Invalid organization id — expected UUID.",
      field: "org_id",
    });
  }

  const {
    data: { user },
  } = await options.supabase.auth.getUser();

  const roles = await getCurrentUserRoles(options.supabase);
  const canAccess =
    roles.some((role) => role.role === SUPER_ADMIN) ||
    roles.some(
      (role) =>
        role.role === ORG_MANAGER &&
        role.scope_type === SCOPE_ORG &&
        role.scope_id === options.organizationId
    );

  // Public callers (IPN webhook, /pay redirect) compose with a service-role
  // client and no user session: allow when user is null only if the caller
  // explicitly opts in via allowDisabled-style public path? No — public
  // routes use `composePaymentsPublic` below. This path requires auth.
  if (!user) {
    return paymentsFailure({
      status: 401,
      code: "payments_unauthenticated",
      message: "Authentication required.",
    });
  }
  if (!canAccess) {
    return paymentsFailure({
      status: 403,
      code: "payments_forbidden",
      message: "Not authorized to act on this organization.",
    });
  }

  const repository = createSupabasePaymentsRepository(options.supabase);
  if (
    !options.allowDisabled &&
    (!(await repository.isPaymentsEnabled(options.organizationId)) ||
      !(await repository.isPesapalEnabled(options.organizationId)))
  ) {
    // Reads (history, readiness) stay available — callers that need them pass
    // allowDisabled. New checkouts are gated in the capability instead so the
    // error shape stays checkout-specific.
  }

  const scope: PaymentsScope = {
    organizationId: options.organizationId,
    userId: user.id,
    roles,
  };
  const context = new Context();
  const fibers: Fiber[] = [];
  let active = true;
  const capability = new PaymentsCapability(
    repository,
    scope,
    providerFactory,
    () => active,
    defaultAppUrl
  );

  try {
    fibers.push(await context.plugin(paymentsScopePlugin, scope));
    fibers.push(await context.plugin(paymentsCapabilityPlugin, capability));
    if (!context.payments || !context.paymentsScope) {
      throw new Error("Payments capability did not register");
    }
  } catch (error) {
    active = false;
    await Promise.allSettled([...fibers].reverse().map((fiber) => fiber.dispose()));
    return paymentsFailure({
      status: 500,
      code: "payments_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose payments: ${error.message}`
          : "Could not compose payments.",
    });
  }

  return {
    ok: true,
    data: {
      scope,
      payments: capability,
      async dispose() {
        for (const fiber of [...fibers].reverse()) await fiber.dispose();
        active = false;
      },
    },
  };
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
  const repository = createSupabasePaymentsRepository(options.supabase);
  const scope: PaymentsScope = {
    organizationId: options.organizationId,
    userId: null,
    roles: [],
  };
  const context = new Context();
  const fibers: Fiber[] = [];
  let active = true;
  const capability = new PaymentsCapability(
    repository,
    scope,
    providerFactory,
    () => active,
    defaultAppUrl
  );
  try {
    fibers.push(await context.plugin(paymentsScopePlugin, scope));
    fibers.push(await context.plugin(paymentsCapabilityPlugin, capability));
    if (!context.payments || !context.paymentsScope) {
      throw new Error("Payments capability did not register");
    }
  } catch (error) {
    active = false;
    await Promise.allSettled([...fibers].reverse().map((fiber) => fiber.dispose()));
    return paymentsFailure({
      status: 500,
      code: "payments_composition_failed",
      message:
        error instanceof Error
          ? `Could not compose payments: ${error.message}`
          : "Could not compose payments.",
    });
  }
  return {
    ok: true,
    data: {
      scope,
      payments: capability,
      async dispose() {
        for (const fiber of [...fibers].reverse()) await fiber.dispose();
        active = false;
      },
    },
  };
}
