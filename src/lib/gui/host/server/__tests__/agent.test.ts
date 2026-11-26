/**
 * What the host gives an agent client (RFC #259 § 2, ADR-007 decisions 4
 * and 5): the organization's catalog only, a view only when it is marked
 * `agent: "read"`, nothing to prepare, and each step behind the assistant
 * plugin's gate, which refuses every step while no assistant plugin is
 * bundled. The gate, the snapshot and the clients are fakes, as in
 * catalog.test.ts and view.test.ts. Each refusal is shown to come before
 * any read where the host can refuse without one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MGM_BUNDLED_PLUGINS, type MgmPluginName } from "@/lib/plugins/bundled";
import type { ActionDef, ViewDef } from "../../../surface";
import type { RegisteredAction, RegisteredView, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", async (importOriginal) => ({
  codePrefix: (await importOriginal<typeof import("@/lib/runtime/gate")>()).codePrefix,
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: vi.fn(),
}));
let snapshot: SurfaceSnapshot;
const takeSnapshot = vi.fn(async () => snapshot);
vi.mock("../snapshot", () => ({ surfaceSnapshot: () => takeSnapshot() }));

import { ASSISTANT_NOT_INSTALLED, ASSISTANT_PLUGIN, assistantGate } from "../agent";
import { buildActionCatalog } from "../catalog";
import { prepareAction } from "../prepare";
import { dispatchView } from "../view";
import { AGENT_CALLER, ORG_A, contextFor, managerOf, tableClient, tenantOf } from "./host-fakes";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const PERSON = "e7100000-0000-4000-8fff-000000000002";
const UNIT = "e7100000-0000-4000-8005-0000000000b1";

function view(plugin: MgmPluginName, def: Partial<ViewDef> & Pick<ViewDef, "id" | "path">): RegisteredView {
  return {
    plugin,
    def: {
      kind: "metrics",
      params: {},
      cost: "db",
      declares: { keys: ["soc"] },
      examples: [{ title: `${def.id} example` }],
      load: vi.fn(async () => ({ ok: true, model: { title: "Today", actions: [], body: { tiles: [] } } })),
      ...def,
    } as unknown as ViewDef,
  };
}

const available = vi.fn(async () => ({ ok: true }));
const create: RegisteredAction = {
  plugin: "billing",
  def: {
    id: "billing.create-period",
    title: "New billing period",
    target: "microgrid",
    path: "/api/billing-periods",
    method: "POST",
    bind: { body: { microgrid_id: "microgrid" } },
    input: z.strictObject({ microgrid_id: z.uuid() }),
    inputVersion: 1,
    risk: "write",
    confirm: "confirm",
    humanOnly: false,
    repeat: "safe",
    available,
  } as unknown as ActionDef,
};

const unmarked = view("metering", { id: "metering.today", path: "/billing" });
const marked = view("metering", { id: "metering.marked", path: "/organizations", agent: "read" } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
const tenantView = view("tenant-app", { id: "tenant.home", path: "/settings/profile", scope: "tenant" } as unknown as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);

let clientsMade: number;
function agentContext(roles = [managerOf(ORG_A)]) {
  const newClient = vi.fn(async () => {
    clientsMade += 1;
    return tableClient({ organizations: { data: [{ id: ORG_A, name: "Alpha" }] } }).client as SupabaseClient;
  });
  return contextFor(roles, newClient, AGENT_CALLER);
}

beforeEach(() => {
  clientsMade = 0;
  checkGate.mockReset().mockResolvedValue({ ok: true, organizationId: ORG_A });
  available.mockClear();
  takeSnapshot.mockClear();
  snapshot = {
    views: [unmarked, marked, tenantView],
    actions: new Map([[create.def.id, create]]),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
  for (const v of snapshot.views) vi.mocked(v.def.load).mockClear();
});

describe("an agent client's catalog", () => {
  it.each([
    ["a person", "org.user", PERSON],
    ["a microgrid", "microgrid", MG],
  ] as const)("refuses entity= of %s before anything is read", async (_label, kind, id) => {
    const out = await buildActionCatalog(agentContext(), { org: null, preferred: null, entities: [{ kind, id }] });
    expect(out).toMatchObject({ ok: false, status: 403, code: "gui_agent_refused" });
    expect(takeSnapshot).not.toHaveBeenCalled();
    expect(clientsMade).toBe(0);
  });

  it("asks the assistant plugin's gate for the organization, which refuses while none is installed, before any action's gate or available()", async () => {
    const out = await buildActionCatalog(agentContext(), { org: ORG_A, preferred: null, entities: [] });
    expect(out).toEqual(ASSISTANT_NOT_INSTALLED);
    expect(checkGate).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();
  });

  it("gives a person whose rows are all tenant rows a 404 rather than an empty catalog, reading nothing", async () => {
    const out = await buildActionCatalog(agentContext([tenantOf(UNIT)]), { org: null, preferred: null, entities: [] });
    expect(out).toMatchObject({ ok: false, status: 404 });
    expect(clientsMade).toBe(0);
  });

  it("is still the whole catalog for the same person's browser session", async () => {
    const browser = contextFor([managerOf(ORG_A)], async () => tableClient({ organizations: { data: [{ id: ORG_A, name: "Alpha" }] } }).client);
    const out = await buildActionCatalog(browser, { org: ORG_A, preferred: null, entities: [] });
    expect(out).toMatchObject({ ok: true, value: { org: ORG_A, actions: [{ id: "billing.create-period" }] } });
  });
});

describe("an agent client's views", () => {
  it.each([
    ["an unmarked view", "/billing?org=" + ORG_A, unmarked],
    ["a tenant view", "/settings/profile", tenantView],
  ] as const)("answers %s as a page that does not exist, before any read", async (_label, href, registered) => {
    const out = await dispatchView(agentContext(), href);
    expect(out).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(registered.def.load).not.toHaveBeenCalled();
    expect(clientsMade).toBe(0);
  });

  it("asks the assistant plugin's gate for a marked view's organization, before the view's own gate or loader", async () => {
    const out = await dispatchView(agentContext(), `/organizations?org=${ORG_A}`);
    expect(out).toEqual(ASSISTANT_NOT_INSTALLED);
    expect(marked.def.load).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("still loads an unmarked view for a browser session", async () => {
    const browser = contextFor([managerOf(ORG_A)], async () => tableClient({ organizations: { data: [{ id: ORG_A, name: "Alpha" }] } }).client);
    const out = await dispatchView(browser, `/billing?org=${ORG_A}`);
    expect(out).toMatchObject({ ok: true, value: { view: "metering.today" } });
  });
});

describe("an agent client and prepare", () => {
  it("is refused before the body or the surface is read", async () => {
    const out = await prepareAction(agentContext(), { action: "billing.create-period", params: { microgrid_id: MG } });
    expect(out).toMatchObject({ ok: false, status: 403, code: "gui_agent_refused" });
    expect(takeSnapshot).not.toHaveBeenCalled();
    expect(clientsMade).toBe(0);
  });
});

describe("the assistant plugin's gate", () => {
  it("refuses every agent step while no assistant plugin is bundled", async () => {
    expect(await assistantGate(agentContext(), ORG_A)).toEqual(ASSISTANT_NOT_INSTALLED);
    expect(checkGate).not.toHaveBeenCalled();
  });

  // When this fails, an assistant plugin has been bundled and assistantGate
  // now asks its gate (agent-gate.test.ts checks how). Before it lets an
  // agent step through, settle what a marked view gives an agent client
  // beyond its own model: its actions, and the views attached to or
  // embedded in it (ADR-007 decision 7; dispatchView in ../view.ts loads
  // them for any caller today). Then replace this test with ones for that.
  it("is not yet bundled, so no agent step reaches a loader", () => {
    expect(MGM_BUNDLED_PLUGINS.map((p) => p.name as string)).not.toContain(ASSISTANT_PLUGIN);
  });
});
