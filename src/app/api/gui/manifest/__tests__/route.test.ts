/**
 * GET /api/gui/manifest: the session is checked before the query or the GUI
 * surface is read, a bad query is a 400, the hints reach serveManifest as
 * the (gui) layout passes them, and every answer is uncacheable JSON.
 * manifest.test.ts (src/lib/gui/host/server/__tests__) covers serveManifest
 * and buildManifest, and manifest.db.test.ts here runs the route against a
 * database.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "e7100000-0000-4000-8003-000000000001";
const ORG2 = "e7100000-0000-4000-8003-000000000002";
let user: { id: string; email: string } | null;
let roles: { role: string; scope_type: string; scope_id: string | null }[];
const client = () => {
  const chain: Record<string, unknown> = {
    then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: roles, error: null }).then(resolve),
  };
  for (const op of ["select", "eq", "returns", "order"]) chain[op] = () => chain;
  return { auth: { getUser: async () => ({ data: { user } }) }, from: () => chain };
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
const surfaceSnapshot = vi.fn();
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: () => surfaceSnapshot() }));
const serveManifest = vi.fn();
vi.mock("@/lib/gui/host/server/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gui/host/server/manifest")>()),
  serveManifest: (...args: unknown[]) => serveManifest(...args),
}));

import { GET } from "../route";

const get = (query = "", cookie?: string) =>
  GET(new NextRequest(`http://localhost/api/gui/manifest${query}`, cookie ? { headers: { cookie } } : undefined));
const MANIFEST = { type: "manifest", gui: "gridtop" };

beforeEach(() => {
  user = { id: "e7100000-0000-4000-8003-0000000000aa", email: "m@test.local" };
  roles = [{ role: "org_manager", scope_type: "org", scope_id: ORG }];
  surfaceSnapshot.mockReset();
  serveManifest.mockReset().mockResolvedValue({ ok: true, value: MANIFEST });
});

async function expectFailure(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(await res.json()).toMatchObject({ type: "result", ok: false, status, code });
}

describe("GET /api/gui/manifest", () => {
  it("answers 401 without a session, before reading the query or the GUI surface", async () => {
    user = null;
    await expectFailure(await get("?bad=1"), 401, "gui_unauthenticated");
    expect(serveManifest).not.toHaveBeenCalled();
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 403 to a person with no role", async () => {
    roles = [];
    await expectFailure(await get("?bad=1"), 403, "gui_no_access");
    expect(serveManifest).not.toHaveBeenCalled();
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 400 for a query it does not take", async () => {
    await expectFailure(await get("?gui=gridtop"), 400, "gui_bad_request");
    await expectFailure(await get(`?path=${encodeURIComponent("//evil.example/x")}`), 400, "gui_bad_request");
    await expectFailure(await get("?path=/api/gui/view"), 400, "gui_bad_request");
    expect(serveManifest).not.toHaveBeenCalled();
  });

  it("passes the path, the organization asked for and the last used one, and answers uncached", async () => {
    const path = `/?org=${ORG2}`;
    const res = await get(`?path=${encodeURIComponent(path)}`, `mgm-org=${ORG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.json()).toEqual(MANIFEST);
    expect(serveManifest).toHaveBeenCalledWith(expect.anything(), { path, requested: ORG2, preferred: ORG });
    await get(`?org=${ORG}`);
    expect(serveManifest).toHaveBeenLastCalledWith(expect.anything(), { path: null, requested: ORG, preferred: null });
  });

  it("passes a refusal on in the host's failure shape", async () => {
    serveManifest.mockResolvedValue({ ok: false, status: 500, code: "gui_manifest_failed", message: "The manifest could not be built." });
    await expectFailure(await get(), 500, "gui_manifest_failed");
  });
});
