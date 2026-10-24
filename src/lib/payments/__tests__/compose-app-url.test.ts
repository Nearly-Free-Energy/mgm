/**
 * compose.ts `defaultAppUrl` (#46): the Payments capability builds payment
 * links and the provider return URL from the server-only MGM_APP_URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppUrl } from "../compose";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("defaultAppUrl", () => {
  it("builds payment links and the return URL from MGM_APP_URL", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    expect(defaultAppUrl("/api/billing-line-items/li-1/pay")).toBe(
      "https://alpha.example.org/api/billing-line-items/li-1/pay"
    );
    expect(defaultAppUrl("/payment/callback")).toBe("https://alpha.example.org/payment/callback");
  });

  it("follows two installations' settings without carry-over", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    const a = defaultAppUrl("/payment/callback");
    vi.stubEnv("MGM_APP_URL", "https://beta.example.net");
    expect(a).toBe("https://alpha.example.org/payment/callback");
    expect(defaultAppUrl("/payment/callback")).toBe("https://beta.example.net/payment/callback");
  });

  it("keeps its previous legacy behaviour: NEXT_PUBLIC_APP_URL origin first", () => {
    vi.stubEnv("MGM_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.org/x");
    vi.stubEnv("NEXT_PUBLIC_PAYMENT_CALLBACK_URL", "https://pay.example.net/custom/return");
    expect(defaultAppUrl("/payment/callback")).toBe("https://app.example.org/payment/callback");
  });

  it("throws when no application URL is configured", () => {
    vi.stubEnv("MGM_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_PAYMENT_CALLBACK_URL", "");
    expect(() => defaultAppUrl("/payment/callback")).toThrow(/MGM_APP_URL/);
  });
});
