/**
 * service.test.ts
 *
 * Asserts the env-var guard on `createServiceClient()`:
 *   - The module loads without the key (so `next build` page-data
 *     collection succeeds for routes that merely import it).
 *   - The factory throws when SUPABASE_SERVICE_ROLE_KEY is unset.
 *   - The factory returns a client when both URL + key are present.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Restore env + reset the ESM module cache so the next `await import(...)`
  // re-evaluates the module against fresh env.
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("createServiceClient (env-var guard)", () => {
  it("loads without the key but throws from the factory when unset", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";

    vi.resetModules();

    const mod = await import("../service");
    expect(() => mod.createServiceClient()).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY is not set/
    );
  });

  it("returns a client when URL + service-role key are present", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

    vi.resetModules();

    const mod = await import("../service");
    const client = mod.createServiceClient();

    // supabase-js clients expose .from() + .auth — cheap shape check.
    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
    expect(client.auth).toBeDefined();
  });

  it("prefers SUPABASE_INTERNAL_URL over NEXT_PUBLIC_SUPABASE_URL", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://public.local";
    process.env.SUPABASE_INTERNAL_URL = "http://internal.local";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

    vi.resetModules();

    // This is essentially a "does it load" test — the URL selection is
    // exercised through the successful createClient call. If we ever
    // want to assert the URL used, we'd need to mock @supabase/supabase-js.
    const mod = await import("../service");
    expect(mod.createServiceClient()).toBeDefined();
  });
});
