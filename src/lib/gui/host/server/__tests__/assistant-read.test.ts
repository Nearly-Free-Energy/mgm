/**
 * The assistant read interface (../assistant-read.ts): it serves only views
 * and watchers that are marked and listed, through the host's own dispatch,
 * with the host's refusals passed on, attached views and embeds an assistant
 * may not read withheld, every action removed, refused references refused
 * whole and the answer bounded. The real `metering.site-day` loader runs
 * here, with only its composition mocked, so its refusals, problems,
 * freshness and disposal are seen through the interface.
 */
import { inspect } from "node:util";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFmt } from "@/lib/gui/fmt";
import { generateSiteSamples } from "@/lib/metering/fixture/site-samples";
import { computeSiteDay } from "@/lib/metering/site-operations";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { AssistantRead } from "../../../assistant-reads";
import type { ActionDef, ViewDef } from "../../../surface";
import { hostContext, type HostContext } from "../access";
import type { RegisteredAction, RegisteredSignal, RegisteredView, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));
/** The code-owned list, as each case sets it. */
const reads: AssistantRead[] = vi.hoisted(() => []);
vi.mock("@/lib/gui/assistant-reads", () => ({ ASSISTANT_READS: reads }));
const composeMetering = vi.fn();
vi.mock("@/lib/metering/compose", () => ({ composeMetering: (...args: unknown[]) => composeMetering(...args) }));

import { METERING_SURFACE } from "@/lib/metering/surface";
import { ASSISTANT_READ_MAX_CHARS, WITHHELD_NOTE, readForAssistant } from "../assistant-read";
import { actionRefSchema, viewModelSchema } from "../model-schema";
import { DATA_KEYS } from "../parse";
import { WITHHELD_EMBED, dispatchView } from "../view";
import { ORG_A, ORG_B, managerOf, superAdmin, tableClient, tenantOf } from "./host-fakes";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const TENANT = "e7100000-0000-4000-8009-000000000001";
const CANARY = "CANARY-5b1e07";
const UPSTREAM = "upstream said: token abc123 refused";
const USER = { id: "e7100000-0000-4000-8fff-000000000002", email: "assistant@test.local" } as User;
const NOW = new Date("2026-11-09T08:00:00Z"); // 11:00 in Kampala
const DAY = `/microgrids/${MG}/operations`;
const DISABLED = { ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled for this organization." };

const REAL_SITE_DAY = METERING_SURFACE.views!.find((v) => v.id === "metering.site-day")!;

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
      load: vi.fn(async () => ({ ok: true, model: { title: "Other", actions: [], body: { tiles: [] } } })),
      ...def,
    } as unknown as ViewDef,
  };
}
const loadOf = (v: RegisteredView) => v.def.load as unknown as ReturnType<typeof vi.fn>;

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
    repeat: "safe",
  } as unknown as ActionDef;
  return { plugin, def };
}

