/**
 * GET /api/gui/search: the session is checked before the query is read or
 * the GUI surface is, and every answer is uncacheable JSON.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "e7100000-0000-4000-8003-000000000001";
const ORG2 = "e7100000-0000-4000-8003-000000000002";
let user: { id: string; email: string } | null;
let roles: { role: string; scope_type: string; scope_id: string | null }[];
const client = () => {
  let table = "";
  const chain: Record<string, unknown> = {
    then: (resolve: (r: unknown) => unknown) =>
      Promise.resolve({ data: table === "organizations" ? roles.map((r, i) => ({ id: r.scope_id, name: `O${i}` })) : roles, error: null }).then(resolve),
  };
  for (const op of ["select", "eq", "returns", "order"]) chain[op] = () => chain;
  return { auth: { getUser: async () => ({ data: { user } }) }, from: (t: string) => ((table = t), chain) };
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
const surfaceSnapshot = vi.fn();
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: () => surfaceSnapshot() }));

import { GET } from "../route";

const get = (query: string) => GET(new NextRequest(`http://localhost/api/gui/search${query}`));
const MG = "e7100000-0000-4000-8002-000000000001";
const hit = { kind: "microgrid", id: MG, label: "Kiwumu", href: `/microgrids/${MG}` };
const find = vi.fn();

beforeEach(() => {
  user = { id: "e7100000-0000-4000-8003-0000000000aa", email: "m@test.local" };
  roles = [{ role: "org_manager", scope_type: "org", scope_id: ORG }];
  find.mockReset().mockResolvedValue([hit]);
  surfaceSnapshot.mockReset().mockResolvedValue({
    views: [],
    actions: new Map(),
    nav: [],
    signals: [],
    status: [],
    search: [{ plugin: "organization-directory", prefix: "@", entity: "microgrid", find }],
    entities: new Map(),
    guis: [],
  });
});

async function expectFailure(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(await res.json()).toMatchObject({ type: "result", ok: false, status, code });
}

describe("GET /api/gui/search", () => {
  it("answers 401 without a session, before reading the query or the GUI surface", async () => {
    user = null;
    await expectFailure(await get(""), 401, "gui_unauthenticated");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 403 to a person with no role", async () => {
    roles = [];
    await expectFailure(await get("?q=ki&prefix=%40"), 403, "gui_no_access");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 400 to a query out of bounds, before reading the GUI surface", async () => {
    await expectFailure(await get("?q=k&prefix=%40"), 400, "gui_bad_request");
    await expectFailure(await get("?q=ki"), 400, "gui_bad_request");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers the hits, uncached", async () => {
    const res = await get(`?q=ki&prefix=%40&org=${ORG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.json()).toEqual([hit]);
  });

  it("searches the organization ?org= names", async () => {
    roles = [ORG, ORG2].map((id) => ({ role: "org_manager", scope_type: "org", scope_id: id }));
    expect((await get(`?q=ki&prefix=%40&org=${ORG2}`)).status).toBe(200);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG2 }), "ki");
  });
});
