/**
 * Browser side of the request-time configuration (#46): the provider passes
 * only the allowlisted public values, and browser Supabase clients take
 * their settings from it rather than from process.env.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";

const createBrowserClientMock = vi.fn((..._args: unknown[]) => ({ kind: "browser-client" }));
vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => createBrowserClientMock(...args),
}));

import {
  PublicRuntimeConfigProvider,
  usePublicRuntimeConfig,
} from "../public-runtime-config-provider";
import {
  getBrowserPublicRuntimeConfig,
  resetBrowserPublicRuntimeConfig,
} from "../browser-config-store";
import { createClient } from "@/lib/supabase/client";
import type { PublicRuntimeConfig } from "../public-runtime-config";

afterEach(() => {
  resetBrowserPublicRuntimeConfig();
  createBrowserClientMock.mockClear();
  vi.unstubAllEnvs();
});

function Probe() {
  const config = usePublicRuntimeConfig();
  return <pre>{JSON.stringify(config)}</pre>;
}

describe("PublicRuntimeConfigProvider", () => {
  it("exposes only the allowlisted public fields", () => {
    const widened = {
      supabaseUrl: "https://alpha.example.test",
      supabaseAnonKey: "anon-alpha",
      cookieName: "sb-alpha",
      serviceRoleKey: "must-not-leak",
    } as unknown as PublicRuntimeConfig;
    const html = renderToString(
      <PublicRuntimeConfigProvider config={widened}>
        <Probe />
      </PublicRuntimeConfigProvider>
    );
    expect(html).toContain("anon-alpha");
    expect(html).not.toContain("must-not-leak");
    expect(getBrowserPublicRuntimeConfig()).toEqual({
      supabaseUrl: "https://alpha.example.test",
      supabaseAnonKey: "anon-alpha",
      cookieName: "sb-alpha",
    });
  });

  it("fails clearly when a browser client is created before the provider rendered", () => {
    expect(() => createClient()).toThrow(/Public runtime configuration is not available/);
  });

  it("configures browser clients from the provider, not from process.env", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://baked.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "baked-anon");
    for (const config of [
      { supabaseUrl: "https://alpha.example.test", supabaseAnonKey: "anon-alpha", cookieName: "sb-alpha" },
      { supabaseUrl: "http://localhost:54321", supabaseAnonKey: "anon-beta" },
    ] satisfies PublicRuntimeConfig[]) {
      renderToString(
        <PublicRuntimeConfigProvider config={config}>
          <span />
        </PublicRuntimeConfigProvider>
      );
      createClient();
      const [url, key, options] = createBrowserClientMock.mock.calls.at(-1)!;
      expect(url).toBe(config.supabaseUrl);
      expect(key).toBe(config.supabaseAnonKey);
      expect(options).toEqual(
        "cookieName" in config ? { cookieOptions: { name: config.cookieName } } : {}
      );
    }
  });
});
