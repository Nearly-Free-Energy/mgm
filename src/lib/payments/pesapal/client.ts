import { PesapalError } from "./errors";
import type { CheckoutSubmission } from "../providers/types";
import type {
  AuthTokenResponse,
  GetTransactionStatusResponse,
  IpnEntry,
  RegisterIpnResponse,
  SubmitOrderParams,
  SubmitOrderResponse,
} from "./types";

/** Pesapal supports POST or GET for IPN delivery. We default to POST. */
export type IpnNotificationType = "POST" | "GET";

/**
 * Pesapal client (stateless).
 *
 * Adapted from PR #58's `src/lib/pesapal/client.ts`. The major change vs. PR
 * #58: the client no longer reads `process.env.PESAPAL_*`. All credentials
 * (consumer_key, consumer_secret) and the base URL are injected via the
 * constructor. Callers resolve config from the organization's merchant
 * account (`payment_merchant_accounts`, secret via the service-role-only
 * `fn_get_payment_merchant_secret`) — there is no global fallback.
 */
export interface PesapalClientConfig {
  consumerKey: string;
  consumerSecret: string;
  baseUrl: string;
  /** Per-request limit; defaults to `PESAPAL_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Per-request time limit. A checkout makes two requests in sequence (token,
 * then order), so both must fit inside the pay route's `maxDuration` of 30 s
 * (src/app/api/billing-line-items/[lineItemId]/pay/route.ts) for a hung
 * request to fail here rather than outlive the function and leave its
 * attempt open. If that limit drops below twice this value, lower this.
 */
export const PESAPAL_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Connection failures that happen before any request byte is sent, read from
 * the `code` Node's fetch puts on the error's `cause`.
 */
const PRE_SEND_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function causeCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export class PesapalClient {
  private readonly timeoutMs: number;

  constructor(private readonly config: PesapalClientConfig) {
    if (
      !config.consumerKey ||
      !config.consumerSecret ||
      !config.baseUrl ||
      !config.baseUrl.trim()
    ) {
      throw new PesapalError(
        "Pesapal config missing consumer_key / consumer_secret / base_url",
        "PESAPAL_INVALID_CONFIG",
        503,
      );
    }
    this.timeoutMs = config.timeoutMs ?? PESAPAL_REQUEST_TIMEOUT_MS;
  }

  /**
   * Thin JSON fetch wrapper that surfaces non-2xx responses as PesapalErrors
   * with the upstream body attached for debugging. Network failures and
   * timeouts surface as PESAPAL_UNREACHABLE; non-2xx responses as the
   * caller-supplied errorCode.
   *
   * Every error says whether the request could have created an order
   * (`submission`). Only the order request can; for it, a connection that
   * never opened or a 4xx answer means no order, while a timeout, a dropped
   * connection, a 5xx or an unreadable body leave the outcome unknown.
   */
  private async pesapalFetch<T>(
    path: string,
    init: RequestInit,
    errorCode: string,
    orderRequest = false,
  ): Promise<T> {
    const submission = (mayHaveArrived: boolean): CheckoutSubmission =>
      orderRequest && mayHaveArrived ? "unknown" : "not_submitted";
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const timedOut = isTimeout(cause);
      const code = causeCode(cause);
      throw new PesapalError(
        timedOut
          ? `Pesapal ${path} timed out after ${this.timeoutMs} ms`
          : `Pesapal request failed: ${String(cause)}`,
        "PESAPAL_UNREACHABLE",
        503,
        cause,
        submission(timedOut || code === undefined || !PRE_SEND_ERROR_CODES.has(code)),
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new PesapalError(
        `Pesapal ${path} returned ${res.status}: ${body.slice(0, 500)}`,
        errorCode,
        502,
        { status: res.status, body },
        submission(res.status >= 500),
      );
    }
    try {
      return (await res.json()) as T;
    } catch (cause) {
      const timedOut = isTimeout(cause);
      throw new PesapalError(
        timedOut
          ? `Pesapal ${path} timed out after ${this.timeoutMs} ms`
          : `Pesapal ${path} returned an unreadable body`,
        timedOut ? "PESAPAL_UNREACHABLE" : errorCode,
        502,
        cause,
        submission(true),
      );
    }
  }

  /** Step 1: Request access token. */
  async getAccessToken(): Promise<string> {
    const data = await this.pesapalFetch<AuthTokenResponse>(
      "/api/Auth/RequestToken",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          consumer_key: this.config.consumerKey,
          consumer_secret: this.config.consumerSecret,
        }),
      },
      "PESAPAL_AUTH_FAILED",
    );

    if (!data?.token) {
      throw new PesapalError(
        `Pesapal auth returned no token: ${data?.message ?? JSON.stringify(data)}`,
        "PESAPAL_AUTH_FAILED",
        401,
        data,
        "not_submitted",
      );
    }
    return data.token;
  }

  /** Step 2: Get all registered IPN URLs. */
  async getAllIpn(token: string): Promise<IpnEntry[]> {
    return this.pesapalFetch<IpnEntry[]>(
      "/api/URLSetup/GetIpnList",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      "PESAPAL_HTTP_ERROR",
    );
  }

  /**
   * Register an IPN URL with Pesapal and return the canonical record (incl.
   * `ipn_id`). Called by the Save & test flow (#121) so subsequent
   * `submitOrder` calls can pass `notification_id`.
   *
   * Pesapal returns 200 with `{ ipn_id: "<GUID>", ... }` on success. Any 2xx
   * payload missing `ipn_id` surfaces as `PESAPAL_REGISTER_IPN_FAILED`.
   * Non-2xx and network failures surface via `pesapalFetch` as
   * `PESAPAL_REGISTER_IPN_FAILED` and `PESAPAL_UNREACHABLE` respectively.
   */
  async registerIpn(
    token: string,
    url: string,
    type: IpnNotificationType = "POST",
  ): Promise<RegisterIpnResponse> {
    const data = await this.pesapalFetch<RegisterIpnResponse>(
      "/api/URLSetup/RegisterIPN",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          url,
          ipn_notification_type: type,
        }),
      },
      "PESAPAL_REGISTER_IPN_FAILED",
    );

    if (!data.ipn_id || !String(data.ipn_id).trim()) {
      throw new PesapalError(
        `Pesapal RegisterIPN returned no ipn_id: ${JSON.stringify(data).slice(0, 500)}`,
        "PESAPAL_REGISTER_IPN_FAILED",
        502,
        data,
      );
    }
    return data;
  }

  /**
   * Phase B: server-to-server verify of a pending order.
   *
   * Called by `/api/payments/ipn` to authoritatively resolve the payment
   * status of an OrderTrackingId — Pesapal's webhook body is untrusted, so the
   * webhook receiver re-fetches state via this endpoint before mutating any
   * local state.
   *
   * Endpoint: GET /api/Transactions/GetTransactionStatus?orderTrackingId={id}
   * with `Authorization: Bearer <token>`. The response includes the canonical
   * `payment_status_description` (COMPLETED / FAILED / REVERSED / PENDING /
   * INVALID).
   *
   * Errors:
   *   - non-2xx → PESAPAL_HTTP_ERROR (502)
   *   - network failure → PESAPAL_UNREACHABLE (503)
   * Other downstream values (PENDING / INVALID / unknown) are NOT treated as
   * errors here — they're returned to the caller, which decides the policy
   * (the IPN route maps them to no-op).
   */
  async getTransactionStatus(
    token: string,
    orderTrackingId: string,
  ): Promise<GetTransactionStatusResponse> {
    if (!orderTrackingId || !orderTrackingId.trim()) {
      throw new PesapalError(
        "getTransactionStatus called without orderTrackingId",
        "PESAPAL_HTTP_ERROR",
        400,
      );
    }
    const path = `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(
      orderTrackingId,
    )}`;
    return this.pesapalFetch<GetTransactionStatusResponse>(
      path,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      "PESAPAL_HTTP_ERROR",
    );
  }

  /** Step 3: Submit order request. */
  async submitOrder({
    token,
    id,
    amount,
    description,
    callbackUrl,
    notificationId,
    billingAddress,
    currency = "UGX",
  }: SubmitOrderParams): Promise<SubmitOrderResponse> {
    return this.pesapalFetch<SubmitOrderResponse>(
      "/api/Transactions/SubmitOrderRequest",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id,
          currency,
          amount,
          description,
          callback_url: callbackUrl,
          notification_id: notificationId,
          billing_address: billingAddress,
        }),
      },
      "PESAPAL_HTTP_ERROR",
      true,
    );
  }
}
