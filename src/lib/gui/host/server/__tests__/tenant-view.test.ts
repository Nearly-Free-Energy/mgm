/**
 * dispatchView for a tenant view (scope "tenant", RFC mgm#197 § 4): the unit
 * is chosen among the person's own tenant rows, the loader runs on its own
 * client with a TenantRequest, and the host reads nothing of an organization,
 * asks no gate and offers no action.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { ActionDef, TenantRequest, ViewDef } from "../../../surface";
import type { RegisteredAction, RegisteredView, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { dispatchView } from "../view";
import { ORG_A, contextFor, managerOf, superAdmin, tableClient, tenantOf } from "./host-fakes";

const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
const UNIT_B = "e7400000-0000-4000-8000-00000000000b";
const CANARY = "CANARY-7f3a91";

const record = (label = "Unit 4") => ({
  title: "Example tenant",
  entity: { kind: "tenant", id: UNIT_A, label: "Example tenant" },
  actions: [],
  body: { sections: [{ fields: [{ key: "unit", label: "Unit", value: { t: "text", text: label } }] }] },
});

let home: RegisteredView;
let roles: UserRoleRecord[];
let clients: SupabaseClient[];

/** Another plugin's action on the tenant kind, which a staff view would offer on its entity. */
const editTenant: RegisteredAction = {
  plugin: "community-management",
  def: {
    id: "community.edit-tenant",
    title: "Edit tenant",
    target: "tenant",
    input: z.object({}),
    inputVersion: 1,
    path: "/api/tenants/[id]",
    method: "PATCH",
    bind: { path: { id: "tenant" } },
    risk: "write",
    confirm: "confirm",
    humanOnly: false,
    repeat: "safe",
  } as unknown as ActionDef,
};

function ctx() {
  const newClient = vi.fn(async () => {
    const { client } = tableClient({});
    clients.push(client);
    return client;
  });
  return contextFor(roles, newClient);
}
const dispatch = (href: string, depth?: 0 | 1) => dispatchView(ctx(), href, { depth });
const load = () => home.def.load as unknown as ReturnType<typeof vi.fn>;
const requestOf = (call = 0) => load().mock.calls[call][0] as TenantRequest;

