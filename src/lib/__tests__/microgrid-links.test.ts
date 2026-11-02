/**
 * microgrid-links tests.
 *
 * In-app links skip the redirects that old bookmarks still go through, so
 * each link target must be exactly where its redirect lands. These tests
 * fail when a redirect target moves without the link helper moving with it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { microgridHref, microgridSetupHref } from "../microgrid-links";

const getUserMock = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: getUserMock } }),
}));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  // Minimal request-time runtime configuration for the middleware (#46).
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("microgridHref", () => {
  it("is where middleware redirects /microgrids/<id>", async () => {
    vi.resetModules();
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      new NextRequest("http://localhost/microgrids/grid-1"),
    );

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      microgridHref("grid-1"),
    );
  });

  it("is a page middleware lets through without redirecting", async () => {
    vi.resetModules();
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      new NextRequest(`http://localhost${microgridHref("grid-1")}`),
    );

    expect(res.status).toBe(200);
  });
});

describe("microgridSetupHref", () => {
  it("is where the /setup index redirects", async () => {
    const { default: SetupIndexPage } = await import(
      "@/app/(dashboard)/microgrids/[id]/setup/page"
    );
    await SetupIndexPage({ params: Promise.resolve({ id: "grid-1" }) });

    expect(redirectMock).toHaveBeenCalledWith(microgridSetupHref("grid-1"));
  });

  it("is a page middleware lets through without redirecting", async () => {
    vi.resetModules();
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      new NextRequest(`http://localhost${microgridSetupHref("grid-1")}`),
    );

    expect(res.status).toBe(200);
  });
});
