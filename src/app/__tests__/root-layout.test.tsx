/**
 * Root layout (#46): rendered per request, request-time boundary before the
 * configuration is read, and only the three public fields reach the client
 * configuration provider.
 *
 * "passes only the three public fields" is the guard on what reaches the
 * page: the provider's props are what Next.js serializes into the page
 * payload, so they must already be the fresh three-field object that
 * parsePublicRuntimeConfig returns. The provider's own re-pick happens after
 * that serialization (see public-runtime-config-provider.test.tsx).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

const order: string[] = [];

vi.mock("next/font/google", () => ({
  Inter_Tight: () => ({ variable: "font-inter-tight" }),
  JetBrains_Mono: () => ({ variable: "font-jetbrains-mono" }),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => {
    order.push("connection");
  }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "accept-language": "en-GB" })),
}));
vi.mock("../globals.css", () => ({}));
vi.mock("@/lib/config/public-runtime-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/public-runtime-config")>();
  return {
    ...actual,
    getPublicRuntimeConfig: (...args: Parameters<typeof actual.getPublicRuntimeConfig>) => {
      order.push("config");
      return actual.getPublicRuntimeConfig(...args);
    },
  };
});

import RootLayout, { dynamic } from "../layout";
import { PublicRuntimeConfigProvider } from "@/lib/config/public-runtime-config-provider";

afterEach(() => {
  vi.unstubAllEnvs();
  order.length = 0;
});

function findProvider(node: React.ReactNode): React.ReactElement<{ config: unknown }> | null {
  if (!React.isValidElement(node)) return null;
  if (node.type === PublicRuntimeConfigProvider) {
    return node as React.ReactElement<{ config: unknown }>;
  }
  const children = (node.props as { children?: React.ReactNode }).children;
  for (const child of React.Children.toArray(children)) {
    const found = findProvider(child);
    if (found) return found;
  }
  return null;
}

describe("RootLayout", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("enters the request-time boundary before reading configuration", async () => {
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://alpha.example.test");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_alpha");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "");
    await RootLayout({ children: <main /> });
    expect(order).toEqual(["connection", "config"]);
  });

  it("passes only the three public fields to the provider", async () => {
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://alpha.example.test");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_alpha");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "sb-alpha-auth-token");
    vi.stubEnv("SUPABASE_INTERNAL_URL", "http://kong:8000");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
    vi.stubEnv("MGM_APP_URL", "https://app.example.org");
    const tree = await RootLayout({ children: <main /> });
    const provider = findProvider(tree);
    expect(provider).not.toBeNull();
    expect(provider!.props.config).toEqual({
      supabaseUrl: "https://alpha.example.test",
      supabaseAnonKey: "sb_publishable_alpha",
      cookieName: "sb-alpha-auth-token",
    });
    const serialized = JSON.stringify(provider!.props.config);
    for (const secret of ["service-role-secret", "kong", "app.example.org"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("fails clearly, without rendering, when configuration is missing", async () => {
    for (const name of ["MGM_PUBLIC_SUPABASE_URL", "MGM_PUBLIC_SUPABASE_ANON_KEY"]) {
      vi.stubEnv(name, "");
    }
    // A retired name does not stand in for a missing MGM_ name (#79).
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://legacy.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_legacy");
    await expect(RootLayout({ children: <main /> })).rejects.toThrow(/MGM_PUBLIC_SUPABASE_URL/);
  });
});
