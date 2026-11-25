/**
 * GET /api/gui/catalog: the session is checked before the query or the GUI
 * surface is read, a bad query is a 400, a person whose rows are all tenant
 * rows gets no actions without the gate being asked, and every answer is
 * uncacheable JSON. catalog.test.ts (src/lib/gui/host/server/__tests__)
 * covers the catalog itself, and catalog.db.test.ts runs it against a
 * database.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "e7100000-0000-4000-8003-000000000001";
const ORG2 = "e7100000-0000-4000-8003-000000000002";
const UNIT = "e7100000-0000-4000-8003-0000000000c1";
let user: { id: string; email: string } | null;
let roles: { role: string; scope_type: string; scope_id: string | null }[];
const client = () => {
  let table = "";
  const chain: Record<string, unknown> = {
    then: (resolve: (r: unknown) => unknown) =>
      Promise.resolve({
        data: table === "organizations" ? roles.filter((r) => r.scope_type === "org").map((r, i) => ({ id: r.scope_id, name: `O${i}` })) : roles,
        error: null,
      }).then(resolve),
  };
  for (const op of ["select", "eq", "returns", "order"]) chain[op] = () => chain;
  return { auth: { getUser: async () => ({ data: { user } }) }, from: (t: string) => ((table = t), chain) };
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
const surfaceSnapshot = vi.fn();
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: () => surfaceSnapshot() }));
const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", async (importOriginal) => ({
  codePrefix: (await importOriginal<typeof import("@/lib/runtime/gate")>()).codePrefix,
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: vi.fn(),
}));

import { GET } from "../route";

const get = (query = "", cookie?: string) =>
  GET(new NextRequest(`http://localhost/api/gui/catalog${query}`, cookie ? { headers: { cookie } } : undefined));

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
  checkGate.mockReset().mockResolvedValue({ ok: true, organizationId: ORG });
});

async function expectFailure(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  const body = await res.json();
  expect(body).toMatchObject({ type: "result", ok: false, status, code });
  // The { error, code } shape of MGM's other routes, beside ActionResult's.
  expect(body.error).toBe(body.message);
}

describe("GET /api/gui/catalog", () => {
  it("answers 401 without a session, before reading the query or the GUI surface", async () => {
    user = null;
    await expectFailure(await get("?bad=1"), 401, "gui_unauthenticated");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 403 to a person with no role", async () => {
    roles = [];
    await expectFailure(await get("?bad=1"), 403, "gui_no_access");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers 400 for a query it does not take, before reading the GUI surface", async () => {
    await expectFailure(await get("?organization=x"), 400, "gui_bad_request");
    await expectFailure(await get(`?org=${ORG}&entity=billingPeriod:${UNIT}`), 400, "gui_bad_request");
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("answers the organization's catalog, uncached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.json()).toEqual({ type: "catalog", contract: "0.2.1", org: ORG, entities: [], actions: [] });
  });

  it("answers for the organization org names, else the last used one", async () => {
    roles = [ORG, ORG2].map((id) => ({ role: "org_manager", scope_type: "org", scope_id: id }));
    expect(await (await get(`?org=${ORG2}`)).json()).toMatchObject({ org: ORG2 });
    expect(await (await get("", `mgm-org=${ORG2}`)).json()).toMatchObject({ org: ORG2 });
    roles = [{ role: "org_manager", scope_type: "org", scope_id: ORG }];
    await expectFailure(await get(`?org=${ORG2}`), 404, "gui_not_found");
  });

  it("gives a person whose rows are all tenant rows no actions, without asking the gate", async () => {
    roles = [{ role: "tenant", scope_type: "tenant", scope_id: UNIT }];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "catalog", contract: "0.2.1", org: null, entities: [], actions: [] });
    expect(checkGate).not.toHaveBeenCalled();
    expect(surfaceSnapshot).not.toHaveBeenCalled();
    await expectFailure(await get(`?entity=tenant:${UNIT}`), 404, "gui_not_found");
  });
});
