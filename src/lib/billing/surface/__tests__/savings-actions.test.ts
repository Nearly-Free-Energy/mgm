/**
 * The savings view's two writes, as billing contributes them: bound to #102's
 * routes and #165's schemas, human-only, and prepared by the host as the
 * kit's form needs them. gui-surface.test.ts holds each action to its route
 * file, the schema the route parses with, the gate and the released routes;
 * savings-actions-flow.test.tsx runs them through the action host.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionRef } from "@/lib/gui/contract";
import type { ActionDef } from "@/lib/gui/surface";
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

import { cleanPrefill } from "@/lib/gui/host/server/merge";
import { prepareAction } from "@/lib/gui/host/server/prepare";
import { ORG_A, contextFor, managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import { appendTargetedActions, type ActionSlots } from "@/lib/gui/host/shared/merge-actions";
import { BILLING_SURFACE } from "../../surface";
import { SAVINGS_EXAMPLES } from "../examples";

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

  it("are appended, from Billing, to another plugin's view of the microgrid, as targeted actions are", () => {
    const page: ActionSlots<ActionRef> = {
      kind: "metrics",
      body: { tiles: [] },
      actions: [],
      entity: { kind: "microgrid", id: MG, label: "North" },
    };
    const merged = appendTargetedActions(
      page,
      {
        plugin: "metering",
        actions: actions.map((a) => ({ plugin: "billing" as const, def: a })),
        scope: { microgrid: { kind: "microgrid", id: MG, label: "North" } },
        gate: new Map([["billing", { ok: true }]]),
        isReleased: () => true,
      },
    );
    // In id order, with no prefill: the savings view's own copies carry that.
    expect(merged.model.actions.map((a) => [a.action, a.params, a.from])).toEqual([
      ["billing.grid-tariff-add", { id: MG }, "Billing"],
      ["billing.savings-settings", { id: MG }, "Billing"],
    ]);
    expect(merged.model.actions.map((a) => a.prefill)).toEqual([undefined, undefined]);
  });
});
