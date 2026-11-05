/**
 * Payment notification (IPN) registration target (#46): registered from the
 * server-only MGM_APP_URL; a missing application URL is reported as
 * `callback_url_unknown` before any registration call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  testConnection: vi.fn(),
  getAccessToken: vi.fn(),
  registerIpn: vi.fn(),
}));

vi.mock("../providers/pesapal/provider", () => ({
  baseUrlForSandbox: (sandbox: boolean) =>
    sandbox ? "https://sandbox.pesapal.example.test/v3" : "https://pay.pesapal.example.test/v3",
  PesapalPaymentProvider: class {
    testConnection = mocks.testConnection;
  },
}));

vi.mock("../pesapal/client", () => ({
  PesapalClient: class {
    getAccessToken = mocks.getAccessToken;
    registerIpn = mocks.registerIpn;
  },
}));

import { testMerchantConfiguration } from "../infrastructure/merchant-configuration";

const INPUT = { consumerKey: "test-consumer-key", consumerSecret: "test-consumer-secret", sandbox: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.testConnection.mockResolvedValue({ ok: true });
  mocks.getAccessToken.mockResolvedValue("token");
  mocks.registerIpn.mockResolvedValue({ ipn_id: "ipn-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("testMerchantConfiguration IPN registration", () => {
  it.each([
    ["https://alpha.example.org", "https://alpha.example.org/api/payments/ipn"],
    ["https://beta.example.net:8443/", "https://beta.example.net:8443/api/payments/ipn"],
  ])("registers the notification URL from MGM_APP_URL=%s", async (origin, expected) => {
    vi.stubEnv("MGM_APP_URL", origin);
    const result = await testMerchantConfiguration(INPUT);
    expect(result).toEqual({
      ok: true,
      baseUrl: "https://sandbox.pesapal.example.test/v3",
      ipnId: "ipn-1",
      ipnUrl: expected,
    });
    expect(mocks.registerIpn).toHaveBeenCalledWith("token", expected, "POST");
  });

  it("returns callback_url_unknown, without registering, when no application URL is set", async () => {
    vi.stubEnv("MGM_APP_URL", "");
    const result = await testMerchantConfiguration(INPUT);
    expect(result).toEqual({
      ok: false,
      reason: "callback_url_unknown",
      message: expect.stringContaining("MGM_APP_URL"),
    });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
    expect(mocks.registerIpn).not.toHaveBeenCalled();
  });

  it("returns callback_url_unknown for an invalid MGM_APP_URL", async () => {
    vi.stubEnv("MGM_APP_URL", "http://mgm.example.org");
    const result = await testMerchantConfiguration(INPUT);
    expect(result).toMatchObject({
      ok: false,
      reason: "callback_url_unknown",
      message: expect.stringMatching(/MGM_APP_URL must use https/),
    });
    expect(JSON.stringify(result)).not.toContain("mgm.example.org");
    expect(mocks.registerIpn).not.toHaveBeenCalled();
  });
});
