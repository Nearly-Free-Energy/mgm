/**
 * Every page under src/app/(gui), called as the server renders it for a
 * client-side navigation: the page alone, without the (gui) layout, which
 * App Router skips then (CLAUDE.md, "Session checks before privilege"). A
 * person whose rows are all tenant rows is redirected from every page that
 * is not a tenant page before the page opens a Supabase client or loads a
 * view (keepTenantOnlyToTenantPages, mgm#209). A new page.tsx is found here
 * by the glob below, so it fails until it makes that call first.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import { resetMgmRuntimeForTests } from "@/lib/runtime/root";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  getRequestUserAccess: vi.fn(),
  isReleasedRoute: vi.fn<(path: string) => boolean>(() => true),
  read: vi.fn(() => {
    throw new Error("read");
  }),
  renderView: vi.fn(async () => "view"),
  headers: new Headers(),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: mocks.redirect,
  notFound: mocks.notFound,
}));
vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("@/lib/auth/request-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-access")>()),
  getRequestUserAccess: mocks.getRequestUserAccess,
}));
// Every page under the middleware's release allowlist, so each one reaches
// its own checks; the home's release is set per test.
vi.mock("@/lib/mgm/released-routes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mgm/released-routes")>()),
  isReleasedRoute: mocks.isReleasedRoute,
}));
// A page that gets past the check opens a Supabase client or loads a view;
// either one is recorded and stops the page there.
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.read }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.read }));
vi.mock("@/lib/gui/host/server/render-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gui/host/server/render-view")>()),
  renderView: mocks.renderView,
}));

import { TENANT_START_PAGE } from "@/lib/gui/host/shared/tenant-units";

type Page = (props: { params: Promise<Record<string, unknown>>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;

const PAGE_FILES = import.meta.glob<{ default: Page }>("../**/page.tsx");

const UNIT = "e7300000-0000-4000-8003-000000000001";
const ID = "e7300000-0000-4000-8004-000000000001";
const ORG = "e7300000-0000-4000-8000-000000000001";
const tenantRows = [{ user_id: "user-1", role: "tenant", scope_type: "tenant", scope_id: UNIT }];
const staffAndTenantRows = [...tenantRows, { user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: ORG }];

/** A page file's URL pattern: "../microgrids/[id]/page.tsx" → "/microgrids/[id]". */
const patternOf = (file: string) => `/${file.replace(/^\.\.\//, "").replace(/\/?page\.tsx$/, "")}`.replace(/\/\([^)]*\)/g, "");

const CATCH_ALL = "/[...path]";
const HOST_PAGES = Object.keys(PAGE_FILES).map(patternOf).filter((p) => p !== CATCH_ALL).sort();
// The catch-all serves every page the catalog has a view serve; it is
// called once for each, as its own path.
const VIEW_PAGES = MGM_BUNDLED_PLUGINS.flatMap((plugin) => plugin.pages)
  .filter((page) => page.servedBy === "view")
  .map((page) => page.path)
  .sort();
const STAFF_VIEW_PAGES = VIEW_PAGES.filter((page) => page !== TENANT_START_PAGE);

const sample = (pattern: string) => pattern.replace(/\[([^\]]+)\]/g, (_, name: string) => (name === "nav" ? "billing.periods" : ID));

/**
 * What the page answers for `roles` at `pattern`: "redirect:<to>",
 * "not-found", "read" when it opened a client, "view" when it loaded a view,
 * or "rendered".
 */
async function answer(pattern: string, roles: unknown[], viaCatchAll = false): Promise<string> {
  const path = sample(pattern);
  mocks.getRequestUserAccess.mockResolvedValue({ user: { id: "user-1" }, roles });
  mocks.headers = new Headers({ "x-mgm-path": path });
  const file = viaCatchAll ? "../[...path]/page.tsx" : Object.keys(PAGE_FILES).find((f) => patternOf(f) === pattern)!;
  const { default: Page } = await PAGE_FILES[file]();
  const params: Record<string, unknown> = viaCatchAll
    ? { path: path.split("/").filter(Boolean) }
    : Object.fromEntries([...pattern.matchAll(/\[([^\]]+)\]/g)].map(([, name]) => [name, name === "nav" ? "billing.periods" : ID]));
  try {
    const out = await Page({ params: Promise.resolve(params), searchParams: Promise.resolve({}) });
    return out === "view" ? "view" : "rendered";
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("redirect:") || message === "not-found" || message === "read") return message;
    throw error;
  }
}

beforeEach(() => {
  mocks.redirect.mockClear();
  mocks.read.mockClear();
  mocks.renderView.mockClear();
  mocks.getRequestUserAccess.mockReset();
  mocks.isReleasedRoute.mockImplementation(() => true);
});

afterAll(async () => {
  await resetMgmRuntimeForTests();
});

describe("Every page under (gui) keeps a person whose rows are all tenant rows to tenant pages (mgm#209)", () => {
  it("finds the host's pages and the catalog's view pages", () => {
    expect(HOST_PAGES).toEqual(expect.arrayContaining(["/", "/go/[nav]", "/settings/users", "/microgrids/[id]/billing"]));
    expect(HOST_PAGES.length).toBeGreaterThan(20);
    expect(VIEW_PAGES).toContain(TENANT_START_PAGE);
    expect(STAFF_VIEW_PAGES).not.toHaveLength(0);
  });

  it.each(HOST_PAGES)("%s sends them home before it opens a client", async (page) => {
    expect(await answer(page, tenantRows)).toBe(`redirect:${TENANT_START_PAGE}`);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(STAFF_VIEW_PAGES)("the catch-all sends them home from %s before it loads the view", async (page) => {
    expect(await answer(page, tenantRows, true)).toBe(`redirect:${TENANT_START_PAGE}`);
    expect(mocks.renderView).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("the catch-all loads a tenant view's page for them", async () => {
    expect(await answer(TENANT_START_PAGE, tenantRows, true)).toBe("view");
  });

  it.each(HOST_PAGES)("%s sends them to /no-access, which can sign them out, while their home is not released", async (page) => {
    mocks.isReleasedRoute.mockImplementation((path: string) => path !== TENANT_START_PAGE);
    expect(await answer(page, tenantRows)).toBe("redirect:/no-access");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(HOST_PAGES)("%s is left to its own checks for a person with staff and tenant rows", async (page) => {
    const out = await answer(page, staffAndTenantRows);
    expect(out).not.toBe(`redirect:${TENANT_START_PAGE}`);
    expect(out).not.toBe("redirect:/no-access");
  });

  it.each(STAFF_VIEW_PAGES)("the catch-all loads %s for a person with staff and tenant rows", async (page) => {
    expect(await answer(page, staffAndTenantRows, true)).toBe("view");
  });

  it.each(HOST_PAGES)("%s answers 404 for a render the middleware did not see, before it reads the user", async (page) => {
    mocks.headers = new Headers();
    const file = Object.keys(PAGE_FILES).find((f) => patternOf(f) === page)!;
    const { default: Page } = await PAGE_FILES[file]();
    await expect(Page({ params: Promise.resolve({ id: ID, periodId: ID, edgeId: ID, tenantId: ID, nav: "billing.periods" }), searchParams: Promise.resolve({}) })).rejects.toThrow("not-found");
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
