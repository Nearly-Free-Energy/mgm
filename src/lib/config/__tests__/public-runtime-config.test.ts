/**
 * Request-time public runtime configuration (#46).
 *
 * Covers: a valid configuration, missing and invalid settings (errors name
 * the variable and never echo the value), refusal of privileged keys, the
 * retired NEXT_PUBLIC_SUPABASE_* names being ignored (#79), and two
 * independent configurations parsed by the same code with no carry-over.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPublicRuntimeConfig,
  getServerSupabaseSettings,
  getServerSupabaseUrl,
  parsePublicRuntimeConfig,
  RuntimeConfigError,
} from "../public-runtime-config";

// A JWT-shaped anon key (header.payload.signature) with role "anon".
function jwtWithRole(role: string): string {
  const b64url = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ iss: "supabase", role })}.signature`;
}

const ANON_A = jwtWithRole("anon");
const ANON_B = "sb_publishable_installationB";

const INSTALL_A = {
  MGM_PUBLIC_SUPABASE_URL: "https://alpha.supabase.example.test",
  MGM_PUBLIC_SUPABASE_ANON_KEY: ANON_A,
  MGM_PUBLIC_SUPABASE_COOKIE_NAME: "sb-alpha-auth-token",
};
const INSTALL_B = {
  MGM_PUBLIC_SUPABASE_URL: "http://localhost:54321/",
  MGM_PUBLIC_SUPABASE_ANON_KEY: ANON_B,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectConfigError(fn: () => unknown, pattern: RegExp, secret?: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeConfigError);
  const message = (caught as Error).message;
  expect(message).toMatch(pattern);
  if (secret) expect(message).not.toContain(secret);
}

describe("parsePublicRuntimeConfig", () => {
  it("accepts a valid configuration and returns only the three public fields", () => {
    const config = parsePublicRuntimeConfig({
      ...INSTALL_A,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      MGM_CREDENTIAL_KEY: "credential-secret",
    });
    expect(config).toEqual({
      supabaseUrl: "https://alpha.supabase.example.test",
      supabaseAnonKey: ANON_A,
      cookieName: "sb-alpha-auth-token",
    });
    expect(Object.keys(config).sort()).toEqual(
      ["cookieName", "supabaseAnonKey", "supabaseUrl"]
    );
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  it("treats the cookie name as optional and strips a trailing slash", () => {
    const config = parsePublicRuntimeConfig(INSTALL_B);
    expect(config).toEqual({
      supabaseUrl: "http://localhost:54321",
      supabaseAnonKey: ANON_B,
    });
    expect("cookieName" in config).toBe(false);
  });

  it("parses two independent configurations without carry-over", () => {
    const a = parsePublicRuntimeConfig(INSTALL_A);
    const b = parsePublicRuntimeConfig(INSTALL_B);
    const aAgain = parsePublicRuntimeConfig(INSTALL_A);
    expect(a.supabaseUrl).not.toBe(b.supabaseUrl);
    expect(a.supabaseAnonKey).not.toBe(b.supabaseAnonKey);
    expect(b.cookieName).toBeUndefined();
    expect(aAgain).toEqual(a);
  });

  it("names every missing required variable", () => {
    expectConfigError(
      () => parsePublicRuntimeConfig({}),
      /MGM_PUBLIC_SUPABASE_URL, MGM_PUBLIC_SUPABASE_ANON_KEY/
    );
    expectConfigError(
      () => parsePublicRuntimeConfig({ MGM_PUBLIC_SUPABASE_URL: INSTALL_A.MGM_PUBLIC_SUPABASE_URL }),
      /Missing required runtime configuration: MGM_PUBLIC_SUPABASE_ANON_KEY\./
    );
    expectConfigError(
      () => parsePublicRuntimeConfig({ MGM_PUBLIC_SUPABASE_URL: "  ", MGM_PUBLIC_SUPABASE_ANON_KEY: ANON_B }),
      /MGM_PUBLIC_SUPABASE_URL/
    );
  });

  it.each([
    ["not a url", /not a valid absolute URL/],
    ["ftp://files.example.test", /must use http or https/],
    ["https://user:pass@alpha.example.test", /must not contain credentials/],
    ["https://alpha.example.test/?token=abc", /query string or fragment/],
  ])("rejects the invalid URL %s without echoing it", (value, pattern) => {
    expectConfigError(
      () => parsePublicRuntimeConfig({ ...INSTALL_A, MGM_PUBLIC_SUPABASE_URL: value }),
      pattern,
      value
    );
  });

  it.each([
    ["an arbitrary string", "anon-key"],
    ["an authenticated-role JWT", jwtWithRole("authenticated")],
    ["a JWT without a readable payload", "aaa.bbb.ccc"],
    ["a publishable prefix with bad characters", "sb_publishable_abc$def"],
  ])("refuses %s as the public key", (_label, value) => {
    expectConfigError(
      () => parsePublicRuntimeConfig({ ...INSTALL_A, MGM_PUBLIC_SUPABASE_ANON_KEY: value }),
      /must be the public key/,
      value
    );
  });

  it("refuses a service-role JWT or a secret key as the public key", () => {
    const serviceRole = jwtWithRole("service_role");
    expectConfigError(
      () => parsePublicRuntimeConfig({ ...INSTALL_A, MGM_PUBLIC_SUPABASE_ANON_KEY: serviceRole }),
      /must be the public key/,
      serviceRole
    );
    expectConfigError(
      () => parsePublicRuntimeConfig({ ...INSTALL_A, MGM_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_abc123" }),
      /must be the public key/,
      "sb_secret_abc123"
    );
  });

  it("rejects an invalid cookie name", () => {
    expectConfigError(
      () => parsePublicRuntimeConfig({ ...INSTALL_A, MGM_PUBLIC_SUPABASE_COOKIE_NAME: "bad name;" }),
      /MGM_PUBLIC_SUPABASE_COOKIE_NAME may contain only/,
      "bad name;"
    );
  });

  it("no longer reads the retired NEXT_PUBLIC_SUPABASE_* names (#79)", () => {
    const retired = {
      NEXT_PUBLIC_SUPABASE_URL: "https://legacy.example.test",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_legacy",
      NEXT_PUBLIC_SUPABASE_COOKIE_NAME: "sb-legacy",
    };
    // On their own they configure nothing: the MGM_ names are reported missing.
    expectConfigError(
      () => parsePublicRuntimeConfig(retired),
      /Missing required runtime configuration: MGM_PUBLIC_SUPABASE_URL, MGM_PUBLIC_SUPABASE_ANON_KEY\./,
      "legacy"
    );
    // They do not complete a partial MGM_ set either.
    expectConfigError(
      () => parsePublicRuntimeConfig({ ...retired, MGM_PUBLIC_SUPABASE_URL: "https://new.example.test" }),
      /Missing required runtime configuration: MGM_PUBLIC_SUPABASE_ANON_KEY\./
    );
    expectConfigError(
      () => getServerSupabaseUrl(retired),
      /Missing required runtime configuration: MGM_PUBLIC_SUPABASE_URL\./
    );
    // Next to a complete MGM_ set they are ignored, cookie name included:
    // neither refused nor used.
    expect(parsePublicRuntimeConfig({ ...retired, ...INSTALL_B })).toEqual({
      supabaseUrl: "http://localhost:54321",
      supabaseAnonKey: ANON_B,
    });
    expect(parsePublicRuntimeConfig({ ...retired, ...INSTALL_A }).cookieName).toBe(
      "sb-alpha-auth-token"
    );
    // The internal-host rule asks for the MGM_ cookie name; the retired one
    // does not satisfy it.
    expectConfigError(
      () => getServerSupabaseSettings({ ...retired, ...INSTALL_B, SUPABASE_INTERNAL_URL: "http://kong:8000" }),
      /MGM_PUBLIC_SUPABASE_URL, so MGM_PUBLIC_SUPABASE_COOKIE_NAME must be set/
    );
  });
});

describe("live environment readers", () => {
  it("read the process environment at call time, not at module load", () => {
    for (const [k, v] of Object.entries(INSTALL_A)) vi.stubEnv(k, v);
    expect(getPublicRuntimeConfig().supabaseUrl).toBe(INSTALL_A.MGM_PUBLIC_SUPABASE_URL);
    vi.unstubAllEnvs();
    for (const [k, v] of Object.entries(INSTALL_B)) vi.stubEnv(k, v);
    vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "");
    expect(getPublicRuntimeConfig()).toEqual({
      supabaseUrl: "http://localhost:54321",
      supabaseAnonKey: ANON_B,
    });
  });

  it("do not read the retired names from the process environment", () => {
    for (const name of ["MGM_PUBLIC_SUPABASE_URL", "MGM_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_INTERNAL_URL"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://legacy.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_legacy");
    expectConfigError(() => getPublicRuntimeConfig(), /MGM_PUBLIC_SUPABASE_URL, MGM_PUBLIC_SUPABASE_ANON_KEY/);
    expectConfigError(() => getServerSupabaseUrl(), /MGM_PUBLIC_SUPABASE_URL/);
  });

  it("keeps the server-only internal URL override out of the public config", () => {
    const env = { ...INSTALL_A, SUPABASE_INTERNAL_URL: "http://kong:8000" };
    const settings = getServerSupabaseSettings(env);
    expect(settings.url).toBe("http://kong:8000");
    expect(settings.anonKey).toBe(ANON_A);
    expect(settings.publicConfig.supabaseUrl).toBe(INSTALL_A.MGM_PUBLIC_SUPABASE_URL);
    expect(JSON.stringify(settings.publicConfig)).not.toContain("kong");
    expect(getServerSupabaseUrl(env)).toBe("http://kong:8000");
    expect(getServerSupabaseUrl(INSTALL_B)).toBe("http://localhost:54321");
  });

  it("requires a cookie name when the internal URL host differs from the public host", () => {
    const noCookie = {
      MGM_PUBLIC_SUPABASE_URL: INSTALL_A.MGM_PUBLIC_SUPABASE_URL,
      MGM_PUBLIC_SUPABASE_ANON_KEY: ANON_A,
      SUPABASE_INTERNAL_URL: "http://kong:8000",
    };
    expectConfigError(
      () => getServerSupabaseSettings(noCookie),
      /MGM_PUBLIC_SUPABASE_COOKIE_NAME must be set/
    );
    // Same host (path or port-free variants aside): the derived names agree.
    expect(
      getServerSupabaseSettings({
        ...noCookie,
        SUPABASE_INTERNAL_URL: INSTALL_A.MGM_PUBLIC_SUPABASE_URL,
      }).url
    ).toBe(INSTALL_A.MGM_PUBLIC_SUPABASE_URL);
    // No internal URL: nothing can diverge.
    expect(getServerSupabaseSettings(INSTALL_B).url).toBe("http://localhost:54321");
  });

  it("lets service-role callers resolve the URL without an anon key", () => {
    expect(getServerSupabaseUrl({ MGM_PUBLIC_SUPABASE_URL: "https://alpha.example.test" })).toBe(
      "https://alpha.example.test"
    );
    expectConfigError(() => getServerSupabaseUrl({}), /MGM_PUBLIC_SUPABASE_URL/);
    expectConfigError(
      () => getServerSupabaseUrl({ ...INSTALL_A, SUPABASE_INTERNAL_URL: "kong:8000" }),
      /SUPABASE_INTERNAL_URL/
    );
  });
});
