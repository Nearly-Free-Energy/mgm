import { afterEach, expect, it, vi } from "vitest";
import { createRecoveryRequestClient } from "../../supabase/recovery-client";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("requests a cross-browser recovery link without a PKCE challenge", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://auth.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-test-key");
  const fetchSpy = vi.fn(async () => new Response("{}", {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchSpy);
  const client = createRecoveryRequestClient();
  const { error } = await client.auth.resetPasswordForEmail("test@example.test", {
    redirectTo: "https://mgm.example.test/reset-password",
  });
  expect(error).toBeNull();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, options] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("/recover?redirect_to=");
  const body = JSON.parse(options.body as string);
  expect(body.email).toBe("test@example.test");
  expect(body.code_challenge).toBeNull();
  expect(body.code_challenge_method).toBeNull();
});
