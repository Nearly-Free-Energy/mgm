/**
 * Server-start validation (#46): register() warns about names retired after
 * v0.0.2 (#79), validates MGM_APP_URL and the Supabase runtime configuration
 * on the Node.js runtime, and does nothing during `next build` or on the
 * Edge runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadRegister() {
  vi.resetModules();
  return (await import("../../instrumentation")).register;
}

function stubValid() {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://alpha.example.test");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_alpha");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "");
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.org");
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_COOKIE_NAME",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_PAYMENT_CALLBACK_URL",
  ]) {
    vi.stubEnv(name, "");
  }
}

describe("instrumentation register()", () => {
  it("accepts a valid configuration at server start, without warnings", async () => {
    stubValid();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect((await loadRegister())()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs an error naming MGM_APP_URL and does not throw on an invalid value", async () => {
    stubValid();
    vi.stubEnv("MGM_APP_URL", "http://mgm.example.org");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect((await loadRegister())()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0][0]);
    expect(logged).toMatch(/MGM_APP_URL must use https/);
    expect(logged).not.toContain("mgm.example.org");
    error.mockRestore();
  });

  it("rejects register() on missing Supabase settings", async () => {
    stubValid();
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "");
    await expect((await loadRegister())()).rejects.toThrow(/MGM_PUBLIC_SUPABASE_URL/);
  });

  it("names each retired variable still set, then fails on the missing MGM_ names", async () => {
    stubValid();
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("MGM_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://legacy.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_legacy");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://legacy.example.org");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect((await loadRegister())()).rejects.toThrow(
      /Missing required runtime configuration: MGM_PUBLIC_SUPABASE_URL, MGM_PUBLIC_SUPABASE_ANON_KEY\./
    );
    const logged = warn.mock.calls.map((call) => String(call[0]));
    expect(logged).toEqual([
      expect.stringMatching(/NEXT_PUBLIC_SUPABASE_URL is set but no longer read; set MGM_PUBLIC_SUPABASE_URL/),
      expect.stringMatching(/NEXT_PUBLIC_SUPABASE_ANON_KEY is set but no longer read; set MGM_PUBLIC_SUPABASE_ANON_KEY/),
      expect.stringMatching(/NEXT_PUBLIC_APP_URL is set but no longer read; set MGM_APP_URL/),
      expect.stringContaining("MGM_APP_URL is not set"),
    ]);
    expect(logged.join("\n")).not.toMatch(/legacy\.example|sb_publishable_legacy/);
    warn.mockRestore();
  });

  it("skips validation during next build and on the Edge runtime", async () => {
    stubValid();
    vi.stubEnv("MGM_APP_URL", "not a url");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await expect((await loadRegister())()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect((await loadRegister())()).resolves.toBeUndefined();
  });
});
