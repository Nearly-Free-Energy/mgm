/**
 * GET /api/gui/view: the session is checked before the GUI surface is read,
 * every answer is uncacheable JSON, and with no capability contributing a
 * view yet every href is a 404.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { GET } from "../route";

const ORG = "e7100000-0000-4000-8003-000000000001";
const get = (query: string) => GET(new NextRequest(`http://localhost/api/gui/view${query}`));

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

describe("GET /api/gui/view", () => {
  it("answers 401 without a session, before reading the GUI surface", async () => {
    user = null;
    await expectFailure(await get(`?href=/microgrids/${ORG}/operations`), 401, "gui_unauthenticated");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 401 without a session even when the href is missing", async () => {
    user = null;
    await expectFailure(await get(""), 401, "gui_unauthenticated");
  });

  it("answers 403 to a person with no role", async () => {
    roles = [];
    await expectFailure(await get("?href=/organizations"), 403, "gui_no_access");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 400 without an href", async () => {
    await expectFailure(await get(""), 400, "gui_bad_request");
  });

  it("answers 404 for a page no view serves", async () => {
    await expectFailure(await get(`?href=${encodeURIComponent(`/microgrids/${ORG}/operations?date=2026-11-08`)}`), 404, "gui_not_found");
    expect(surfaceSnapshot).toHaveBeenCalledOnce();
  });
});
