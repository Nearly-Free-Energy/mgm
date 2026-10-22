/**
 * Server-only MGM_APP_URL (#46): payment links, the provider return URL and
 * the payment notification (IPN) URL are built from the installation's own
 * origin, read at call time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, parseAppOrigin } from "../app-url";
import { RuntimeConfigError } from "../public-runtime-config";
import { defaultAppUrl } from "@/lib/payments/compose";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseAppOrigin", () => {
  it("accepts an origin, with or without a trailing slash", () => {
    expect(parseAppOrigin({ MGM_APP_URL: "https://mgm.example.org" })).toBe("https://mgm.example.org");
    expect(parseAppOrigin({ MGM_APP_URL: "http://localhost:3000/" })).toBe("http://localhost:3000");
  });

  it.each([
    ["mgm.example.org", /not a valid absolute URL/],
    ["ftp://mgm.example.org", /must use http or https/],
    ["https://mgm.example.org/app", /origin only/],
    ["https://mgm.example.org/?x=1", /origin only/],
    ["https://user:pw@mgm.example.org", /must not contain credentials/],
  ])("rejects %s without echoing it", (value, pattern) => {
    let caught: unknown;
    try {
      parseAppOrigin({ MGM_APP_URL: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeConfigError);
    expect((caught as Error).message).toMatch(pattern);
    expect((caught as Error).message).toContain("MGM_APP_URL");
    expect((caught as Error).message).not.toContain(value);
  });

  it("fails clearly when nothing is configured", () => {
    expect(() => parseAppOrigin({})).toThrow(/Missing required runtime configuration: MGM_APP_URL/);
  });

  it("falls back to the legacy names for one release, using only their origin", () => {
    expect(parseAppOrigin({ NEXT_PUBLIC_APP_URL: "https://legacy.example.org/x" })).toBe(
      "https://legacy.example.org"
    );
    expect(
      parseAppOrigin({ NEXT_PUBLIC_PAYMENT_CALLBACK_URL: "https://cb.example.org/payment/callback" })
    ).toBe("https://cb.example.org");
    // MGM_APP_URL wins over both.
    expect(
      parseAppOrigin({
        MGM_APP_URL: "https://new.example.org",
        NEXT_PUBLIC_APP_URL: "https://legacy.example.org",
        NEXT_PUBLIC_PAYMENT_CALLBACK_URL: "https://cb.example.org/payment/callback",
      })
    ).toBe("https://new.example.org");
  });
});

describe("payment URL builder", () => {
  it("builds payment, return and notification URLs from MGM_APP_URL", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    expect(defaultAppUrl("/api/billing-line-items/li-1/pay")).toBe(
      "https://alpha.example.org/api/billing-line-items/li-1/pay"
    );
    expect(defaultAppUrl("/payment/callback")).toBe("https://alpha.example.org/payment/callback");
    expect(appUrl("/api/payments/ipn")).toBe("https://alpha.example.org/api/payments/ipn");
  });

  it("follows a different installation's MGM_APP_URL in the same process", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    const a = defaultAppUrl("/payment/callback");
    vi.stubEnv("MGM_APP_URL", "http://beta.example.net:8080/");
    const b = defaultAppUrl("/payment/callback");
    expect(a).toBe("https://alpha.example.org/payment/callback");
    expect(b).toBe("http://beta.example.net:8080/payment/callback");
  });

  it("throws when the application URL is not configured", () => {
    vi.stubEnv("MGM_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_PAYMENT_CALLBACK_URL", "");
    expect(() => defaultAppUrl("/payment/callback")).toThrow(/MGM_APP_URL/);
  });

  it("refuses paths that would change the host", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    expect(() => appUrl("//evil.example.com/x")).toThrow();
    expect(() => appUrl("payment/callback")).toThrow();
  });
});