beforeEach(() => {
  clients = [];
  roles = [tenantOf(UNIT_A)];
  home = {
    plugin: "tenant-app",
    def: {
      id: "tenant.home",
      kind: "record",
      scope: "tenant",
      path: "/my",
      params: {},
      query: ["month"],
      cost: "db",
      declares: { keys: ["unit"] },
      examples: [],
      load: vi.fn(async () => ({ ok: true, model: record() })),
    } as unknown as ViewDef,
  };
  snapshot = {
    views: [home],
    actions: new Map([[editTenant.def.id, editTenant]]),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
  checkGate.mockReset();
  resolveTargetOrganization.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("dispatchView for a tenant view", () => {
  it("serves the person's only unit, with no organization, trail, attachments or actions", async () => {
    const out = await dispatch(`/my?month=2026-11&org=${ORG_A}&ui.tab=x`);
    expect(out).toEqual({
      ok: true,
      value: {
        ...record(),
        type: "view",
        view: "tenant.home",
        kind: "record",
        org: null,
        trail: [],
        links: [],
        attached: [],
      },
    });
    const req = requestOf();
    expect(req.tenantId).toBe(UNIT_A);
    expect(req.organizationId).toBeNull();
    expect(req.params).toEqual({});
    expect([...req.search]).toEqual([["month", "2026-11"]]);
    expect(clients.filter((c) => c === req.supabase)).toHaveLength(1);
  });

  it("reads no organization and asks no gate: the loader's composer does", async () => {
    await dispatch("/my");
    expect(resolveTargetOrganization).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("offers no action, neither one the loader links nor one another plugin targets at the unit", async () => {
    load().mockResolvedValue({ ok: true, model: { ...record(), actions: [{ action: "community.edit-tenant", params: { id: UNIT_A } }] } });
    const out = await dispatch("/my");
    expect(out).toMatchObject({ ok: true, value: { actions: [] } });
  });

  it("serves the unit `unit` names among the person's units, in any case", async () => {
    roles = [tenantOf(UNIT_A), tenantOf(UNIT_B), managerOf(ORG_A)];
    expect(await dispatch(`/my?unit=${UNIT_B.toUpperCase()}`)).toMatchObject({ ok: true });
    expect(requestOf().tenantId).toBe(UNIT_B);
  });

  it("asks a person with several units which one, without loading", async () => {
    roles = [tenantOf(UNIT_A), tenantOf(UNIT_B)];
    expect(await dispatch("/my")).toEqual({
      ok: false,
      status: 400,
      code: "gui_unit_required",
      message: "Choose which of your units to show.",
    });
    expect(load()).not.toHaveBeenCalled();
  });

  it.each([
    ["a unit that is not the person's", () => `/my?unit=${UNIT_B}`],
    ["two units at once", () => ((roles = [tenantOf(UNIT_A), tenantOf(UNIT_B)]), `/my?unit=${UNIT_A}&unit=${UNIT_B}`)],
    ["an org manager with no unit", () => ((roles = [managerOf(ORG_A)]), "/my")],
    ["a super admin with no unit", () => ((roles = [superAdmin()]), "/my")],
    ["a manager naming a unit of their organization", () => ((roles = [managerOf(ORG_A)]), `/my?unit=${UNIT_A}`)],
  ])("answers %s with not found, without loading", async (_name, arrange) => {
    expect(await dispatch(arrange())).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(load()).not.toHaveBeenCalled();
  });

  it("is never loaded inside another view", async () => {
    expect(await dispatch("/my", 1)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(load()).not.toHaveBeenCalled();
  });

  it("answers the tenant app being off for the unit's organization as a page outside the release", async () => {
    // RFC mgm#197 § 3: the tenant sees what an unreleased path shows, not
    // the loader's 409 about a setting they cannot change.
    load().mockResolvedValue({ ok: false, status: 409, message: "The tenant app is not turned on for your unit yet." });
    expect(await dispatch("/my")).toEqual({
      ok: false,
      status: 404,
      code: "gui_not_released",
      message: "This page is not part of the MGM release installed here.",
    });
  });

  it.each([
    [403, "Your session has ended. Sign in again to see your unit."],
    [404, "This unit could not be found."],
    [503, "Your unit could not be loaded right now. Try again shortly."],
  ])("passes the loader's other refusals on (%i)", async (status, message) => {
    load().mockResolvedValue({ ok: false, status, message });
    expect(await dispatch("/my")).toEqual({
      ok: false,
      status,
      code: status === 404 ? "gui_not_found" : "gui_view_refused",
      message,
    });
  });

  it.each([
    ["throws", () => Promise.reject(new Error(CANARY)), "gui_view_failed"],
    ["returns an undeclared key", async () => ({ ok: true, model: { ...record(), [CANARY]: 1 } }), "gui_output_invalid"],
    ["returns an organization", async () => ({ ok: true, model: { ...record(), org: ORG_A } }), "gui_output_invalid"],
  ])("answers a loader that %s with a host error and none of its values", async (_name, impl, code) => {
    load().mockImplementation(impl);
    const out = await dispatch("/my");
    expect(out).toMatchObject({ ok: false, status: 500, code });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
});

describe("dispatchView for a person whose rows are all tenant rows", () => {
  // Every view but a tenant view is staff's. A tenant-only person gets the
  // answer a page that does not exist gets, before any read, gate or loader.
  const staffView = (over: Partial<ViewDef>): RegisteredView => ({
    plugin: "billing",
    def: {
      id: "billing.thing",
      kind: "record",
      scope: "organization",
      path: "/microgrids/[id]/thing",
      params: { id: "microgrid" },
      cost: "db",
      declares: { keys: ["unit"] },
      examples: [],
      load: vi.fn(async () => ({ ok: true, model: record() })),
      ...over,
    } as unknown as ViewDef,
  });

  // Released paths, so only the caller's roles refuse them.
  it.each([
    ["an organization view with a place in its path", staffView({ path: "/microgrids/[id]/operations" }), "/microgrids/e7100000-0000-4000-8001-000000000002/operations"],
    ["an organization view with no segment", staffView({ id: "billing.root", path: "/microgrids", params: {} } as Partial<ViewDef>), "/microgrids"],
    ["an installation view", staffView({ id: "org.all", scope: "installation", path: "/organizations", params: {} } as Partial<ViewDef>), "/organizations"],
  ])("refuses %s with not found, reading nothing", async (_name, view, href) => {
    snapshot = { ...snapshot, views: [home, view] };
    roles = [tenantOf(UNIT_A), tenantOf(UNIT_B)];
    expect(await dispatch(href)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect((view.def.load as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(resolveTargetOrganization).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
    expect(clients).toEqual([]);
  });

  it("lets a person who also holds a staff row past, to the organization checks", async () => {
    const root = staffView({ id: "billing.root", path: "/microgrids", params: {} } as Partial<ViewDef>);
    snapshot = { ...snapshot, views: [home, root] };
    roles = [tenantOf(UNIT_A), managerOf(ORG_A)];
    // The fake shows no organization, so the organization step refuses.
    expect(await dispatch("/microgrids")).toMatchObject({ ok: false, status: 403, code: "gui_no_access" });
    expect(clients.length).toBeGreaterThan(0);
  });
});
