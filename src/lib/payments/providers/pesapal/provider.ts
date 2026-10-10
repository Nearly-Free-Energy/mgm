import "server-only";

import { PesapalClient } from "../../pesapal/client";
import { PesapalError } from "../../pesapal/errors";
import { mapPesapalStatus } from "./status-map";
import type {
  CheckoutRequest,
  CheckoutResult,
  ConnectionTestResult,
  NotificationEnvelope,
  PaymentProviderClient,
  TransactionSnapshot,
} from "../types";

export interface PesapalProviderConfig {
  consumerKey: string;
  consumerSecret: string;
  baseUrl: string;
  ipnId: string;
}

export const PESAPAL_BASE_URL_PROD = "https://pay.pesapal.com/v3";
export const PESAPAL_BASE_URL_SANDBOX =
  "https://cybqa.pesapal.com/pesapalv3";

export function baseUrlForSandbox(sandbox: boolean): string {
  return sandbox ? PESAPAL_BASE_URL_SANDBOX : PESAPAL_BASE_URL_PROD;
}

/**
 * Pesapal provider implementation. Owned by the Pesapal plugin; the Payments
 * capability consumes only the provider-neutral `PaymentProviderClient`
 * contract. Credentials, API types and status mappings stay in here.
 */
export class PesapalPaymentProvider implements PaymentProviderClient {
  readonly provider = "pesapal" as const;
  private readonly client: PesapalClient;
  private readonly ipnId: string;

  constructor(config: PesapalProviderConfig) {
    if (!config.ipnId || !config.ipnId.trim()) {
      throw new PesapalError(
        "Pesapal config missing ipn_id — register an IPN via Pesapal first",
        "PESAPAL_NO_IPN",
        400
      );
    }
    this.ipnId = config.ipnId;
    this.client = new PesapalClient({
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      baseUrl: config.baseUrl,
    });
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      await this.client.getAccessToken();
      return {
        ok: true,
        reason: "success",
        message: "Connected. Pesapal authentication succeeded.",
      };
    } catch (err) {
      if (err instanceof PesapalError) {
        if (err.code === "PESAPAL_AUTH_FAILED") {
          return {
            ok: false,
            reason: "auth_failed",
            message:
              "Authentication failed. Verify the consumer key and consumer secret on your Pesapal dashboard.",
          };
        }
        if (err.code === "PESAPAL_UNREACHABLE") {
          return {
            ok: false,
            reason: "unreachable",
            message: "Could not reach Pesapal. Check your network and try again.",
          };
        }
      }
      return {
        ok: false,
        reason: "unknown_error",
        message: "Pesapal returned an unexpected error. Check server logs.",
      };
    }
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    const token = await this.client.getAccessToken();
    const response = await this.client.submitOrder({
      token,
      id: request.merchantReference,
      amount: request.amount,
      description: request.description,
      callbackUrl: request.callbackUrl,
      notificationId: this.ipnId,
      billingAddress: {
        ...(request.contact.email
          ? { email_address: request.contact.email }
          : {}),
        ...(request.contact.phone
          ? { phone_number: request.contact.phone }
          : {}),
        ...(request.contact.firstName
          ? { first_name: request.contact.firstName }
          : {}),
        ...(request.contact.lastName
          ? { last_name: request.contact.lastName }
          : {}),
      },
      currency: request.currency,
    });
    if (!response.redirect_url) {
      throw new PesapalError(
        "Pesapal submitOrder did not return a redirect_url",
        "PESAPAL_NO_REDIRECT",
        502,
        response
      );
    }
    return {
      redirectUrl: response.redirect_url,
      providerTrackingId: response.order_tracking_id ?? "",
      merchantReference: response.merchant_reference ?? request.merchantReference,
    };
  }

  async getTransaction(trackingId: string): Promise<TransactionSnapshot> {
    if (!trackingId || !trackingId.trim()) {
      throw new PesapalError(
        "getTransaction called without tracking id",
        "PESAPAL_HTTP_ERROR",
        400
      );
    }
    const token = await this.client.getAccessToken();
    const res = await this.client.getTransactionStatus(token, trackingId);
    return {
      status: mapPesapalStatus(res.payment_status_description),
      amount: res.amount,
      currency: res.currency,
      paymentMethod: res.payment_method,
      confirmationCode: res.confirmation_code,
      merchantReference: res.merchant_reference,
      raw: res,
    };
  }

  parseNotification(raw: unknown): NotificationEnvelope | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const tracking =
      (typeof rec.OrderTrackingId === "string" && rec.OrderTrackingId) ||
      (typeof rec.orderTrackingId === "string" && rec.orderTrackingId) ||
      (typeof rec.OrderTrackingID === "string" && rec.OrderTrackingID) ||
      null;
    const merchant =
      (typeof rec.OrderMerchantReference === "string" &&
        rec.OrderMerchantReference) ||
      (typeof rec.merchantReference === "string" && rec.merchantReference) ||
      (typeof rec.MerchantReference === "string" && rec.MerchantReference) ||
      null;
    if (!tracking || !merchant) return null;
    return { trackingId: tracking, merchantReference: merchant, raw };
  }
}
