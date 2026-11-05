/**
 * Browser side of the request-time configuration (#46): the provider's
 * context value and the browser store hold only the allowlisted public
 * fields, and browser Supabase clients take their settings from them rather
 * than from process.env.
 *
 * This file does not guard what reaches the page. The provider re-picks
 * the fields only after Next.js has serialized the root layout's props into
 * the page payload, and renderToString below skips that serialization. The
 * guard is the root layout passing parsePublicRuntimeConfig's fresh
 * three-field object, checked in src/app/__tests__/root-layout.test.tsx
 * ("passes only the three public fields to the provider").
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

const seenContext = vi.fn<(value: PublicRuntimeConfig) => void>();

afterEach(() => {
  seenContext.mockClear();
  resetBrowserPublicRuntimeConfig();
  createBrowserClientMock.mockClear();
  vi.unstubAllEnvs();
});

function Probe() {
  seenContext(usePublicRuntimeConfig());
  return null;
}

describe("PublicRuntimeConfigProvider", () => {
  it("context value and browser store hold only the allowlisted fields", () => {
    const widened = {
      supabaseUrl: "https://alpha.example.test",
      supabaseAnonKey: "anon-alpha",
      cookieName: "sb-alpha",
      serviceRoleKey: "must-not-leak",
    } as unknown as PublicRuntimeConfig;
    renderToString(
      <PublicRuntimeConfigProvider config={widened}>
        <Probe />
      </PublicRuntimeConfigProvider>
    );
    const allowlisted = {
      supabaseUrl: "https://alpha.example.test",
      supabaseAnonKey: "anon-alpha",
      cookieName: "sb-alpha",
    };
    expect(seenContext).toHaveBeenCalledTimes(1);
    expect(seenContext.mock.calls[0][0]).toEqual(allowlisted);
    expect(getBrowserPublicRuntimeConfig()).toEqual(allowlisted);
  });

  it("fails clearly when a browser client is created before the provider rendered", () => {
    expect(() => createClient()).toThrow(/Public runtime configuration is not available/);
  });

  it("configures browser clients from the provider, not from process.env", () => {
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://baked.example.test");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "baked-anon");
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
