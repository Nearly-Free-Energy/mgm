/**
 * The tenant access notice (RFC mgm#197 § 6): where to sign in, with no
 * sign-in link, token or code, and nothing about the unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { tenantAccessNotice } from "../tenant-access-notice";

beforeEach(() => {
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tenantAccessNotice", () => {
  it("names the organization and says where to sign in", () => {
    expect(tenantAccessNotice({ to: "renter@example.test", organizationName: " Lakeside Power " })).toEqual({
      to: "renter@example.test",
      subject: "Lakeside Power gave you access to your electricity use in MGM",
      text: [
        "Lakeside Power gave you access to your electricity use in MGM (Microgrid Manager).",
        "",
        'To sign in, go to https://mgm.example.test/login and choose "Email me a sign-in link" with this address, renter@example.test.',
        "MGM emails you a link that signs you in. There is no password to set.",
        "",
        "If you were not expecting this, you can ignore this email.",
      ].join("\n"),
    });
  });

  it("reads without an organization name", () => {
    for (const organizationName of [null, "", "   "]) {
      const notice = tenantAccessNotice({ to: "renter@example.test", organizationName });
      expect(notice.subject).toBe("You have access to your electricity use in MGM");
      expect(notice.text.split("\n")[0]).toBe(
        "You were given access to your electricity use in MGM (Microgrid Manager)."
      );
      expect(notice.text).toContain("https://mgm.example.test/login");
    }
  });

  it("carries no sign-in link, token or code, and names no unit", () => {
    const notice = tenantAccessNotice({ to: "renter@example.test", organizationName: "Lakeside Power" });
    const all = `${notice.subject}\n${notice.text}`;
    expect(all).not.toMatch(/token|code|confirm\?|accept-invite|#access_token|otp|\/auth\/confirm/i);
    expect(all).not.toMatch(/unit|meter|kwh/i);
    // The only URL is the sign-in page.
    expect(all.match(/https?:\/\/\S+/g)).toEqual(["https://mgm.example.test/login"]);
  });

  it("throws when the application URL is not set, so the caller can report the notice unsent", () => {
    vi.stubEnv("MGM_APP_URL", "");
    expect(() => tenantAccessNotice({ to: "renter@example.test", organizationName: null })).toThrow(/MGM_APP_URL/);
  });
});
