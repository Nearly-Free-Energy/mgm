/**
 * Names retired after v0.0.2 (#79): MGM no longer reads them, and at server
 * start it warns about each one that is still set without its replacement,
 * naming both variables and never the value.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RETIRED_NAMES, retiredNameWarnings, warnAboutRetiredNames } from "../retired-names";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const VALUE = "https://value-must-not-be-logged.example.test/x";

describe("retiredNameWarnings", () => {
  it("lists the five names v0.0.1 and v0.0.2 accepted, with their replacements", () => {
    expect(RETIRED_NAMES.map(({ name, replacement }) => [name, replacement])).toEqual([
      ["NEXT_PUBLIC_SUPABASE_URL", "MGM_PUBLIC_SUPABASE_URL"],
      ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "MGM_PUBLIC_SUPABASE_ANON_KEY"],
      ["NEXT_PUBLIC_SUPABASE_COOKIE_NAME", "MGM_PUBLIC_SUPABASE_COOKIE_NAME"],
      ["NEXT_PUBLIC_APP_URL", "MGM_APP_URL"],
      ["NEXT_PUBLIC_PAYMENT_CALLBACK_URL", "MGM_APP_URL"],
    ]);
  });

  it.each(RETIRED_NAMES.map(({ name, replacement }) => [name, replacement]))(
    "warns once about %s set without %s, naming both and not the value",
    (name, replacement) => {
      const lines = retiredNameWarnings({ [name]: VALUE });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${name} is set but no longer read`);
      expect(lines[0]).toContain(`set ${replacement}`);
      expect(lines[0]).toContain("Upgrading from v0.0.1 or v0.0.2");
      expect(lines[0]).not.toContain("value-must-not-be-logged");
    }
  );

  it("says the replacement for the callback URL is the origin, not the old path", () => {
    const [line] = retiredNameWarnings({ NEXT_PUBLIC_PAYMENT_CALLBACK_URL: VALUE });
    expect(line).toMatch(/MGM_APP_URL \(the application origin only; .*\/payment\/callback\)/);
  });

  it("warns about each old app-URL name when both are set, each naming only itself", () => {
    const lines = retiredNameWarnings({
      NEXT_PUBLIC_APP_URL: VALUE,
      NEXT_PUBLIC_PAYMENT_CALLBACK_URL: VALUE,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[mgm\] NEXT_PUBLIC_APP_URL is set/);
    expect(lines[1]).toMatch(/^\[mgm\] NEXT_PUBLIC_PAYMENT_CALLBACK_URL is set/);
  });

  it("stays silent when the replacement is set, or the old name is empty", () => {
    expect(
      retiredNameWarnings({
        NEXT_PUBLIC_SUPABASE_URL: VALUE,
        MGM_PUBLIC_SUPABASE_URL: "https://new.example.test",
        NEXT_PUBLIC_APP_URL: VALUE,
        NEXT_PUBLIC_PAYMENT_CALLBACK_URL: VALUE,
        MGM_APP_URL: "https://mgm.example.org",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "  ",
      })
    ).toEqual([]);
    expect(retiredNameWarnings({})).toEqual([]);
  });
});

describe("warnAboutRetiredNames", () => {
  it("reads the live environment and logs each warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const { name, replacement } of RETIRED_NAMES) {
      vi.stubEnv(name, "");
      vi.stubEnv(replacement, "");
    }
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", VALUE);
    warnAboutRetiredNames();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(String(warn.mock.calls[0][0])).not.toContain("value-must-not-be-logged");
  });
});
