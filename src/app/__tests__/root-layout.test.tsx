/**
 * Root layout (#46): rendered per request, request-time boundary before the
 * configuration is read, and only the three public fields reach the client
 * configuration provider. It also loads the one web font and puts its
 * variable on <html>, where globals.css resolves --font-sans.
 *
 * "passes only the three public fields" is the guard on what reaches the
 * page: the provider's props are what Next.js serializes into the page
 * payload, so they must already be the fresh three-field object that
 * parsePublicRuntimeConfig returns. The provider's own re-pick happens after
 * that serialization (see public-runtime-config-provider.test.tsx).
 *
 * It also names the app in the tab title and sets the browser's theme
 * colour. The icon files the metadata points at are checked in
 * src/lib/__tests__/app-icons.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

const order: string[] = [];
const { fontCalls } = vi.hoisted(() => ({ fontCalls: [] as unknown[] }));

vi.mock("next/font/google", () => ({
  Inter: (options: unknown) => {
    fontCalls.push(options);
    return { variable: "font-inter" };
  },
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

import RootLayout, { dynamic, metadata, viewport } from "../layout";
import { PublicRuntimeConfigProvider } from "@/lib/config/public-runtime-config-provider";
import { THEME_COLOR } from "@/lib/public-html/palette";

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

type ElementWithClass = React.ReactElement<{ className?: string; children?: React.ReactNode }>;

describe("RootLayout", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("titles every tab Microgrid Manager, and a page's own title ends in MGM", () => {
    expect(metadata.title).toEqual({ default: "Microgrid Manager", template: "%s · MGM" });
    expect(metadata.applicationName).toBe("MGM");
  });

  it("describes what the app does", () => {
    expect(metadata.description).toBe(
      "Run community microgrids: households, meters, tariffs, bills and payments.",
    );
  });

  it("labels the iOS home-screen icon MGM without switching it to standalone", () => {
    expect(metadata.appleWebApp).toEqual({ title: "MGM", capable: false });
  });

  it("colours the browser bar with the light page background only", () => {
    // Pages render only the light palette, so no dark entry yet.
    expect(viewport.themeColor).toBe(THEME_COLOR.light);
  });

  it("covers the whole screen, so bottom bars clear the home indicator themselves", () => {
    expect(viewport).toMatchObject({ width: "device-width", initialScale: 1, viewportFit: "cover" });
  });

  it("loads one variable Inter, not preloaded, that never swaps in mid-page", () => {
    // The loader runs once, when the module is imported.
    expect(fontCalls).toEqual([
      expect.objectContaining({
        subsets: ["latin"],
        variable: "--font-inter",
        preload: false,
        display: "optional",
      }),
    ]);
    // No weight list: next/font then serves the variable font, one file for
    // every weight, instead of one file per weight.
    expect(fontCalls[0]).not.toHaveProperty("weight");
  });

  it("puts the font variable on <html>, not <body>", async () => {
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://alpha.example.test");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_alpha");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "");
    const html = (await RootLayout({ children: <main /> })) as ElementWithClass;
    expect(html.type).toBe("html");
    expect(html.props.className?.split(/\s+/)).toContain("font-inter");
    const body = React.Children.toArray(html.props.children).find(
      (child): child is ElementWithClass => React.isValidElement(child) && child.type === "body",
    );
    expect(body).toBeDefined();
    expect(body!.props.className ?? "").not.toContain("font-inter");
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
