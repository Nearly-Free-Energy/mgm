/**
 * The savings under the Operations day, through the host (dispatchView in
 * src/lib/gui/host/server/view.ts) with the real view definitions: the day
 * lists `billing.savings` as a section with its own `?date=`, the savings
 * loader receives that date and nothing else, and while Billing is off the
 * section is still listed and loads as Billing's notice, which the GUI shows
 * in its place.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateDecision } from "@/lib/runtime/gate";
import type { SurfaceRequest, ViewDef } from "@/lib/gui/surface";
import type { RegisteredView, SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { dispatchView } from "@/lib/gui/host/server/view";
import { ORG_A, contextFor, managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { SITE_DAY_LOADED_EXAMPLES } from "@/lib/metering/surface/examples";
import { BILLING_SURFACE } from "../../surface";
import { SAVINGS_LOADED_EXAMPLES } from "../examples";

const MG = "e7600000-0000-4000-8002-0000000000a1";
const BILLING_OFF = { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled for this organization." } as const;

let gates: Map<string, GateDecision>;
let siteDay: RegisteredView;
let savings: RegisteredView;

/** A real view definition whose loader answers `model` and records each request. */
function registered(plugin: RegisteredView["plugin"], def: ViewDef, model: unknown): RegisteredView {
  return { plugin, def: { ...def, load: vi.fn(async () => ({ ok: true, model: structuredClone(model) })) } as ViewDef };
}
const loadOf = (v: RegisteredView) => v.def.load as unknown as ReturnType<typeof vi.fn>;

function ctx() {
  return contextFor([managerOf(ORG_A)], vi.fn(async () => tableClient({ microgrids: { data: [{ id: MG, name: "Kiwumu", community_id: null }] } }).client as SupabaseClient));
}

beforeEach(() => {
  gates = new Map();
  const day = METERING_SURFACE.views!.find((v) => v.id === "metering.site-day")!;
  const saved = BILLING_SURFACE.views!.find((v) => v.id === "billing.savings")!;
  // The day's example with this microgrid as its entity, so the host's parse holds.
  siteDay = registered("metering", day, { ...SITE_DAY_LOADED_EXAMPLES[0], entity: { kind: "microgrid", id: MG, label: "Kiwumu" } });
  savings = registered("billing", saved, SAVINGS_LOADED_EXAMPLES[0]);
  snapshot = { views: [siteDay, savings], actions: new Map(), nav: [], signals: [], status: [], search: [], entities: new Map(), guis: [] };
  resolveTargetOrganization.mockReset().mockResolvedValue(ORG_A);
  checkGate.mockReset().mockImplementation(async (_s: unknown, r: { plugin: string }) => gates.get(r.plugin) ?? { ok: true, organizationId: ORG_A });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("billing.savings under the Operations day", () => {
  it("is listed as a section of the day, with the day's date", async () => {
    const out = await dispatchView(ctx(), `/microgrids/${MG}/operations?date=2026-11-05&ui.tab=x&other=1`);
    expect(out.ok && out.value.attached).toEqual([
      { view: "billing.savings", title: "What the site saved", href: `/microgrids/${MG}/operations/savings?date=2026-11-05`, hint: "section" },
    ]);
  });

  it("is listed without a date when the day has none", async () => {
    const out = await dispatchView(ctx(), `/microgrids/${MG}/operations`);
    expect(out.ok && out.value.attached.map((a) => a.href)).toEqual([`/microgrids/${MG}/operations/savings`]);
  });

  it("loads from the listed href with that date alone, with the day as its Operations tab", async () => {
    const day = await dispatchView(ctx(), `/microgrids/${MG}/operations?date=2026-11-05`);
    const href = day.ok ? day.value.attached[0].href : "";
    const out = await dispatchView(ctx(), `${href}&ui.x=1&other=2`);
    expect(out).toMatchObject({ ok: true, value: { view: "billing.savings", kind: "metrics", org: ORG_A } });
    expect(out.ok && out.value.attached).toEqual([
      { view: "metering.site-day", title: "Operations", href: `/microgrids/${MG}/operations?date=2026-11-05`, hint: "tab" },
    ]);
    const req = loadOf(savings).mock.calls[0][0] as SurfaceRequest;
    expect([...req.search]).toEqual([["date", "2026-11-05"]]);
    expect(req.params).toEqual({ id: MG });
    expect(req.organizationId).toBe(ORG_A);
  });

  it("while Billing is off, stays listed and loads as Billing's notice, without running the loader (decision 18)", async () => {
    gates.set("billing", BILLING_OFF);
    const day = await dispatchView(ctx(), `/microgrids/${MG}/operations?date=2026-11-05`);
    const href = day.ok ? day.value.attached[0]?.href : undefined;
    expect(href).toBe(`/microgrids/${MG}/operations/savings?date=2026-11-05`);
    expect(await dispatchView(ctx(), href!)).toEqual(BILLING_OFF);
    expect(loadOf(savings)).not.toHaveBeenCalled();
  });

  it("passes the generated figures' notice on", async () => {
    const out = await dispatchView(ctx(), `/microgrids/${MG}/operations/savings`);
    expect(out.ok && out.value.notice?.text).toMatch(/^Synthetic data/);
  });
});
