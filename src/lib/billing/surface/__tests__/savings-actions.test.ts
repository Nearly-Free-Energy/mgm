/**
 * The savings view's two writes, as billing contributes them: bound to #102's
 * routes and #165's schemas, human-only, and prepared by the host as the
 * kit's form needs them, and offered only by the savings view, which starts
 * them from the stored values: never appended to the Operations day's own
 * window bar. gui-surface.test.ts holds each action to its route file, the
 * schema the route parses with, the gate and the released routes;
 * savings-actions-flow.test.tsx runs them through the action host.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionRef, Json } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionDef, ActionLink, SurfaceRequest } from "@/lib/gui/surface";
import type { RegisteredAction, SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";
import { ADD_GRID_TARIFF_BODY_VERSION, AddGridTariffBody, SAVE_SAVINGS_SETTINGS_BODY_VERSION, SaveSavingsSettingsBody } from "../../schemas";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: async () => snapshot }));
// The savings loader's metering read: no days, so the ready state's figures are empty.
const composeMetering = vi.fn();
vi.mock("@/lib/metering/compose", () => ({ composeMetering: (...args: unknown[]) => composeMetering(...args) }));

import { invoke } from "@/lib/gui/host/client/invoke";
import { cleanPrefill, resolveOwnAndTargeted } from "@/lib/gui/host/server/merge";
import { prepareAction, type PreparedAction } from "@/lib/gui/host/server/prepare";
import { ORG_A, ORG_B, contextFor, managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { ActionSlots, MergeInput } from "@/lib/gui/host/shared/merge-actions";
import { SITE_DAY_LOADED_EXAMPLES } from "@/lib/metering/surface/examples";
import { BILLING_SURFACE } from "../../surface";
import { SAVINGS_EXAMPLES } from "../examples";
import { loadSavings, SAVINGS_REFUSALS } from "../savings";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const actions = BILLING_SURFACE.actions as ActionDef[];
const def = (id: string) => actions.find((a) => a.id === id)!;
const SETTINGS = def("billing.savings-settings");
const TARIFF = def("billing.grid-tariff-add");
/** The JSON Schema the host sends the form: the whole body, since only the path is bound. */
const formSchema = (input: z.ZodType) => JSON.parse(JSON.stringify(z.toJSONSchema(input, { io: "input" })));

const prepare = (body: unknown) =>
  prepareAction(
    contextFor([managerOf(ORG_A)], async () => tableClient({ microgrids: { data: [{ id: MG, name: "North", community_id: null }] } }).client as SupabaseClient),
    body,
  );

