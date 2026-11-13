/**
 * The catch-all page: refuses /api and unreleased paths before reading anything, checks the
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
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@/lib/auth/request-access", () => ({ getRequestUserAccess: mocks.getRequestUserAccess }));
vi.mock("@/lib/gui/host/server/render-view", () => ({ renderView: mocks.renderView }));

import { INSTALLED_GUIS } from "@/gui/installed";
import ContributedViewPage from "../page";

const SIGNED_IN = { user: { id: "user-1" }, roles: [{ user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: "o" }] };

const visit = (path: string[], search: Record<string, string | string[] | undefined> = {}) =>
  ContributedViewPage({ params: Promise.resolve({ path }), searchParams: Promise.resolve(search) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRequestUserAccess.mockResolvedValue(SIGNED_IN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the (gui) catch-all page", () => {
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

  it("answers 404 before any read for a static-file path the middleware skips, which is never released", async () => {
    for (const path of [["x.png"], ["icons", "x.svg"], ["gui-styles", "x.css"], ["favicon.ico"]]) {
      await expect(visit(path)).rejects.toThrow("not-found");
    }
    expect(mocks.getRequestUserAccess).not.toHaveBeenCalled();
    expect(mocks.renderView).not.toHaveBeenCalled();
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
