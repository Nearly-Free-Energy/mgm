/**
 * Server-only MGM_APP_URL (#46): payment links, the provider return URL and
 * the payment notification (IPN) URL are built from the installation's own
 * origin, read at call time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrl, parseAppOrigin, paymentReturnUrl, validateAppUrlAtStartup } from "../app-url";
import { RuntimeConfigError } from "../public-runtime-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseAppOrigin", () => {
  it("accepts an origin, with or without a trailing slash", () => {
    expect(parseAppOrigin({ MGM_APP_URL: "https://mgm.example.org" })).toBe("https://mgm.example.org");
    expect(parseAppOrigin({ MGM_APP_URL: "http://localhost:3000/" })).toBe("http://localhost:3000");
    expect(parseAppOrigin({ MGM_APP_URL: "http://127.0.0.1:3000" })).toBe("http://127.0.0.1:3000");
  });

  it.each([
    ["mgm.example.org", /not a valid absolute URL/],
    ["ftp://mgm.example.org", /must use http or https/],
    ["http://mgm.example.org", /must use https/],
    ["http://10.0.0.5:3000", /must use https/],
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
  it("builds the return and notification URLs from MGM_APP_URL", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    expect(paymentReturnUrl()).toBe("https://alpha.example.org/payment/callback");
    expect(appUrl("/api/payments/ipn")).toBe("https://alpha.example.org/api/payments/ipn");
  });

  it("follows a different installation's MGM_APP_URL in the same process", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    const a = paymentReturnUrl();
    vi.stubEnv("MGM_APP_URL", "https://beta.example.net:8443/");
    const b = paymentReturnUrl();
    expect(a).toBe("https://alpha.example.org/payment/callback");
    expect(b).toBe("https://beta.example.net:8443/payment/callback");
  });

  it("keeps the legacy return URL exactly: the full NEXT_PUBLIC_PAYMENT_CALLBACK_URL wins", () => {
    const legacy = {
      NEXT_PUBLIC_APP_URL: "https://app.example.org/ignored-path",
      NEXT_PUBLIC_PAYMENT_CALLBACK_URL: "https://pay.example.net/custom/return?src=mgm",
    };
    // Return URL: unchanged legacy behaviour, path and query included.
    expect(paymentReturnUrl(legacy)).toBe("https://pay.example.net/custom/return?src=mgm");
    // Other application URLs (payment links, notification URL) keep using
    // the NEXT_PUBLIC_APP_URL origin, as before.
    expect(appUrl("/api/payments/ipn", legacy)).toBe("https://app.example.org/api/payments/ipn");
    // Only NEXT_PUBLIC_APP_URL: origin plus /payment/callback.
    expect(paymentReturnUrl({ NEXT_PUBLIC_APP_URL: legacy.NEXT_PUBLIC_APP_URL })).toBe(
      "https://app.example.org/payment/callback"
    );
    // MGM_APP_URL set: the legacy names are ignored.
    expect(paymentReturnUrl({ ...legacy, MGM_APP_URL: "https://new.example.org" })).toBe(
      "https://new.example.org/payment/callback"
    );
  });

  it("throws when the application URL is not configured", () => {
    expect(() => paymentReturnUrl({})).toThrow(/MGM_APP_URL/);
    expect(() => appUrl("/payment/callback", {})).toThrow(/MGM_APP_URL/);
  });

  it("refuses paths that would change the host", () => {
    vi.stubEnv("MGM_APP_URL", "https://alpha.example.org");
    expect(() => appUrl("//evil.example.com/x")).toThrow();
    expect(() => appUrl("payment/callback")).toThrow();
  });
});

describe("validateAppUrlAtStartup", () => {
  it("throws on an invalid MGM_APP_URL", () => {
    expect(() => validateAppUrlAtStartup({ MGM_APP_URL: "http://mgm.example.org" })).toThrow(
      /must use https/
    );
  });

  it("warns, without throwing, when no application URL is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateAppUrlAtStartup({})).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MGM_APP_URL is not set"));
    warn.mockRestore();
  });

  it("accepts a valid configuration", () => {
    expect(() => validateAppUrlAtStartup({ MGM_APP_URL: "https://mgm.example.org" })).not.toThrow();
  });
});