beforeEach(() => {
  snapshot = {
    views: [],
    actions: new Map(actions.map((a): [ActionDef["id"], RegisteredAction] => [a.id, { plugin: "billing", def: a }])),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
  checkGate.mockReset().mockResolvedValue({ ok: true, organizationId: ORG_A });
  resolveTargetOrganization.mockReset().mockResolvedValue(ORG_A);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("billing's savings actions", () => {
  it("are the settings and tariff writes on #102's routes, parsed with #165's schemas", () => {
    expect(actions.map((a) => a.id)).toEqual(["billing.savings-settings", "billing.grid-tariff-add"]);
    expect(SETTINGS).toMatchObject({
      target: "microgrid",
      method: "PUT",
      path: "/api/microgrids/[id]/savings-settings",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    });
    expect(SETTINGS.input).toBe(SaveSavingsSettingsBody);
    expect(SETTINGS.inputVersion).toBe(SAVE_SAVINGS_SETTINGS_BODY_VERSION);
    expect(TARIFF).toMatchObject({
      target: "microgrid",
      method: "POST",
      path: "/api/microgrids/[id]/grid-tariffs",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
    });
    expect(TARIFF.input).toBe(AddGridTariffBody);
    expect(TARIFF.inputVersion).toBe(ADD_GRID_TARIFF_BODY_VERSION);
  });

  it("contribute no delete: removing a tariff version stays on the Rates page", () => {
    expect(actions.filter((a) => a.method === "DELETE" || a.path.includes("[tariffId]"))).toEqual([]);
  });

  it("are prepared with the whole body as the form, and no confirmation step for the settings", async () => {
    const settings = await prepare({ action: SETTINGS.id, params: { id: MG } });
    expect(settings).toEqual({
      ok: true,
      value: {
        type: "prepared",
        spec: { type: "spec", id: SETTINGS.id, title: "Edit savings settings", confirm: "none", inputVersion: 1, input: formSchema(SaveSavingsSettingsBody) },
        confirm: "none",
        method: "PUT",
        path: `/api/microgrids/${MG}/savings-settings`,
        bound: {},
        ceremony: null,
      },
    });
    const tariff = await prepare({ action: TARIFF.id, params: { id: MG } });
    expect(tariff).toMatchObject({
      ok: true,
      value: {
        spec: { id: TARIFF.id, title: "Add a grid tariff version", confirm: "confirm", input: formSchema(AddGridTariffBody) },
        confirm: "confirm",
        method: "POST",
        path: `/api/microgrids/${MG}/grid-tariffs`,
      },
    });
    // The checks the gate runs are a write's, as the route will ask.
    expect(checkGate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ plugin: "billing", access: "write" }));
  });

  it.each([
    ["an assistant's proposal", { by: "assistant", proposal: "e7100000-0000-4000-8009-0000000000c1", at: "2026-11-09T08:00:00Z" }],
    ["a watcher's proposal", { by: "watcher", at: "2026-11-09T08:00:00Z" }],
  ])("are not proposable: %s is refused", async (_name, provenance) => {
    for (const a of [SETTINGS, TARIFF]) {
      expect(await prepare({ action: a.id, params: { id: MG }, provenance })).toMatchObject({ ok: false, status: 403, code: "gui_human_only" });
    }
  });

  it("keep the loader's starting values, and refuse ones the route would refuse", async () => {
    for (const example of SAVINGS_EXAMPLES.slice(0, 2)) {
      for (const ref of example.actions) {
        if (ref.prefill === undefined) continue;
        expect(cleanPrefill(def(ref.action), ref.prefill), ref.action).toEqual(ref.prefill);
      }
    }
    const prefilled = await prepare({ action: SETTINGS.id, params: { id: MG }, body: { solar_savings_from: "2026-10-01", arbitrage_from: null, round_trip_efficiency: 0.85 } });
    expect(prefilled).toMatchObject({ ok: true, value: { prefill: { solar_savings_from: "2026-10-01", arbitrage_from: null, round_trip_efficiency: 0.85 } } });
    expect(await prepare({ action: SETTINGS.id, params: { id: MG }, body: { round_trip_efficiency: 0 } })).toMatchObject({ ok: false, status: 400 });
    const gap = { bands: [{ from_hour: 0, to_hour: 6, rate: 1 }, { from_hour: 8, to_hour: 24, rate: 1 }] };
    expect(await prepare({ action: TARIFF.id, params: { id: MG }, body: gap })).toMatchObject({ ok: false, status: 400 });
  });
});

// ── From the Operations day ─────────────────────────────────────────────────

const NORTH = { kind: "microgrid", id: MG, label: "North" } as const;
const STORED = { solar_savings_from: "2026-10-01", arbitrage_from: "2026-11-01", round_trip_efficiency: "0.85" };
const OLDER_BANDS = [{ from_hour: 0, to_hour: 24, rate: 500 }];
// Stored out of hour order: the form gets them in hour order.
const NEWER_BANDS = [
  { from_hour: 18, to_hour: 24, rate: 910 },
  { from_hour: 0, to_hour: 6, rate: 520 },
  { from_hour: 6, to_hour: 18, rate: 780 },
];
const TARIFF_ROWS = [
  { effective_from: "2026-09-01", bands: NEWER_BANDS },
  { effective_from: "2026-01-01", bands: OLDER_BANDS },
];

/** The merge input the host builds for a view of NORTH contributed by `plugin`, with every registered action. */
const mergeInput = (plugin: MergeInput["plugin"]): MergeInput => ({
  plugin,
  actions: [...snapshot.actions.values()],
  scope: { microgrid: NORTH },
  gate: new Map([
    ["billing", { ok: true }],
    ["metering", { ok: true }],
  ]),
  isReleased: () => true,
});

/** The Operations day's window bar, as the host resolves `metering.site-day`'s model. */
function siteDayBar(): ActionRef[] {
  const loaded = SITE_DAY_LOADED_EXAMPLES[0];
  const model = { kind: "metrics", body: loaded.body, actions: loaded.actions, entity: NORTH } as ActionSlots<ActionLink>;
  return resolveOwnAndTargeted(model, mergeInput("metering"), snapshot.actions).model.actions;
}

/** The savings section attached under the day: loaded with the person's own client, then resolved as the host resolves it. */
async function savingsSection(tables: Record<string, { data: unknown }>): Promise<ActionRef[]> {
  const { client, calls } = tableClient(tables);
  const req: SurfaceRequest = {
    supabase: client,
    user: { id: "u1" } as User,
    roles: [managerOf(ORG_A)],
    organizationId: ORG_A,
    params: { id: MG },
    search: new URLSearchParams("date=2026-11-08"),
    locale: "en-GB",
    now: new Date("2026-11-09T08:00:00Z"),
    fmt: createFmt({ locale: "en-GB" }),
  };
  const loaded = await loadSavings(req);
  if (!loaded.ok) throw new Error(`the savings refused: ${loaded.message}`);
  expect(calls.map((c) => c.table).sort()).toEqual(["grid_tariffs", "microgrid_savings_settings", "microgrids"]);
  const model = { kind: "metrics", body: loaded.model.body, actions: loaded.model.actions, entity: NORTH } as ActionSlots<ActionLink>;
  return resolveOwnAndTargeted(model, mergeInput("billing"), snapshot.actions).model.actions;
}

/** What /api/gui/prepare answers when the ref is pressed: the client sends the ref's prefill as the body. */
async function press(ref: ActionRef): Promise<PreparedAction> {
  const out = await prepare({ action: ref.action, params: ref.params, ...(ref.prefill === undefined ? {} : { body: ref.prefill }) });
  if (!out.ok) throw new Error(`prepare refused ${ref.action}: ${out.message}`);
  return out.value;
}

/** The body the host sends when the kit's form is submitted with the values it started from. */
async function sentBody(prepared: PreparedAction): Promise<unknown> {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const result = await invoke(prepared, (prepared.prefill ?? null) as Json | null, { level: prepared.confirm }, fetch);
  expect(result).toMatchObject({ ok: true });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect([url, init.method]).toEqual([prepared.path, prepared.method]);
  return JSON.parse(init.body as string);
}

describe("billing's savings actions from the Operations day", () => {
  beforeEach(() => {
    composeMetering.mockReset().mockResolvedValue({
      ok: true,
      data: { metering: { getSiteDays: async () => ({ ok: true, data: [] }) }, dispose: async () => {} },
    });
  });

  it("are not added to the day's own window bar, where they would open without the stored values", () => {
    const bar = siteDayBar();
    expect(bar.map((a) => a.action)).not.toContain(SETTINGS.id);
    expect(bar.map((a) => a.action)).not.toContain(TARIFF.id);
    // The flag is what keeps them off: the same action without it is appended, from Billing, with no prefill.
    const loose = { ...SETTINGS, id: "billing.loose-copy" as const, targeted: undefined } as ActionDef;
    snapshot = { ...snapshot, actions: new Map([...snapshot.actions, [loose.id, { plugin: "billing", def: loose }]]) };
    expect(siteDayBar().map((a) => [a.action, a.from, a.prefill])).toContainEqual(["billing.loose-copy", "Billing", undefined]);
  });

  it("open from the savings section with the stored settings and the newest tariff's bands, and saving keeps both dates", async () => {
    const refs = await savingsSection({
      microgrids: { data: [{ id: MG, timezone: "Africa/Kampala", currency: "UGX" }] },
      grid_tariffs: { data: TARIFF_ROWS },
      microgrid_savings_settings: { data: STORED },
    });
    expect(refs.map((r) => r.action)).toEqual([SETTINGS.id, TARIFF.id]);
    const [settingsRef, tariffRef] = refs;
    expect(refs.every((r) => r.from === undefined && r.enabled)).toBe(true);

    const settings = await press(settingsRef);
    expect(settings.prefill).toEqual({ solar_savings_from: "2026-10-01", arbitrage_from: "2026-11-01", round_trip_efficiency: 0.85 });
    expect(settings.confirm).toBe("none");
    const body = await sentBody(settings);
    expect(SaveSavingsSettingsBody.parse(body)).toEqual({
      solar_savings_from: "2026-10-01",
      arbitrage_from: "2026-11-01",
      round_trip_efficiency: 0.85,
    });

    const tariff = await press(tariffRef);
    expect(tariff.prefill).toEqual({
      bands: [
        { from_hour: 0, to_hour: 6, rate: 520 },
        { from_hour: 6, to_hour: 18, rate: 780 },
        { from_hour: 18, to_hour: 24, rate: 910 },
      ],
    });
    // The tariff still asks for the host's Confirm; the prefill does not change the level.
    expect(tariff.confirm).toBe("confirm");
  });

  it("keep a date that was never stored empty, and the stored one as it is", async () => {
    const refs = await savingsSection({
      microgrids: { data: [{ id: MG, timezone: "Africa/Kampala", currency: "UGX" }] },
      grid_tariffs: { data: TARIFF_ROWS },
      microgrid_savings_settings: { data: { ...STORED, arbitrage_from: null } },
    });
    const body = await sentBody(await press(refs[0]));
    expect(SaveSavingsSettingsBody.parse(body)).toEqual({ solar_savings_from: "2026-10-01", arbitrage_from: null, round_trip_efficiency: 0.85 });
  });

  it("with no settings row and no tariff, start from the default efficiency and one empty tariff row", async () => {
    const refs = await savingsSection({
      microgrids: { data: [{ id: MG, timezone: "Africa/Kampala", currency: "UGX" }] },
      grid_tariffs: { data: [] },
      microgrid_savings_settings: { data: null },
    });
    const [settingsRef, tariffRef] = refs;
    const settings = await press(settingsRef);
    expect(settings.prefill).toEqual({ solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: 0.9 });
    // Nothing was stored, so saving as opened clears nothing.
    expect(SaveSavingsSettingsBody.parse(await sentBody(settings))).toEqual({ solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: 0.9 });
    // No prefill: the kit's form starts the bands array with one empty row (savings-actions-flow.test.tsx).
    expect(tariffRef.prefill).toBeUndefined();
    expect(await press(tariffRef)).not.toHaveProperty("prefill");
  });

  it("are refused for a microgrid the person cannot see, and the savings tables are not read", async () => {
    // Row-level security hides the microgrid: neither the host's prepare nor the loader gets further.
    for (const a of [SETTINGS, TARIFF]) {
      const { client, calls } = tableClient({ microgrids: { data: null } });
      const out = await prepareAction(contextFor([managerOf(ORG_A)], async () => client), { action: a.id, params: { id: MG } });
      expect(out).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
      expect(calls.map((c) => c.table)).toEqual(["microgrids"]);
    }
    const { client, calls } = tableClient({ microgrids: { data: null } });
    const req = { supabase: client, params: { id: MG }, search: new URLSearchParams(), fmt: createFmt({ locale: "en-GB" }) } as unknown as SurfaceRequest;
    expect(await loadSavings(req)).toEqual(SAVINGS_REFUSALS.notFound);
    expect(calls.map((c) => c.table)).toEqual(["microgrids"]);

    // A microgrid in another organization, whatever the client returns: the person's roles decide.
    resolveTargetOrganization.mockResolvedValue(ORG_B);
    for (const a of [SETTINGS, TARIFF]) {
      const visible = tableClient({ microgrids: { data: [{ id: MG, name: "Elsewhere", community_id: null }] } });
      const out = await prepareAction(contextFor([managerOf(ORG_A)], async () => visible.client), { action: a.id, params: { id: MG } });
      expect(out).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
      expect(visible.calls.map((c) => c.table)).not.toContain("microgrid_savings_settings");
      expect(visible.calls.map((c) => c.table)).not.toContain("grid_tariffs");
    }
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("stay human-only from the section: a proposal carrying the section's prefill is refused", async () => {
    const refs = await savingsSection({
      microgrids: { data: [{ id: MG, timezone: "Africa/Kampala", currency: "UGX" }] },
      grid_tariffs: { data: TARIFF_ROWS },
      microgrid_savings_settings: { data: STORED },
    });
    for (const ref of refs) {
      const out = await prepare({ action: ref.action, params: ref.params, body: ref.prefill, provenance: { by: "assistant", at: "2026-11-09T08:00:00Z" } });
      expect(out).toMatchObject({ ok: false, status: 403, code: "gui_human_only" });
    }
  });
});
