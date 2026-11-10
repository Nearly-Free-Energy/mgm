import { inspect } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { ActionDef, SurfaceRequest, ViewDef } from "../../../surface";
import type { HostContext } from "../access";
import type { RegisteredAction, RegisteredView, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
const surfaceSnapshot = vi.fn(async () => snapshot);
vi.mock("../snapshot", () => ({ surfaceSnapshot: () => surfaceSnapshot() }));

import { SYNTHETIC_NOTICE, dispatchView, matchView } from "../view";
import { ORG_A, ORG_B, contextFor, managerOf, tableClient } from "./host-fakes";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const MG2 = "e7100000-0000-4000-8002-0000000000a2";
const ORG_C = "e7100000-0000-4000-8000-000000000003";
const CANARY = "CANARY-7f3a91";
const DISABLED = { ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled for this organization." };

const tile = (o: Record<string, unknown> = {}) => ({ key: "soc", label: "Battery", value: { t: "percent", v: 50, text: "50%", ...o } });
const metrics = (o: Record<string, unknown> = {}) => ({ title: "Today", actions: [], body: { tiles: [tile(o)] } });

function view(plugin: MgmPluginName, def: Partial<ViewDef> & Pick<ViewDef, "id" | "path">): RegisteredView {
  return {
    plugin,
    def: {
      kind: "metrics",
      params: { id: "microgrid" },
      entity: "id",
      cost: "db",
      declares: { keys: ["soc"] },
      examples: [{ title: `${def.id} example` }],
      load: vi.fn(async () => ({ ok: true, model: metrics() })),
      ...def,
    } as unknown as ViewDef,
  };
}

/** A view with no path segments: its organization comes from `?org=`. */
const rootView = (id: string, path: string, over: Partial<ViewDef> = {}) =>
  view("billing", { id, path, params: {}, entity: undefined, ...over } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);

function action(plugin: MgmPluginName, id: string, path: string): RegisteredAction {
  const def = {
    id,
    title: id,
    target: "microgrid",
    input: z.object({}),
    inputVersion: 1,
    path,
    method: "PATCH",
    bind: { path: { id: "microgrid" } },
    risk: "write",
    confirm: "confirm",
    humanOnly: false,
  } as unknown as ActionDef;
  return { plugin, def };
}

let siteDay: RegisteredView;
let rates: RegisteredView;
let clients: SupabaseClient[];
let gates: Map<string, GateDecision>;
let tables: Parameters<typeof tableClient>[0];
let roles: UserRoleRecord[];

function snapshotOf(views: RegisteredView[], actions: RegisteredAction[] = []): SurfaceSnapshot {
  return {
    views,
    actions: new Map(actions.map((a) => [a.def.id, a])),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
}

function ctx() {
  const newClient = vi.fn(async () => {
    const { client } = tableClient(tables);
    clients.push(client);
    return client;
  });
  return contextFor(roles, newClient);
}

const loadOf = (v: RegisteredView) => v.def.load as unknown as ReturnType<typeof vi.fn>;
const dispatch = (href: string, depth?: 0 | 1) => dispatchView(ctx(), href, { depth });
/** What console.error was given, Error messages and stacks included. */
const logged = () => inspect(vi.mocked(console.error).mock.calls, { depth: 10 });

beforeEach(() => {
  clients = [];
  gates = new Map();
  roles = [managerOf(ORG_A)];
  tables = {
    microgrids: { data: [{ id: MG, name: "Kiwumu", community_id: null }] },
    organizations: { data: [{ id: ORG_A, name: "Alpha" }, { id: ORG_B, name: "Beta" }] },
  };
  surfaceSnapshot.mockClear();
  checkGate.mockReset();
  resolveTargetOrganization.mockReset();
  siteDay = view("metering", {
    id: "metering.site-day",
    path: "/microgrids/[id]/operations",
    cost: "vendor",
    query: ["date"],
    live: { refreshSeconds: 30, staleAfterSeconds: 120 },
  });
  rates = view("billing", {
    id: "billing.rates",
    path: "/microgrids/[id]/setup/rates",
    query: ["date"],
    attach: { to: "microgrid", order: 1, hint: "section" },
    live: { refreshSeconds: 5, staleAfterSeconds: 10 },
  });
  snapshot = snapshotOf([siteDay, rates]);
  resolveTargetOrganization.mockResolvedValue(ORG_A);
  checkGate.mockImplementation(async (_s: unknown, r: { plugin: string }) => gates.get(r.plugin) ?? { ok: true, organizationId: ORG_A });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("dispatchView", () => {
  it("serves a view with host fields filled and the loader on its own client", async () => {
    const out = await dispatch(`/microgrids/${MG.toUpperCase()}/operations?date=2026-11-08&ui.tab=x&org=${ORG_B}&other=1`);
    expect(out).toMatchObject({
      ok: true,
      value: {
        type: "view",
        view: "metering.site-day",
        kind: "metrics",
        org: ORG_A,
        entity: { kind: "microgrid", id: MG, label: "Kiwumu" },
        trail: [{ label: "Kiwumu", href: `/microgrids/${MG}/operations` }],
        links: [],
      },
    });
    const req = loadOf(siteDay).mock.calls[0][0] as SurfaceRequest;
    expect(req.organizationId).toBe(ORG_A);
    expect(req.params).toEqual({ id: MG });
    expect([...req.search]).toEqual([["date", "2026-11-08"]]);
    expect(clients.indexOf(req.supabase)).toBeGreaterThan(0);
    expect(clients.filter((c) => c === req.supabase)).toHaveLength(1);
  });

  it.each([
    ["an unknown page", "/organizations", 404],
    ["an unreleased path", `/microgrids/${MG}/nope`, 404],
    ["an API path", "/api/gui/view", 404],
    ["an id that is not a UUID", "/microgrids/not-a-uuid/operations", 404],
    ["a link to another origin", "//evil.example/x", 400],
  ])("refuses %s", async (_name, href, status) => {
    const out = await dispatch(href);
    expect(out).toMatchObject({ ok: false, status, code: status === 400 ? "gui_bad_request" : "gui_not_found" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
  });

  it("answers 404 for an organization the person cannot see", async () => {
    resolveTargetOrganization.mockResolvedValue(ORG_B);
    expect(await dispatch(`/microgrids/${MG}/operations`)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
  });

  it.each([
    ["off", DISABLED],
    ["unreadable", { ok: false, status: 503, code: "metering_gate_unavailable", message: "Could not check." }],
  ])("refuses a vendor view whose plugin is %s with the gate's copy, without loading", async (_name, decision) => {
    gates.set("metering", decision as GateDecision);
    expect(await dispatch(`/microgrids/${MG}/operations`)).toEqual(decision);
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
  });

  it("loads a db view whose plugin is off under the gate's notice", async () => {
    gates.set("billing", { ...DISABLED, code: "billing_disabled", message: "Billing is disabled." } as GateDecision);
    const out = await dispatch(`/microgrids/${MG}/setup/rates`);
    expect(out).toMatchObject({ ok: true, value: { notice: { tone: "warning", text: "Billing is disabled." } } });
    expect(loadOf(rates)).toHaveBeenCalledOnce();
  });

  it("passes a loader's refusal on with its status and message", async () => {
    loadOf(siteDay).mockResolvedValue({ ok: false, status: 409, message: "No site devices." });
    expect(await dispatch(`/microgrids/${MG}/operations`)).toEqual({
      ok: false,
      status: 409,
      code: "gui_view_refused",
      message: "No site devices.",
    });
  });

  it.each([
    ["throws", () => Promise.reject(new Error(CANARY)), 500, "gui_view_failed"],
    ["returns an undeclared key", async () => ({ ok: true, model: { ...metrics(), [CANARY]: CANARY } }), 500, "gui_output_invalid"],
    ["returns an extra key in a value", async () => ({ ok: true, model: metrics({ secret: CANARY }) }), 500, "gui_output_invalid"],
    [
      "returns a tile key the view does not declare",
      async () => ({ ok: true, model: { ...metrics(), body: { tiles: [{ ...tile(), key: CANARY }] } } }),
      500,
      "gui_output_invalid",
    ],
  ])("answers a loader that %s with a host error and none of its values", async (_name, load, status, code) => {
    loadOf(siteDay).mockImplementation(load);
    const out = await dispatch(`/microgrids/${MG}/operations`);
    expect(out).toMatchObject({ ok: false, status, code });
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(logged()).not.toContain(CANARY);
  });

  it.each([
    ["a 404 refusal", { ok: false, status: 404, message: "Gone." }, { status: 404, code: "gui_not_found", message: "Gone." }],
    ["a refusal with a status loaders may not use", { ok: false, status: 200, message: "x" }, { status: 500, code: "gui_output_invalid" }],
    ["a 401 refusal", { ok: false, status: 401, message: "x" }, { status: 500, code: "gui_output_invalid" }],
    ["a refusal without a message", { ok: false, status: 409, message: 7 }, { status: 500, code: "gui_output_invalid" }],
    ["null", null, { status: 500, code: "gui_output_invalid" }],
    ["a string", "x", { status: 500, code: "gui_output_invalid" }],
    ["an ok that is not a boolean", { ok: "yes", model: metrics() }, { status: 500, code: "gui_output_invalid" }],
  ])("answers a loader that returns %s", async (_name, result, expected) => {
    loadOf(siteDay).mockResolvedValue(result);
    expect(await dispatch(`/microgrids/${MG}/operations`)).toEqual({ ok: false, message: expect.any(String), ...expected });
  });

  it("cuts a loader's refusal message to 300 characters", async () => {
    loadOf(siteDay).mockResolvedValue({ ok: false, status: 409, message: "x".repeat(400) });
    const out = await dispatch(`/microgrids/${MG}/operations`);
    expect(!out.ok && out.message).toBe("x".repeat(300));
  });

  it("refuses a context hostContext did not issue, before reading the surface", async () => {
    await expect(dispatchView({ ...ctx() } as HostContext, `/microgrids/${MG}/operations`)).rejects.toThrow(/did not issue/);
    expect(surfaceSnapshot).not.toHaveBeenCalled();
  });

  it("does not serve a view at an unreleased path", async () => {
    const nope = view("billing", { id: "billing.nope", path: "/microgrids/[id]/nope" });
    snapshot = snapshotOf([siteDay, nope]);
    expect(await dispatch(`/microgrids/${MG}/nope`)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(loadOf(nope)).not.toHaveBeenCalled();
  });

  it.each([
    ["the entity lookup fails", () => (tables.microgrids = { data: null, error: { message: "down" } })],
    ["the organization resolver fails", () => resolveTargetOrganization.mockRejectedValue(new Error("down"))],
  ])("answers 503 when %s", async (_name, arrange) => {
    arrange();
    expect(await dispatch(`/microgrids/${MG}/operations`)).toMatchObject({ ok: false, status: 503, code: "gui_unavailable" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
  });

  it("treats a gate that throws as unreadable: a vendor view is refused, a db view loads under the notice", async () => {
    checkGate.mockRejectedValue(new Error("down"));
    expect(await dispatch(`/microgrids/${MG}/operations`)).toMatchObject({ ok: false, status: 503, code: "metering_gate_unavailable" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
    const db = await dispatch(`/microgrids/${MG}/setup/rates`);
    expect(db).toMatchObject({ ok: true, value: { notice: { tone: "warning", text: "Could not check whether this part of MGM is enabled." } } });
  });

  it("resolves the view's actions: its own shown disabled with the gate's copy, others' appended or left out", async () => {
    snapshot = snapshotOf(
      [siteDay, rates],
      [
        action("billing", "billing.edit", "/api/microgrids/[id]"),
        action("metering", "metering.check", "/api/microgrids/[id]/openems-backend"),
        action("payments", "payments.register", "/api/microgrids/[id]/edges/register"),
      ],
    );
    gates.set("billing", { ...DISABLED, code: "billing_disabled", message: "Billing is disabled." } as GateDecision);
    gates.set("payments", { ...DISABLED, code: "payments_disabled" } as GateDecision);
    loadOf(rates).mockResolvedValue({ ok: true, model: { ...metrics(), actions: [{ action: "billing.edit", params: { id: MG } }] } });
    const out = await dispatch(`/microgrids/${MG}/setup/rates`);
    expect(out.ok && out.value.actions).toEqual([
      expect.objectContaining({ action: "billing.edit", enabled: false, reason: "Billing is disabled." }),
      expect.objectContaining({ action: "metering.check", enabled: true, from: "Metering" }),
    ]);
  });

  describe("a view with no path segments", () => {
    let home: RegisteredView;
    beforeEach(() => {
      home = rootView("billing.home", "/organizations");
      snapshot = snapshotOf([siteDay, home]);
      roles = [managerOf(ORG_A), managerOf(ORG_B)];
    });

    it.each([
      ["a visible ?org=", `?org=${ORG_B.toUpperCase()}`, ORG_B],
      ["an invisible ?org=", `?org=${ORG_C}`, ORG_A],
      ["no ?org=", "", ORG_A],
    ])("loads in the organization %s names, else the first", async (_name, query, org) => {
      const out = await dispatch(`/organizations${query}`);
      expect(out).toMatchObject({ ok: true, value: { org, view: "billing.home" } });
      expect((loadOf(home).mock.calls[0][0] as SurfaceRequest).organizationId).toBe(org);
      expect(checkGate.mock.calls.map((c) => c[1].target.id)).toEqual([org]);
    });

    it("answers 403 when the person sees no organization", async () => {
      roles = [managerOf(ORG_C)];
      expect(await dispatch("/organizations")).toMatchObject({ ok: false, status: 403, code: "gui_no_access" });
      expect(loadOf(home)).not.toHaveBeenCalled();
    });

    it("answers 503 when organizations cannot be read", async () => {
      tables.organizations = { data: null, error: { message: "down" } };
      expect(await dispatch("/organizations")).toMatchObject({ ok: false, status: 503, code: "gui_unavailable" });
      expect(loadOf(home)).not.toHaveBeenCalled();
    });

    it("gives an attached view with no path segments the same ?org=", async () => {
      const users = rootView("billing.users", "/settings/users", { attach: { to: { view: "billing.home" }, order: 0, hint: "tab" } });
      snapshot = snapshotOf([home, users]);
      const out = await dispatch(`/organizations?org=${ORG_B}`);
      expect(out.ok && out.value.attached).toEqual([
        { view: "billing.users", title: "billing.users example", href: `/settings/users?org=${ORG_B}`, hint: "tab" },
      ]);
      expect(new Set(checkGate.mock.calls.map((c) => c[1].target.id))).toEqual(new Set([ORG_B]));
    });
  });

  it.each([
    ["with no path segments", "/settings/plugins", `/settings/plugins?org=${ORG_A}`],
    ["on an entity's path", "/microgrids/[id]/setup/households", `/microgrids/${MG}/setup/households`],
  ])("loads an installation view %s with no organization and no gate", async (_name, path, href) => {
    const installed = view("billing", { id: "billing.installed", path, scope: "installation" } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    if (!path.includes("[id]")) Object.assign(installed.def, { params: {}, entity: undefined });
    snapshot = snapshotOf([installed]);
    const out = await dispatch(href);
    expect(out).toMatchObject({ ok: true, value: { org: null, view: "billing.installed" } });
    expect((loadOf(installed).mock.calls[0][0] as { organizationId: unknown }).organizationId).toBeNull();
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("clamps live refresh, more for vendor views", async () => {
    const vendor = await dispatch(`/microgrids/${MG}/operations`);
    const db = await dispatch(`/microgrids/${MG}/setup/rates`);
    expect(vendor.ok && vendor.value.live).toEqual({ refreshSeconds: 60, staleAfterSeconds: 120 });
    expect(db.ok && db.value.live).toEqual({ refreshSeconds: 15, staleAfterSeconds: 15 });
  });

  it("lists enabled, released views attached to the entity, passing a shared query on", async () => {
    const other = view("metering", { id: "metering.other", path: "/microgrids/[id]/billing", attach: { to: { view: "billing.rates" }, order: 0, hint: "tab" } });
    const hidden = view("payments", { id: "payments.hidden", path: "/microgrids/[id]/billing", attach: { to: "microgrid", order: 0, hint: "tab" } });
    const unreleased = view("billing", { id: "billing.unreleased", path: "/microgrids/[id]/nope", attach: { to: "microgrid", order: 0, hint: "tab" } });
    snapshot = { ...snapshotOf([siteDay, rates, other, hidden, unreleased]), nav: [{ plugin: "billing", def: { id: "billing.nav", title: "Rates", icon: "billing", group: "money", order: 1, view: "billing.rates" } }] };
    gates.set("payments", { ...DISABLED, code: "payments_disabled" } as GateDecision);
    const out = await dispatch(`/microgrids/${MG}/operations?date=2026-11-08&ui.tab=x`);
    expect(out.ok && out.value.attached).toEqual([
      { view: "billing.rates", title: "Rates", href: `/microgrids/${MG}/setup/rates?date=2026-11-08`, hint: "section" },
    ]);
    const nested = await dispatch(`/microgrids/${MG}/operations`, 1);
    expect(nested.ok && nested.value.attached).toEqual([]);
  });

  it("lists views attached to this view, never itself, in order, with only the query both declare", async () => {
    const other = view("metering", {
      id: "metering.other",
      path: "/microgrids/[id]/billing",
      query: ["date", "extra"],
      attach: { to: { view: "billing.rates" }, order: 2, hint: "tab" },
    });
    const second = view("metering", { id: "metering.second", path: "/microgrids/[id]/setup/households", attach: { to: "microgrid", order: 1, hint: "tab" } });
    snapshot = snapshotOf([siteDay, rates, other, second]);
    const out = await dispatch(`/microgrids/${MG}/setup/rates?date=2026-11-08&extra=1`);
    expect(out.ok && out.value.attached).toEqual([
      { view: "metering.second", title: "metering.second example", href: `/microgrids/${MG}/setup/households`, hint: "tab" },
      { view: "metering.other", title: "metering.other example", href: `/microgrids/${MG}/billing?date=2026-11-08`, hint: "tab" },
    ]);
  });

  it("marks a model with synthetic values unless the gate's notice is shown", async () => {
    loadOf(rates).mockResolvedValue({ ok: true, model: metrics({ synthetic: true }) });
    expect(await dispatch(`/microgrids/${MG}/setup/rates`)).toMatchObject({ ok: true, value: { notice: SYNTHETIC_NOTICE } });
    gates.set("billing", { ...DISABLED, message: "Billing is disabled." } as GateDecision);
    expect(await dispatch(`/microgrids/${MG}/setup/rates`)).toMatchObject({ ok: true, value: { notice: { text: "Billing is disabled." } } });
  });

  it("loads a feed's view embeds at depth 1 only", async () => {
    const entry = (id: string, href: string) => ({
      id,
      at: "2026-11-09T08:00:00Z",
      author: { kind: "system", name: "MGM" },
      text: [{ p: [id] }],
      embed: { type: "view", href },
    });
    const feed = view("metering", { id: "metering.feed", kind: "feed", path: "/microgrids/[id]/billing", declares: { keys: [] } });
    loadOf(feed).mockResolvedValue({
      ok: true,
      model: { title: "Feed", actions: [], body: { entries: [entry("a", `/microgrids/${MG}/operations`), entry("b", "/organizations")] } },
    });
    snapshot = snapshotOf([siteDay, feed]);
    const out = await dispatch(`/microgrids/${MG}/billing`);
    const entries = out.ok && out.value.kind === "feed" ? out.value.body.entries : [];
    expect(entries[0].embed).toMatchObject({ type: "view", model: { view: "metering.site-day", attached: [] } });
    expect(entries[1].embed).toEqual({ type: "values", values: [{ t: "text", text: "Not available" }] });
    const nested = await dispatch(`/microgrids/${MG}/billing`, 1);
    expect(nested.ok && nested.value.kind === "feed" && nested.value.body.entries[0].embed).toMatchObject({ type: "values" });
  });

  it("loads a feed's embeds in the feed's organization only", async () => {
    roles = [managerOf(ORG_A), managerOf(ORG_B)];
    resolveTargetOrganization.mockImplementation(async (_s: unknown, t: { id: string }) => (t.id === MG2 ? ORG_B : ORG_A));
    const home = rootView("billing.home", "/organizations");
    const feed = view("metering", { id: "metering.feed", kind: "feed", path: "/microgrids/[id]/billing", declares: { keys: [] } });
    const entry = (id: string, href: string) => ({ id, at: "2026-11-09T08:00:00Z", author: { kind: "system", name: "MGM" }, text: [{ p: [id] }], embed: { type: "view", href } });
    loadOf(feed).mockResolvedValue({
      ok: true,
      model: { title: "Feed", actions: [], body: { entries: [entry("a", "/organizations"), entry("b", `/microgrids/${MG}/operations`)] } },
    });
    snapshot = snapshotOf([siteDay, home, feed]);
    const out = await dispatch(`/microgrids/${MG2}/billing`);
    expect(out).toMatchObject({ ok: true, value: { org: ORG_B } });
    const entries = out.ok && out.value.kind === "feed" ? out.value.body.entries : [];
    expect(entries[0].embed).toMatchObject({ type: "view", model: { view: "billing.home", org: ORG_B } });
    expect((loadOf(home).mock.calls[0][0] as SurfaceRequest).organizationId).toBe(ORG_B);
    expect(entries[1].embed).toEqual({ type: "values", values: [{ t: "text", text: "Not available" }] });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
  });
});

describe("matchView", () => {
  const at = (path: string) => view("metering", { id: `metering.v${path}`, path });

  it("prefers a fixed segment to a bracketed one, whatever the order", () => {
    const views = [at("/microgrids/[id]/[tab]"), at("/microgrids/[id]/operations")];
    expect(matchView(views, `/microgrids/${MG}/operations`)?.view.def.path).toBe("/microgrids/[id]/operations");
    expect(matchView(views, `/microgrids/${MG}/billing`)?.values).toEqual({ id: MG, tab: "billing" });
  });

  it("decodes segment values and refuses a malformed one", () => {
    const views = [at("/microgrids/[id]/[tab]")];
    expect(matchView(views, "/microgrids/a%20b/c")?.values).toEqual({ id: "a b", tab: "c" });
    expect(matchView(views, "/microgrids/%E0%A4%A/c")).toBeUndefined();
  });
});
