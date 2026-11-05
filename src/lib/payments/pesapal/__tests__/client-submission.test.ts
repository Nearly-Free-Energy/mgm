/**
 * PesapalClient request timeouts and checkout-submission classification.
 *
 * Pins behavior:
 *   - Every request carries an AbortSignal, so a hung request fails inside
 *     the route's time limit instead of outliving the function.
 *   - Failures of any request other than the order request are
 *     `not_submitted`: they cannot have created an order.
 *   - Order-request failures are `not_submitted` only when the connection
 *     never opened or Pesapal answered 4xx; a timeout, a dropped connection,
 *     a 5xx or an unreadable body are `unknown`.
 *   - The default timeout leaves room for two requests inside the pay
 *     route's `maxDuration`, and the unpayable-attempt window outlasts it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PESAPAL_REQUEST_TIMEOUT_MS, PesapalClient } from "../client";
import { PesapalError } from "../errors";
import { UNPAYABLE_ATTEMPT_WINDOW_MS } from "../../reconciliation";

const BASE_URL = "https://pay.pesapal.example.test/v3";

function makeClient(timeoutMs = 20): PesapalClient {
  return new PesapalClient({
    consumerKey: "ck",
    consumerSecret: "cs_long_enough",
    baseUrl: BASE_URL,
    timeoutMs,
  });
}

function order(client: PesapalClient) {
  return client.submitOrder({
    token: "fake-token",
    id: "MGM-ref",
    amount: 5000,
    description: "Utility bill",
    callbackUrl: "https://app.example.test/payment/callback",
    notificationId: "ipn-1",
    billingAddress: { email_address: "customer@example.test" },
  });
}

/** A fetch that never answers until its signal aborts. */
function hang(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

function networkError(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

async function caught(promise: Promise<unknown>): Promise<PesapalError> {
  const err = await promise.then(
    () => { throw new Error("expected a rejection"); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PesapalError);
  return err as PesapalError;
}

describe("PesapalClient timeouts and submission classification", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("passes an AbortSignal on every request", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ token: "t" }));
    await makeClient().getAccessToken();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("times out a hung token request as not submitted", async () => {
    fetchSpy.mockImplementationOnce(hang);
    const err = await caught(makeClient().getAccessToken());
    expect(err.code).toBe("PESAPAL_UNREACHABLE");
    expect(err.message).toContain("timed out after 20 ms");
    expect(err.submission).toBe("not_submitted");
  });

  it("times out a hung order request as unknown", async () => {
    fetchSpy.mockImplementationOnce(hang);
    const err = await caught(order(makeClient()));
    expect(err.code).toBe("PESAPAL_UNREACHABLE");
    expect(err.submission).toBe("unknown");
  });

  it("reports a token response without a token as not submitted", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ message: "invalid consumer" }));
    const err = await caught(makeClient().getAccessToken());
    expect(err.code).toBe("PESAPAL_AUTH_FAILED");
    expect(err.submission).toBe("not_submitted");
  });

  it("reports a rejected token request as not submitted", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const err = await caught(makeClient().getAccessToken());
    expect(err.submission).toBe("not_submitted");
  });

  it.each(["ENOTFOUND", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])(
    "reports an order request whose connection never opened (%s) as not submitted",
    async (code) => {
      fetchSpy.mockRejectedValueOnce(networkError(code));
      const err = await caught(order(makeClient()));
      expect(err.code).toBe("PESAPAL_UNREACHABLE");
      expect(err.submission).toBe("not_submitted");
    },
  );

  it("reports an order request whose connection dropped as unknown", async () => {
    fetchSpy.mockRejectedValueOnce(networkError("ECONNRESET"));
    const err = await caught(order(makeClient()));
    expect(err.submission).toBe("unknown");
  });

  it("reports a 4xx answer to the order request as not submitted", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const err = await caught(order(makeClient()));
    expect(err.code).toBe("PESAPAL_HTTP_ERROR");
    expect(err.submission).toBe("not_submitted");
  });

  it("reports a 5xx answer to the order request as unknown", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("gateway timeout", { status: 504 }));
    const err = await caught(order(makeClient()));
    expect(err.submission).toBe("unknown");
  });

  it("reports an unreadable order response as unknown", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    const err = await caught(order(makeClient()));
    expect(err.code).toBe("PESAPAL_HTTP_ERROR");
    expect(err.submission).toBe("unknown");
  });

  it("sizes the default timeout and the unpayable-attempt window against the pay route's maxDuration", () => {
    const route = readFileSync(
      path.resolve(__dirname, "../../../../app/api/billing-line-items/[lineItemId]/pay/route.ts"),
      "utf8",
    );
    const match = /export const maxDuration = (\d+);/.exec(route);
    expect(match, "the pay route must declare maxDuration").not.toBeNull();
    const limitMs = Number(match![1]) * 1000;
    // Token and order requests run in sequence, plus database round trips.
    expect(2 * PESAPAL_REQUEST_TIMEOUT_MS).toBeLessThan(limitMs);
    expect(UNPAYABLE_ATTEMPT_WINDOW_MS).toBeGreaterThan(limitMs * 10);
  });
});
