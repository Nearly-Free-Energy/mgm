/**
 * Pesapal provider plugin — registers the Pesapal implementation into the
 * root `paymentProviderRegistry` (docs/cordis-runtime.md).
 *
 * Credentials, API types and status mappings stay inside this directory
 * (enforced by payments-import-boundary.test.ts). A second payment provider
 * is one more plugin shaped like this one.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import type { MerchantAccountSecret, ProviderFactory } from "../../repository";
import { PesapalPaymentProvider, baseUrlForSandbox } from "./provider";

export const PESAPAL_PROVIDER = "pesapal";

export const pesapalProviderFactory: ProviderFactory = {
  async forAccount(account: MerchantAccountSecret) {
    if (account.provider !== PESAPAL_PROVIDER) {
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

export const PesapalProviderPlugin = {
  name: "pesapal",
  inject: ["paymentProviderRegistry"],
  apply(ctx: Context) {
    // Registration is undone when this fiber unloads.
    ctx.effect(() =>
      ctx.paymentProviderRegistry.register(PESAPAL_PROVIDER, pesapalProviderFactory)
    );
  },
} satisfies Plugin.Object<void>;
