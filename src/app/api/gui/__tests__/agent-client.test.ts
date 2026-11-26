/**
 * The GUI host's routes and an agent client (RFC #259 § 2): every route but
 * the catalog and the view route refuses it, after the session check and
 * before it reads its query, body or the GUI surface; those two take it in
 * and give it less (src/lib/gui/host/server/__tests__/agent.test.ts). This
 * is the host's own fence: middleware refuses the same requests first
 * (middleware.test.ts).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordCaller, type Caller } from "@/lib/runtime/caller";

const ORG = "e7100000-0000-4000-8003-000000000001";
let caller: Caller;
let getUserCalls: number;
const client = () => {
  const chain: Record<string, unknown> = {
    then: (resolve: (r: unknown) => unknown) =>
      Promise.resolve({ data: [{ role: "org_manager", scope_type: "org", scope_id: ORG }], error: null }).then(resolve),
  };
  for (const op of ["select", "eq", "returns", "order"]) chain[op] = () => chain;
  const made = {
    auth: {
      getUser: async () => {
        getUserCalls += 1;
        return { data: { user: { id: "e7100000-0000-4000-8003-0000000000aa", email: "m@test.local" } } };
      },
    },
    from: () => chain,
  };
  recordCaller(made, caller);
  return made;
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
const surfaceSnapshot = vi.fn();
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: () => surfaceSnapshot() }));

import { GET as catalog } from "../catalog/route";
import { GET as manifest } from "../manifest/route";
import { POST as prepare } from "../prepare/route";
import { GET as search } from "../search/route";
import { GET as signals } from "../signals/route";
import { GET as view } from "../view/route";

const AGENT: Caller = { kind: "agent", clientId: "e7100000-0000-4000-8fff-0000000000c1" };
const OPERATOR: Caller = { kind: "operator", clientId: "e7100000-0000-4000-8fff-0000000000c2" };
const at = (path: string, init?: { method: string; body: string }) => new NextRequest(`http://localhost${path}`, init);

beforeEach(() => {
  caller = AGENT;
  getUserCalls = 0;
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

describe("the GUI host's routes and an agent client", () => {
  it.each([
    ["POST /api/gui/prepare", () => prepare(at("/api/gui/prepare", { method: "POST", body: JSON.stringify({ action: "a.b", params: {} }) }))],
    ["GET /api/gui/search", () => search(at("/api/gui/search?q=ki"))],
    ["GET /api/gui/signals", () => signals(at(`/api/gui/signals?org=${ORG}`))],
    ["GET /api/gui/manifest", () => manifest(at("/api/gui/manifest?path=%2F"))],
  ])("%s refuses it after the session check, before the surface is read", async (_label, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.json()).toMatchObject({ ok: false, status: 403, code: "gui_agent_refused" });
    expect(getUserCalls).toBe(1);
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("lets it into the catalog, which refuses entity= before the surface is read", async () => {
    const res = await catalog(at(`/api/gui/catalog?entity=microgrid:${ORG}`));
    expect(await res.json()).toMatchObject({ status: 403, code: "gui_agent_refused" });
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("lets it into the view route, which answers a view it may not read as a page that does not exist", async () => {
    const res = await view(at("/api/gui/view?href=%2Fbilling"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "gui_not_found" });
  });

  it("does not refuse an operator client, which holds the person's access", async () => {
    caller = OPERATOR;
    const res = await signals(at(`/api/gui/signals?org=${ORG}`));
    expect(await res.json()).not.toMatchObject({ code: "gui_agent_refused" });
    caller = AGENT;
    expect(await (await signals(at(`/api/gui/signals?org=${ORG}`))).json()).toMatchObject({ code: "gui_agent_refused" });
  });
});
