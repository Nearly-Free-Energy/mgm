/**
 * The GUI host's routes and an agent client (RFC #259 § 2): every route but
 * the catalog and the view route refuses it, after the session check and
 * before it reads its query, body or the GUI surface; those two take it in
 * and give it less (src/lib/gui/host/server/__tests__/agent.test.ts). This
 * is the host's own fence: middleware refuses the same requests first
 * (middleware.test.ts).
 *
 * The client is stood in, recorded as the caller each case names, as
 * createClient records a client built on a bearer token. The view route's
 * cases are the part of the agent refusal that
 * src/lib/runtime/__tests__/bearer-session.db.test.ts cannot reach yet: there
 * a real agent token reaches this route as an agent client, but until #274
 * creates the `mgm_agent` role no role rows are read for it, so the route
 * refuses it with 403 `gui_no_access` before any view is looked up. When
 * #274 lands, that file can expect these answers end to end.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordCaller, type Caller } from "@/lib/runtime/caller";

const ORG = "e7100000-0000-4000-8003-000000000001";
let caller: Caller;
let getUserCalls: number;
/** What each table answers: the person's role rows and the organization they manage. */
const ROWS: Record<string, unknown[]> = {
  user_roles: [{ role: "org_manager", scope_type: "org", scope_id: ORG }],
  organizations: [{ id: ORG, name: "Org" }],
};
const client = () => {
  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {
      then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: ROWS[table] ?? [], error: null }).then(resolve),
    };
    for (const op of ["select", "eq", "returns", "order"]) chain[op] = () => chain;
    return chain;
  };
  const made = {
    auth: {
      getUser: async () => {
        getUserCalls += 1;
        return { data: { user: { id: "e7100000-0000-4000-8003-0000000000aa", email: "m@test.local" } } };
      },
    },
    from: (table: string) => chainFor(table),
  };
  recordCaller(made, caller);
  return made;
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
const surfaceSnapshot = vi.fn();
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: () => surfaceSnapshot() }));
// The plugin gate answers on for every plugin, so a view's own gate never
// refuses: any refusal below is the agent's.
const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime/gate")>()),
  checkGate: (...args: unknown[]) => checkGate(...args),
}));

import { GET as catalog } from "../catalog/route";
import { GET as manifest } from "../manifest/route";
import { POST as prepare } from "../prepare/route";
import { GET as search } from "../search/route";
import { GET as signals } from "../signals/route";
import { GET as view } from "../view/route";

const AGENT: Caller = { kind: "agent", clientId: "e7100000-0000-4000-8fff-0000000000c1" };
const OPERATOR: Caller = { kind: "operator", clientId: "e7100000-0000-4000-8fff-0000000000c2" };
const at = (path: string, init?: { method: string; body: string }) => new NextRequest(`http://localhost${path}`, init);

/** A metrics view of the metering plugin on `path`, marked for an assistant when `agent` is "read". */
function viewOn(id: string, path: string, agent?: "read") {
  return {
    plugin: "metering",
    def: {
      id,
      path,
      kind: "metrics",
      params: {},
      cost: "db",
      declares: { keys: ["soc"] },
      examples: [{ title: `${id} example` }],
      ...(agent ? { agent } : {}),
      load: vi.fn(async () => ({ ok: true, model: { title: "Today", actions: [], body: { tiles: [] } } })),
    },
  };
}
const unmarked = viewOn("metering.unmarked", "/billing");
const marked = viewOn("metering.marked", "/organizations", "read");

beforeEach(() => {
  caller = AGENT;
  getUserCalls = 0;
  checkGate.mockReset().mockResolvedValue({ ok: true, organizationId: ORG });
  unmarked.def.load.mockClear();
  marked.def.load.mockClear();
  surfaceSnapshot.mockReset().mockResolvedValue({
    views: [unmarked, marked],
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

  it("lets it into the view route, which answers a view not marked for an assistant as a page that does not exist", async () => {
    const res = await view(at(`/api/gui/view?href=${encodeURIComponent(`/billing?org=${ORG}`)}`));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "gui_not_found" });
    expect(unmarked.def.load).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("refuses it a marked view at the assistant gate, which refuses while no assistant plugin is installed, before the view's gate or loader", async () => {
    const res = await view(at(`/api/gui/view?href=${encodeURIComponent(`/organizations?org=${ORG}`)}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, status: 409, code: "assistant_disabled" });
    expect(marked.def.load).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("loads the same views for an operator client, which holds the person's access", async () => {
    caller = OPERATOR;
    for (const [href, def] of [
      [`/billing?org=${ORG}`, unmarked.def],
      [`/organizations?org=${ORG}`, marked.def],
    ] as const) {
      const res = await view(at(`/api/gui/view?href=${encodeURIComponent(href)}`));
      expect(res.status, href).toBe(200);
      expect(def.load).toHaveBeenCalledOnce();
    }
  });

  it("does not refuse an operator client, which holds the person's access", async () => {
    caller = OPERATOR;
    const res = await signals(at(`/api/gui/signals?org=${ORG}`));
    expect(await res.json()).not.toMatchObject({ code: "gui_agent_refused" });
    caller = AGENT;
    expect(await (await signals(at(`/api/gui/signals?org=${ORG}`))).json()).toMatchObject({ code: "gui_agent_refused" });
  });
});
