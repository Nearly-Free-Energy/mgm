import { afterEach, expect, it, vi } from "vitest";
import { createRecoveryRequestClient } from "../../supabase/recovery-client";
import {
  resetBrowserPublicRuntimeConfig,
  setBrowserPublicRuntimeConfig,
} from "../../config/browser-config-store";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetBrowserPublicRuntimeConfig(); });

it("requests a cross-browser recovery link without a PKCE challenge", async () => {
  // Request-time public configuration, as the root layout's provider sets it (#46).
  setBrowserPublicRuntimeConfig({
    supabaseUrl: "https://auth.example.test",
    supabaseAnonKey: "public-test-key",
  });
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
  expect(url).toContain("https://auth.example.test/auth/v1/recover?redirect_to=");
  const body = JSON.parse(options.body as string);
  expect(body.email).toBe("test@example.test");
  expect(body.code_challenge).toBeNull();
  expect(body.code_challenge_method).toBeNull();
});