function snapshotOf(views: RegisteredView[], o: { actions?: RegisteredAction[]; signals?: RegisteredSignal[] } = {}): SurfaceSnapshot {
  return {
    views,
    actions: new Map((o.actions ?? []).map((a) => [a.def.id, a])),
    nav: [{ plugin: "billing", def: { id: "billing.rates-nav", title: "Rates", icon: "rates", group: "configure", order: 1, view: "billing.rates" } }],
    signals: o.signals ?? [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  } as unknown as SurfaceSnapshot;
}

let roles: UserRoleRecord[];
let gates: Map<string, GateDecision>;
let tables: Parameters<typeof tableClient>[0];
let siteDay: RegisteredView;
let savings: RegisteredView;
let rates: RegisteredView;
let events: string[];
let dispose: ReturnType<typeof vi.fn>;
let getSiteDay: ReturnType<typeof vi.fn>;

function ctx(): HostContext {
  const made = hostContext({ user: USER, roles }, new Headers({ "accept-language": "en-GB" }), {
    newClient: async () => tableClient(tables).client as SupabaseClient,
    makeFmt: (locale) => createFmt({ locale }),
    now: NOW,
  });
  if (!made.ok) throw new Error("fixture context refused");
  return made.ctx;
}
const list = (...entries: AssistantRead[]) => reads.splice(0, reads.length, ...entries);
const read = (href: string, org?: string) => readForAssistant(ctx(), { type: "view", href, ...(org ? { org } : {}) });
const logged = () => inspect([vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls], { depth: 10 });

function generatedDay(date: string) {
  const device = (id: string) => ({ id, edgeOpenemsId: "SYNTHETIC-EDGE-T", componentId: id });
  const sources = { battery: device("b"), gridMeter: device("g"), load: null, pv: null, houseMeters: [], houseMetersUnreadable: 0 };
  return computeSiteDay({
    date,
    timezone: "Africa/Kampala",
    samples: generateSiteSamples({ microgridId: MG, sources, startDate: "2026-11-07", endDate: date, timezone: "Africa/Kampala", resolutionMinutes: 5 }),
    sources: { battery: true, gridMeter: true, load: false, pv: false, houses: false, houseMetersUnreadable: 0 },
    resolutionMinutes: 5,
    nowMs: NOW.getTime(),
  });
}

/** `page`'s model as the interface gives it: actions emptied, and no attached views, signals or polling hints. */
function stripped(page: Awaited<ReturnType<typeof dispatchView>>) {
  if (!page.ok) throw new Error("page refused");
  const { attached: _a, signals: _s, live: _l, ...rest } = page.value;
  void [_a, _s, _l];
  return { ...rest, actions: [] };
}

beforeEach(() => {
  roles = [managerOf(ORG_A)];
  gates = new Map();
  events = [];
  tables = {
    microgrids: { data: [{ id: MG, name: "Kiwumu", community_id: null, timezone: "Africa/Kampala", address_country: "Uganda", lat: 0.3, lng: 32.6 }] },
    organizations: { data: [{ id: ORG_A, name: "Alpha" }, { id: ORG_B, name: "Beta" }] },
  };
  siteDay = { plugin: "metering", def: { ...REAL_SITE_DAY, agent: "read", load: vi.fn(REAL_SITE_DAY.load) } as unknown as ViewDef };
  savings = view("billing", { id: "billing.savings", path: "/microgrids/[id]/billing", attach: { to: { view: "metering.site-day" }, order: 1, hint: "section" } });
  rates = view("billing", { id: "billing.rates", path: "/microgrids/[id]/setup/rates", attach: { to: "microgrid", order: 2, hint: "tab" } });
  snapshot = snapshotOf([siteDay, savings, rates], { actions: [action("billing", "billing.edit", "/api/microgrids/[id]")] });
  list({ kind: "view", id: "metering.site-day" });
  resolveTargetOrganization.mockReset().mockResolvedValue(ORG_A);
  checkGate.mockReset().mockImplementation(async (_s: unknown, r: { plugin: string; target: { id: string } }) => gates.get(r.plugin) ?? { ok: true, organizationId: r.target.id });
  dispose = vi.fn(async () => void events.push("dispose"));
  getSiteDay = vi.fn(async (q: { date: string }) => ({ ok: true, data: { ...generatedDay(q.date), synthetic: true } }));
  composeMetering.mockReset().mockImplementation(async () => ({ ok: true, data: { metering: { getSiteDay }, dispose } }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("readForAssistant, for a view", () => {
  it("serves the real site-day, which declares no scope, as dispatchView serves the page, with only the documented withholdings", async () => {
    const out = await read(`${DAY}?date=2026-11-08`);
    const page = await dispatchView(ctx(), `${DAY}?date=2026-11-08`);
    expect(page.ok && page.value.actions.map((a) => a.action)).toEqual(["billing.edit"]);
    expect(out).toMatchObject({ ok: true, value: { type: "assistant-view", view: "metering.site-day", org: ORG_A, cost: "vendor", ext: "metering.site-day@2", attached: [] } });
    if (!out.ok) throw new Error("refused");
    expect(out.value.model).toEqual(stripped(page));
    // The model still has the shape a GUI receives.
    expect(viewModelSchema.safeParse({ ...out.value.model, attached: [] }).success).toBe(true);
  });

  it("keeps today's partial day distinguishable: partial, and read until when", async () => {
    const out = await read(`${DAY}?date=2026-11-09`);
    if (!out.ok) throw new Error("refused");
    expect(out.value.model.ext?.data).toMatchObject({ state: "day", date: "2026-11-09", partial: true, readUntil: expect.any(String) });
  });

  it.each([
    ["installation", { scope: "installation" }],
    ["tenant", { scope: "tenant" }],
  ])("refuses a marked and listed %s view before its loader runs", async (_name, over) => {
    siteDay = { plugin: "metering", def: { ...siteDay.def, ...over } as unknown as ViewDef };
    snapshot = snapshotOf([siteDay]);
    expect(await read(DAY)).toMatchObject({ ok: false, status: 403, code: "assistant_not_listed" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
    expect(composeMetering).not.toHaveBeenCalled();
  });

  it.each([
    ["is marked but not listed", () => list(), true],
    ["is listed but not marked", () => undefined, false],
    ["is listed as a watcher", () => list({ kind: "watcher", id: "metering.site-day" }), true],
  ])("refuses a view that %s, and never runs its loader", async (_name, setList, marked) => {
    setList();
    if (!marked) siteDay = { plugin: "metering", def: { ...siteDay.def, agent: undefined } as unknown as ViewDef };
    snapshot = snapshotOf([siteDay]);
    expect(await read(DAY)).toMatchObject({ ok: false, status: 403, code: "assistant_not_listed" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("passes on the host's refusals of an href", async () => {
    expect(await read("//evil.example/x")).toMatchObject({ ok: false, status: 400, code: "gui_bad_request" });
    expect(await read("/api/gui/view")).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(await read(`/microgrids/${MG}/nope`)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
  });

  describe("the organization", () => {
    it("answers 404 for another organization's microgrid", async () => {
      resolveTargetOrganization.mockResolvedValue(ORG_B);
      expect(await read(DAY)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
      expect(composeMetering).not.toHaveBeenCalled();
    });

    it("reads a super admin's view only in the organization asked for", async () => {
      roles = [superAdmin()];
      resolveTargetOrganization.mockResolvedValue(ORG_B);
      expect(await read(DAY, ORG_B)).toMatchObject({ ok: true, value: { org: ORG_B } });
      expect(composeMetering).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_B }));
      composeMetering.mockClear();
      expect(await read(DAY, ORG_A)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
      expect(composeMetering).not.toHaveBeenCalled();
    });
  });

  describe("plugin state", () => {
    it("refuses the vendor view whose plugin is off with the gate's answer, loading nothing", async () => {
      gates.set("metering", DISABLED as GateDecision);
      expect(await read(DAY)).toEqual(DISABLED);
      expect(loadOf(siteDay)).not.toHaveBeenCalled();
    });

    it("loads a listed db view whose plugin is off, under the gate's notice", async () => {
      const edges = view("metering", { id: "metering.edges-view", path: "/microgrids/[id]/setup/edges", agent: "read" } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
      snapshot = snapshotOf([edges]);
      list({ kind: "view", id: "metering.edges-view" });
      gates.set("metering", DISABLED as GateDecision);
      expect(await read(`/microgrids/${MG}/setup/edges`)).toMatchObject({ ok: true, value: { model: { notice: { tone: "warning", text: DISABLED.message } } } });
      expect(loadOf(edges)).toHaveBeenCalledOnce();
    });

    it("answers 503 when the plugin's state cannot be read", async () => {
      const unreadable = { ok: false, status: 503, code: "metering_gate_unavailable", message: "Could not check." };
      gates.set("metering", unreadable as GateDecision);
      expect(await read(DAY)).toEqual(unreadable);
    });
  });

  it("shows an unavailable provider as the problem, with its reason and no figures", async () => {
    getSiteDay.mockResolvedValue({ ok: false, status: 503, code: "METERING_UNAVAILABLE", message: UPSTREAM });
    const out = await read(`${DAY}?date=2026-11-08`);
    if (!out.ok) throw new Error("refused");
    expect(out.value.model.ext?.data).toMatchObject({ state: "problem", reason: "upstream_unavailable" });
    const tiles = out.value.model.kind === "metrics" ? out.value.model.body.tiles : [];
    expect(tiles.map((t) => t.key)).toEqual(["problem"]);
    expect(JSON.stringify(out)).not.toContain(UPSTREAM);
  });

  describe("scope disposal", () => {
    it.each([
      ["an answer", () => undefined, { ok: true }],
      ["a refusal", () => getSiteDay.mockResolvedValue({ ok: false, status: 403, code: "metering_forbidden", message: UPSTREAM }), { ok: false, status: 403, code: "gui_view_refused" }],
      ["a throw", () => getSiteDay.mockRejectedValue(new Error(UPSTREAM)), { ok: false, status: 500, code: "gui_view_failed" }],
    ])("disposes the loader's composition once, before %s", async (_name, arrange, expected) => {
      arrange();
      const out = await read(DAY);
      events.push("answer");
      expect(out).toMatchObject(expected);
      expect(dispose).toHaveBeenCalledOnce();
      expect(events).toEqual(["dispose", "answer"]);
      expect(JSON.stringify(out)).not.toContain(UPSTREAM);
    });
  });

  describe("attached views", () => {
    it.each([
      ["on", undefined],
      ["off", { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled." }],
    ])("withholds every unlisted one, whatever its plugin state (billing %s), without loading it", async (_name, decision) => {
      if (decision) gates.set("billing", decision as GateDecision);
      const out = await read(DAY);
      if (!out.ok) throw new Error("refused");
      expect(out.value.withheld).toEqual([
        { what: "view", view: "billing.savings", title: "billing.savings example", hint: "section", note: WITHHELD_NOTE },
        { what: "view", view: "billing.rates", title: "Rates", hint: "tab", note: WITHHELD_NOTE },
      ]);
      expect(out.value.attached).toEqual([]);
      expect(loadOf(savings)).not.toHaveBeenCalled();
      expect(loadOf(rates)).not.toHaveBeenCalled();
    });

    /** A listed tile of community management's, attached to the site day. */
    function listedTile(path = "/microgrids/[id]/setup/edges") {
      const tile = view("community-management", {
        id: "community-management.tile",
        path,
        agent: "read",
        attach: { to: { view: "metering.site-day" }, order: 3, hint: "tile" },
      } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
      snapshot = snapshotOf([siteDay, tile, rates], { actions: [action("billing", "billing.edit", "/api/microgrids/[id]")] });
      list({ kind: "view", id: "metering.site-day" }, { kind: "view", id: "community-management.tile" });
      return tile;
    }

    it("reads a listed one as the view itself is read, in the same organization", async () => {
      listedTile();
      const out = await read(DAY);
      if (!out.ok) throw new Error("refused");
      expect(out.value.attached).toHaveLength(1);
      const [attached] = out.value.attached;
      expect(attached).toMatchObject({
        view: "community-management.tile",
        hint: "tile",
        outcome: { ok: true, value: { view: "community-management.tile", org: ORG_A, attached: [] } },
      });
      expect(attached.outcome.ok && attached.outcome.value.model.actions).toEqual([]);
      expect(out.value.withheld.map((w) => (w.what === "view" ? w.view : w.what))).toEqual(["billing.rates"]);
    });

    it("does not read a listed one in another organization than the view's", async () => {
      roles = [superAdmin()];
      const tile = listedTile();
      // The site day resolves to ORG_A; once its loader has run, the tile's path resolves to ORG_B.
      composeMetering.mockImplementation(async () => {
        resolveTargetOrganization.mockResolvedValue(ORG_B);
        return { ok: true, data: { metering: { getSiteDay }, dispose } };
      });
      const out = await read(DAY, ORG_A);
      if (!out.ok) throw new Error("refused");
      expect(out.value.org).toBe(ORG_A);
      expect(out.value.attached).toEqual([
        { view: "community-management.tile", title: expect.any(String), hint: "tile", outcome: expect.objectContaining({ ok: false, status: 404, code: "gui_not_found" }) },
      ]);
      expect(loadOf(tile)).not.toHaveBeenCalled();
    });

    it.each([
      ["is off", { ok: false, status: 409, code: "community-management_disabled", message: "Community management is disabled." }],
      ["cannot be read", { ok: false, status: 503, code: "community-management_gate_unavailable", message: "Could not check." }],
    ])("gives a listed one whose plugin %s with the gate's answer, never leaving it out", async (_name, decision) => {
      const tile = listedTile();
      gates.set("community-management", decision as GateDecision);
      const out = await read(DAY);
      if (!out.ok) throw new Error("refused");
      expect(out.value.attached).toEqual([{ view: "community-management.tile", title: "community-management.tile example", hint: "tile", outcome: decision }]);
      expect(loadOf(tile)).not.toHaveBeenCalled();
    });

    it("gives a listed one whose path cannot be filled here as not found", async () => {
      const tile = listedTile("/microgrids/[id]/setup/edges/[edgeId]");
      tile.def.params = { id: "microgrid", edgeId: "edge" };
      const out = await read(DAY);
      if (!out.ok) throw new Error("refused");
      expect(out.value.attached).toEqual([
        { view: "community-management.tile", title: "community-management.tile example", hint: "tile", outcome: expect.objectContaining({ ok: false, status: 404, code: "gui_not_found" }) },
      ]);
      expect(loadOf(tile)).not.toHaveBeenCalled();
    });
  });

  it("withholds a feed's embed of an unlisted view without loading it, and records the entry", async () => {
    const feed = view("metering", { id: "metering.feed", kind: "feed", path: "/microgrids/[id]/operations", agent: "read", declares: { keys: [] } } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    const other = view("metering", { id: "metering.other", path: "/microgrids/[id]/setup/edges" });
    loadOf(feed).mockResolvedValue({
      ok: true,
      model: {
        title: "Feed",
        actions: [],
        body: { entries: [{ id: "e1", at: "2026-11-09T07:00:00Z", author: { kind: "system", name: "MGM" }, text: [{ p: ["x"] }], embed: { type: "view", href: `/microgrids/${MG}/setup/edges` } }] },
      },
    });
    snapshot = snapshotOf([feed, other]);
    list({ kind: "view", id: "metering.feed" });
    const out = await read(DAY);
    if (!out.ok) throw new Error("refused");
    expect(out.value.model.kind === "feed" && out.value.model.body.entries[0].embed).toEqual(WITHHELD_EMBED);
    expect(out.value.withheld).toEqual([{ what: "embed", entry: "e1", note: WITHHELD_NOTE }]);
    expect(loadOf(other)).not.toHaveBeenCalled();
  });

  it("withholds an embed inside an embedded feed, records its entry, and never loads it", async () => {
    const entry = (id: string, href: string) => ({ id, at: "2026-11-09T07:00:00Z", author: { kind: "system", name: "MGM" }, text: [{ p: ["x"] }], embed: { type: "view", href } });
    const feed = view("metering", { id: "metering.feed", kind: "feed", path: "/microgrids/[id]/operations", agent: "read", declares: { keys: [] } } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    const inner = view("metering", { id: "metering.inner", kind: "feed", path: "/microgrids/[id]/setup/openems-backend", agent: "read", declares: { keys: [] } } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    const other = view("metering", { id: "metering.other", path: "/microgrids/[id]/setup/edges" });
    loadOf(feed).mockResolvedValue({ ok: true, model: { title: "Feed", actions: [], body: { entries: [entry("e1", `/microgrids/${MG}/setup/openems-backend`)] } } });
    loadOf(inner).mockResolvedValue({ ok: true, model: { title: "Inner", actions: [], body: { entries: [entry("e2", `/microgrids/${MG}/setup/edges`)] } } });
    snapshot = snapshotOf([feed, inner, other]);
    list({ kind: "view", id: "metering.feed" }, { kind: "view", id: "metering.inner" });
    const out = await read(DAY);
    if (!out.ok || out.value.model.kind !== "feed") throw new Error("refused");
    const embed = out.value.model.body.entries[0].embed;
    expect(embed?.type === "view" && embed.model.kind === "feed" && embed.model.body.entries[0].embed).toEqual(WITHHELD_EMBED);
    expect(out.value.withheld).toEqual([{ what: "embed", entry: "e2", note: WITHHELD_NOTE }]);
    expect(loadOf(inner)).toHaveBeenCalledOnce();
    expect(loadOf(other)).not.toHaveBeenCalled();
  });

  it("removes a flow step's action and a collection's empty action, keeping ext and declared keys named like actions", async () => {
    const link = { action: "metering.check", params: { id: MG } };
    const flow = view("metering", { id: "metering.flow", kind: "flow", path: "/microgrids/[id]/setup", agent: "read", declares: { keys: [] } } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    loadOf(flow).mockResolvedValue({ ok: true, model: { title: "Flow", actions: [], body: { steps: [{ id: "s1", title: "Check", state: "current", action: link }] } } });
    const listing = view("metering", {
      id: "metering.list",
      kind: "collection",
      path: "/microgrids/[id]/operations",
      agent: "read",
      declares: { keys: ["action"] },
      ext: { schema: "metering.list@1", zod: z.strictObject({ actions: z.array(z.string()), action: z.string() }) },
    } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    const ext = { schema: "metering.list@1", data: { actions: ["kept"], action: "kept" } };
    loadOf(listing).mockResolvedValue({
      ok: true,
      model: {
        title: "List",
        actions: [],
        ext,
        body: {
          columns: [{ key: "action", label: "Action", type: "text", priority: 1 }],
          rows: [{ id: "r1", cells: { action: { t: "text", text: "kept" } }, actions: [link] }],
          empty: { title: "None", action: link },
        },
      },
    });
    snapshot = snapshotOf([flow, listing], { actions: [action("metering", "metering.check", "/api/microgrids/[id]/openems-backend")] });
    list({ kind: "view", id: "metering.flow" }, { kind: "view", id: "metering.list" });

    const pages = [await dispatchView(ctx(), `/microgrids/${MG}/setup`), await dispatchView(ctx(), DAY)];
    expect(pages.map((p) => p.ok && JSON.stringify(p.value).includes("metering.check"))).toEqual([true, true]);

    const steps = await read(`/microgrids/${MG}/setup`);
    if (!steps.ok || steps.value.model.kind !== "flow") throw new Error("refused");
    expect(steps.value.model.body.steps).toEqual([{ id: "s1", title: "Check", state: "current" }]);

    const rows = await read(DAY);
    if (!rows.ok || rows.value.model.kind !== "collection") throw new Error("refused");
    expect(rows.value.model.body.empty).toEqual({ title: "None" });
    expect(rows.value.model.body.rows).toEqual([{ id: "r1", cells: { action: { t: "text", text: "kept" } }, actions: [] }]);
    expect(rows.value.model.ext).toEqual(ext);
    expect(JSON.stringify([steps, rows])).not.toContain("metering.check");
  });

  it("removes every action, proposal and composer, keeping the data subtrees", async () => {
    const feed = view("metering", { id: "metering.feed", kind: "feed", path: "/microgrids/[id]/operations", agent: "read", declares: { keys: [] } } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    loadOf(feed).mockResolvedValue({
      ok: true,
      model: {
        title: "Feed",
        actions: [{ action: "metering.check", params: { id: MG } }],
        body: {
          entries: [{ id: "e1", at: "2026-11-09T07:00:00Z", author: { kind: "system", name: "MGM" }, text: [{ p: ["x"] }], embed: { type: "action", ref: { action: "metering.check", params: { id: MG } } } }],
          compose: { action: { action: "metering.check", params: { id: MG } }, textField: "text", placeholder: "Ask" },
          stop: { action: "metering.check", params: { id: MG } },
        },
      },
    });
    snapshot = snapshotOf([feed], { actions: [action("metering", "metering.check", "/api/microgrids/[id]/openems-backend")] });
    list({ kind: "view", id: "metering.feed" });
    const page = await dispatchView(ctx(), DAY);
    expect(page.ok && page.value.kind === "feed" && [page.value.actions.length, !!page.value.body.compose, !!page.value.body.stop]).toEqual([1, true, true]);
    const out = await read(DAY);
    if (!out.ok || out.value.model.kind !== "feed") throw new Error("refused");
    expect(out.value.model.actions).toEqual([]);
    expect(out.value.model.body).toEqual({ entries: [{ id: "e1", at: "2026-11-09T07:00:00Z", author: { kind: "system", name: "MGM" }, text: [{ p: ["x"] }] }] });
    expect(JSON.stringify(out)).not.toContain("metering.check");
  });

  it("refuses a listed view that emits a tenant reference, logging only its path and kind", async () => {
    const leaky = view("metering", { id: "metering.leaky", path: "/microgrids/[id]/operations", agent: "read" } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    loadOf(leaky).mockResolvedValue({
      ok: true,
      model: { title: "Leaky", actions: [], entity: { kind: "tenant", id: TENANT, label: CANARY }, body: { tiles: [] } },
    });
    snapshot = snapshotOf([leaky]);
    list({ kind: "view", id: "metering.leaky" });
    const out = await read(DAY);
    expect(out).toEqual({ ok: false, status: 500, code: "assistant_reference_refused", message: expect.any(String) });
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(logged()).toContain("assistant read metering.leaky: a tenant reference at entity");
    expect(logged()).not.toContain(CANARY);
  });

  it("refuses an answer longer than the bound", async () => {
    const big = view("metering", { id: "metering.big", path: "/microgrids/[id]/operations", agent: "read", declares: { keys: ["a"] } } as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);
    const tiles = Array.from({ length: 100 }, () => ({ key: "a", label: "x".repeat(200), value: { t: "text", text: "y".repeat(2_500) } }));
    loadOf(big).mockResolvedValue({ ok: true, model: { title: "Big", actions: [], body: { tiles } } });
    snapshot = snapshotOf([big]);
    list({ kind: "view", id: "metering.big" });
    const page = await dispatchView(ctx(), DAY);
    expect(page.ok && JSON.stringify(page.value).length).toBeGreaterThan(ASSISTANT_READ_MAX_CHARS);
    expect(await read(DAY)).toMatchObject({ ok: false, status: 500, code: "assistant_output_too_large" });
  });
});

describe("the positions stripActions removes", () => {
  type Def = {
    type: string;
    shape?: Record<string, z.ZodType>;
    element?: z.ZodType;
    items?: z.ZodType[];
    rest?: z.ZodType | null;
    options?: z.ZodType[];
    innerType?: z.ZodType;
    valueType?: z.ZodType;
    getter?: () => z.ZodType;
    values?: unknown[];
  };
  const defOf = (s: z.ZodType) => s._zod.def as unknown as Def;
  const LEAVES = new Set(["string", "number", "boolean", "literal", "enum", "template_literal", "null", "int"]);
  /** The names whose whole value stripActions removes or empties. */
  const REMOVED = new Set(["actions", "action", "stop", "compose"]);

  it("finds every ActionRef in a view model under a name it removes, or in an action embed", () => {
    const problems: string[] = [];
    let found = 0;
    const seen = new Map<z.ZodType, Set<string>>();
    // `removed`: an enclosing name or action embed takes this value away; `data`: under DATA_KEYS, which are kept as they are.
    const visit = (s: z.ZodType, prop: string, removed: boolean, data: boolean, at: string): void => {
      if (s === actionRefSchema) {
        found++;
        if (data || !removed) problems.push(`${at}: an ActionRef stripActions would keep`);
        return;
      }
      const state = `${removed}:${data}`;
      const states = seen.get(s) ?? new Set<string>();
      if (states.has(state)) return;
      seen.set(s, states.add(state));
      const d = defOf(s);
      switch (d.type) {
        case "object": {
          const type = d.shape!.type;
          const actionEmbed = prop === "embed" && type !== undefined && defOf(type).type === "literal" && defOf(type).values!.includes("action");
          for (const [key, child] of Object.entries(d.shape!)) {
            visit(child, key, removed || actionEmbed || (!data && REMOVED.has(key)), data || DATA_KEYS.has(key), `${at}.${key}`);
          }
          return;
        }
        case "optional":
        case "nullable":
          return visit(d.innerType!, prop, removed, data, at);
        case "lazy":
          return visit(d.getter!(), prop, removed, data, at);
        case "union":
          return d.options!.forEach((o) => visit(o, prop, removed, data, at));
        case "array":
          return visit(d.element!, prop, removed, data, `${at}[]`);
        case "tuple":
          return [...d.items!, ...(d.rest ? [d.rest] : [])].forEach((i) => visit(i, prop, removed, data, `${at}[]`));
        case "record":
          return visit(d.valueType!, prop, removed, data, `${at}.*`);
        default:
          if (!LEAVES.has(d.type)) problems.push(`${at}: a ${d.type} the audit does not know`);
      }
    };
    visit(viewModelSchema, "", false, false, "(value)");
    expect(problems).toEqual([]);
    expect(found).toBeGreaterThan(5);
  });
});

describe("readForAssistant, for signals", () => {
  const AT = "2026-11-09T07:00:00Z";
  const base = { severity: "warn", title: "Kiwumu", href: `/microgrids/${MG}/setup/openems-backend`, at: AT };
  const watcher = (plugin: MgmPluginName, id: string, load: () => Promise<unknown>, o: { agent?: "read"; budgetMs?: number } = { agent: "read" }): RegisteredSignal =>
    ({ plugin, id, load, ...o }) as unknown as RegisteredSignal;
  const signals = () => readForAssistant(ctx(), { type: "signals" });

  it("runs only the marked and listed watchers, counts over them alone and removes proposals' actions", async () => {
    const unlisted = vi.fn(async () => Array.from({ length: 30 }, (_, i) => ({ ...base, id: `u${i}`, kind: "alarm", severity: "critical" })));
    const unmarked = vi.fn(async () => [{ ...base, id: "m", kind: "alarm" }]);
    snapshot = snapshotOf([], {
      signals: [
        watcher("metering", "metering.connection", async () => [
          { ...base, id: "a", kind: "alarm" },
          { ...base, id: "p", kind: "proposal", action: { action: "metering.check", params: { id: MG }, provenance: { by: "watcher", at: AT } } },
          { ...base, id: "i", kind: "info", severity: "info" },
        ]),
        watcher("metering", "metering.edge-status", unlisted),
        watcher("metering", "metering.unmarked", unmarked, {}),
      ],
      actions: [action("metering", "metering.check", "/api/microgrids/[id]/openems-backend")],
    });
    list({ kind: "watcher", id: "metering.connection" }, { kind: "watcher", id: "metering.unmarked" });
    const out = await signals();
    expect(unlisted).not.toHaveBeenCalled();
    expect(unmarked).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: true,
      value: { type: "assistant-signals", org: ORG_A, count: 3, attention: 2, checked: ["metering.connection"], unchecked: [], off: [] },
    });
    if (!out.ok) throw new Error("refused");
    expect(out.value.top.map((s) => s.source)).toEqual(["metering.connection", "metering.connection", "metering.connection"]);
    expect(out.value.top.find((s) => s.kind === "proposal")).not.toHaveProperty("action");
    expect(JSON.stringify(out)).not.toContain("metering.check");
  });

  it("drops a watcher whose signal carries a refused reference, from the counts too", async () => {
    snapshot = snapshotOf([], {
      signals: [
        watcher("metering", "metering.connection", async () => [{ ...base, id: "a", kind: "alarm" }]),
        watcher("metering", "metering.leaky", async () => [{ ...base, id: "t", kind: "alarm", entity: { kind: "tenant", id: TENANT, label: CANARY } }]),
      ],
    });
    list({ kind: "watcher", id: "metering.connection" }, { kind: "watcher", id: "metering.leaky" });
    const out = await signals();
    expect(out).toMatchObject({ ok: true, value: { count: 1, checked: ["metering.connection"], unchecked: ["metering.leaky"] } });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("reports a listed watcher whose plugin is off as off", async () => {
    const load = vi.fn(async () => []);
    gates.set("metering", DISABLED as GateDecision);
    snapshot = snapshotOf([], { signals: [watcher("metering", "metering.connection", load)] });
    list({ kind: "watcher", id: "metering.connection" });
    expect(await signals()).toMatchObject({ ok: true, value: { count: 0, top: [], checked: [], unchecked: [], off: ["metering.connection"] } });
    expect(load).not.toHaveBeenCalled();
  });

  it("lists a late watcher as unchecked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      snapshot = snapshotOf([], { signals: [watcher("metering", "metering.connection", () => new Promise(() => {}), { agent: "read", budgetMs: 100 })] });
      list({ kind: "watcher", id: "metering.connection" });
      const pending = signals();
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toMatchObject({ ok: true, value: { checked: [], unchecked: ["metering.connection"] } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a super admin's chosen organization's signals", async () => {
    roles = [superAdmin()];
    const load = vi.fn(async () => []);
    snapshot = snapshotOf([], { signals: [watcher("metering", "metering.connection", load)] });
    list({ kind: "watcher", id: "metering.connection" });
    expect(await readForAssistant(ctx(), { type: "signals", org: ORG_B })).toMatchObject({ ok: true, value: { org: ORG_B } });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_B }));
  });
});

describe("readForAssistant's context", () => {
  it("refuses a tenant-only person before any read", async () => {
    roles = [tenantOf(TENANT)];
    const load = vi.fn(async () => []);
    snapshot = snapshotOf([siteDay], { signals: [{ plugin: "metering", id: "metering.connection", agent: "read", load } as unknown as RegisteredSignal] });
    list({ kind: "view", id: "metering.site-day" }, { kind: "watcher", id: "metering.connection" });
    expect(await read(DAY)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    expect(await readForAssistant(ctx(), { type: "signals" })).toMatchObject({ ok: false, status: 403, code: "gui_no_access" });
    expect(loadOf(siteDay)).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses a context hostContext did not issue", async () => {
    await expect(readForAssistant({ ...ctx() }, { type: "view", href: DAY })).rejects.toThrow(/did not issue/);
    await expect(readForAssistant({ ...ctx() }, { type: "signals" })).rejects.toThrow(/did not issue/);
  });
});
