/**
 * PesapalPaymentProvider.createCheckout failure classification.
 *
 * The capability fails an attempt only when the provider's error says no
 * order was created (`submission: "not_submitted"`); everything else keeps
 * the cautious confirmation-pending path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PesapalPaymentProvider } from "../providers/pesapal/provider";
import { PesapalError } from "../pesapal/errors";
import { checkoutWasNotSubmitted } from "../providers/types";

const REQUEST = {
  merchantReference: "MGM-ref",
  amount: 5000,
  currency: "UGX",
  description: "Utility bill",
  callbackUrl: "https://app.example.test/payment/callback",
  contact: { email: "customer@example.test", firstName: "Test", lastName: "Customer" },
};

function provider() {
  return new PesapalPaymentProvider({
    consumerKey: "ck",
    consumerSecret: "cs_long_enough",
    baseUrl: "https://pay.pesapal.example.test/v3",
    ipnId: "ipn-1",
  });
}

async function caught(promise: Promise<unknown>): Promise<PesapalError> {
  const err = await promise.then(
    () => { throw new Error("expected a rejection"); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PesapalError);
  return err as PesapalError;
}

describe("PesapalPaymentProvider.createCheckout failures", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("reports a failed token request as not submitted and never sends the order", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const err = await caught(provider().createCheckout(REQUEST));
    expect(err.code).toBe("PESAPAL_AUTH_FAILED");
    expect(checkoutWasNotSubmitted(err)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable token endpoint as not submitted", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    const err = await caught(provider().createCheckout(REQUEST));
    expect(err.code).toBe("PESAPAL_UNREACHABLE");
    expect(checkoutWasNotSubmitted(err)).toBe(true);
  });

  it("reports an error envelope without an order tracking ID as not submitted", async () => {
    fetchSpy
      .mockResolvedValueOnce(Response.json({ token: "t" }))
      .mockResolvedValueOnce(
        Response.json({ error: { code: "invalid_currency" }, status: "500", order_tracking_id: null, redirect_url: null }),
      );
    const err = await caught(provider().createCheckout(REQUEST));
    expect(err.code).toBe("PESAPAL_NO_REDIRECT");
    expect(checkoutWasNotSubmitted(err)).toBe(true);
  });

  it("keeps an answer that names an order but no redirect URL unknown", async () => {
    fetchSpy
      .mockResolvedValueOnce(Response.json({ token: "t" }))
      .mockResolvedValueOnce(Response.json({ order_tracking_id: "TRACK-1", merchant_reference: "MGM-ref" }));
    const err = await caught(provider().createCheckout(REQUEST));
    expect(err.code).toBe("PESAPAL_NO_REDIRECT");
    expect(err.submission).toBe("unknown");
    expect(checkoutWasNotSubmitted(err)).toBe(false);
  });

  it("keeps an answer for another merchant reference unknown", async () => {
    fetchSpy
      .mockResolvedValueOnce(Response.json({ token: "t" }))
      .mockResolvedValueOnce(
        Response.json({ order_tracking_id: "TRACK-1", merchant_reference: "OTHER", redirect_url: "https://pay.example.test/x" }),
      );
    const err = await caught(provider().createCheckout(REQUEST));
    expect(err.submission).toBe("unknown");
  });

  it("returns the checkout when Pesapal answers with a tracking ID and redirect URL", async () => {
    fetchSpy
      .mockResolvedValueOnce(Response.json({ token: "t" }))
      .mockResolvedValueOnce(
        Response.json({ order_tracking_id: "TRACK-1", merchant_reference: "MGM-ref", redirect_url: "https://pay.example.test/x" }),
      );
    await expect(provider().createCheckout(REQUEST)).resolves.toEqual({
      redirectUrl: "https://pay.example.test/x",
      providerTrackingId: "TRACK-1",
      merchantReference: "MGM-ref",
    });
  });
});

describe("checkoutWasNotSubmitted", () => {
  it("treats errors without a classification as possibly submitted", () => {
    expect(checkoutWasNotSubmitted(new Error("boom"))).toBe(false);
    expect(checkoutWasNotSubmitted(null)).toBe(false);
    expect(checkoutWasNotSubmitted("not_submitted")).toBe(false);
  });
});
