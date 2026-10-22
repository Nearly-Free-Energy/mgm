/**
 * Server-start validation (#46): register() validates MGM_APP_URL and the
 * Supabase runtime configuration on the Node.js runtime, and does nothing
 * during `next build` or on the Edge runtime.
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
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.org");
}

describe("instrumentation register()", () => {
  it("accepts a valid configuration at server start", async () => {
    stubValid();
    await expect((await loadRegister())()).resolves.toBeUndefined();
  });

  it("stops the server on an invalid MGM_APP_URL", async () => {
    stubValid();
    vi.stubEnv("MGM_APP_URL", "http://mgm.example.org");
    await expect((await loadRegister())()).rejects.toThrow(/MGM_APP_URL must use https/);
  });

  it("stops the server on missing Supabase settings", async () => {
    stubValid();
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    await expect((await loadRegister())()).rejects.toThrow(/MGM_PUBLIC_SUPABASE_URL/);
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
