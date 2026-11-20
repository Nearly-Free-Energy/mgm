/**
 * The catch-all page, "/" included: refuses a render the middleware did
 * not see, /api and unreleased paths before reading anything, checks the
 * session on its own path, and hands the decoded path, the query and the
 * caller's access to renderView with the GUI MGM_GUI selects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  getRequestUserAccess: vi.fn(),
  renderView: vi.fn<(input: { access: unknown }) => Promise<string>>(async () => "view"),
  headers: new Headers(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("@/lib/auth/request-access", () => ({ getRequestUserAccess: mocks.getRequestUserAccess }));
vi.mock("@/lib/gui/host/server/render-view", () => ({ renderView: mocks.renderView }));

import { INSTALLED_GUIS } from "@/gui/installed";
import ContributedViewPage from "../page";

const SIGNED_IN = { user: { id: "user-1" }, roles: [{ user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: "o" }] };

const visit = (path: string[], search: Record<string, string | string[] | undefined> = {}) =>
  ContributedViewPage({ params: Promise.resolve({ path }), searchParams: Promise.resolve(search) });

beforeEach(() => {
  vi.clearAllMocks();
  // What the middleware forwards (src/middleware.ts). The page does not
  // read the value, only that the middleware set it.
  mocks.headers = new Headers({ "x-mgm-path": "/microgrids/m/operations" });
  mocks.getRequestUserAccess.mockResolvedValue(SIGNED_IN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the (gui) catch-all page", () => {
  // The middleware sets x-mgm-path on every page request it passes on, and
  // a browser never sends it; without it the request reached this page
  // without the middleware, as a missing /FAVICON.ICO can on a host that
  // matches the middleware's file exclusions without regard to case.
  it.each([
    { url: "/microgrids/m/operations", path: ["microgrids", "m", "operations"], value: null },
    { url: "/FAVICON.ICO", path: ["FAVICON.ICO"], value: null },
    { url: "/microgrids/m/operations", path: ["microgrids", "m", "operations"], value: "" },
  ])("answers 404 before any read for $url with x-mgm-path $value", async ({ path, value }) => {
    mocks.headers = value === null ? new Headers() : new Headers({ "x-mgm-path": value });
    await expect(visit(path)).rejects.toThrow("not-found");
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.renderView).not.toHaveBeenCalled();
  });

  it("answers 404 for an /api path before any read, spelled plainly or encoded", async () => {
    await expect(visit(["api", "x"])).rejects.toThrow("not-found");
    await expect(visit(["%61pi", "x"])).rejects.toThrow("not-found");
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
    expect(mocks.renderView).not.toHaveBeenCalled();
  });

  it("answers 404 for a segment that does not decode, before any read", async () => {
    await expect(visit(["microgrids", "%E0%A4%A"])).rejects.toThrow("not-found");
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
  });

  it("answers 404 before any read for a static-file path, which is never released", async () => {
    // The middleware already refuses these (src/middleware.ts); this check
    // stays as a second line.
    for (const path of [["x.png"], ["icons", "x.svg"], ["gui-styles", "x.css"], ["favicon.ico"]]) {
      await expect(visit(path)).rejects.toThrow("not-found");
    }
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
    expect(mocks.renderView).not.toHaveBeenCalled();
  });

  // Next.js 16.4.1 hands catch-all segments over percent-encoded, exactly
  // one level: a request for /a%20b/c%2Fd/e%25f arrives as
  // ["a%20b", "c%2Fd", "e%25f"] (checked against `next start`). So the page
  // decodes once, and a segment holding an encoded "%" still decodes.
  it.each([
    { segment: "a%20b", id: "a b" },
    { segment: "a%2Fb", id: "a/b" },
    { segment: "a%25b", id: "a%b" },
    { segment: "a%2520b", id: "a%20b" },
  ])("decodes $segment, as Next.js passes it, once to $id", async ({ segment, id }) => {
    expect(await visit(["microgrids", segment, "operations"])).toBe("view");
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.renderView).toHaveBeenCalledWith(expect.objectContaining({ path: ["microgrids", id, "operations"] }));
  });

  it('serves "/", which arrives with no segments, as the view on "/"', async () => {
    mocks.headers = new Headers({ "x-mgm-path": "/" });
    const page = await ContributedViewPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ org: "o" }) });
    expect(page).toBe("view");
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.renderView).toHaveBeenCalledWith(expect.objectContaining({ path: [], search: { org: "o" }, access: SIGNED_IN }));
  });

  it("sends a signed-out visitor to /login without rendering a view", async () => {
    mocks.getRequestUserAccess.mockResolvedValue({ user: null, roles: [] });
    await expect(visit(["microgrids", "m", "operations"])).rejects.toThrow("redirect:/login");
    expect(mocks.renderView).not.toHaveBeenCalled();
  });

  it("hands renderView the decoded path, the query, the caller's access and the selected GUI", async () => {
    const search = { date: "2026-11-10" };
    expect(await visit(["microgrids", "a%2Fb%20c", "operations"], search)).toBe("view");
    expect(mocks.renderView).toHaveBeenCalledWith({
      path: ["microgrids", "a/b c", "operations"],
      search,
      access: SIGNED_IN,
      gui: INSTALLED_GUIS.gridtop,
    });
    expect(mocks.renderView.mock.calls[0][0].access).toBe(await mocks.getRequestUserAccess.mock.results[0].value);
  });

  it("answers with an error when MGM_GUI names no compiled-in GUI", async () => {
    vi.stubEnv("MGM_GUI", "nextgrid");
    await expect(visit(["microgrids", "m", "operations"])).rejects.toThrow(/MGM_GUI "nextgrid" names no installed GUI/);
    expect(mocks.renderView).not.toHaveBeenCalled();
  });
});
