/**
 * GET /api/gui/signals: the session is checked before the GUI surface is
 * read, and every answer is uncacheable JSON.
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

const get = (query = "") => GET(new NextRequest(`http://localhost/api/gui/signals${query}`));

beforeEach(() => {
  user = { id: "e7100000-0000-4000-8003-0000000000aa", email: "m@test.local" };
  roles = [{ role: "org_manager", scope_type: "org", scope_id: ORG }];
  surfaceSnapshot.mockReset().mockResolvedValue({
    views: [],
    actions: new Map(),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  });
});

async function expectFailure(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  expect(await res.json()).toMatchObject({ type: "result", ok: false, status, code });
}

describe("GET /api/gui/signals", () => {
  it("answers 401 without a session, before reading the GUI surface", async () => {
    user = null;
    await expectFailure(await get(`?org=${ORG}`), 401, "gui_unauthenticated");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 403 to a person with no role", async () => {
    roles = [];
    await expectFailure(await get(), 403, "gui_no_access");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers the organization's signals, uncached", async () => {
    const res = await get(`?org=${ORG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.json()).toEqual({ type: "signals", org: ORG, count: 0, top: [], checked: [], unchecked: [] });
  });

  it("collects for the organization ?org= names", async () => {
    roles = [ORG, ORG2].map((id) => ({ role: "org_manager", scope_type: "org", scope_id: id }));
    expect(await (await get(`?org=${ORG2}`)).json()).toMatchObject({ type: "signals", org: ORG2 });
  });
});
