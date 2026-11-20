/**
 * The bill attempts under the period review, through the host (dispatchView
 * in src/lib/gui/host/server/view.ts) with the real view and action
 * definitions: the review lists `payments.bill-attempts` as its Payments
 * tab; the view loads with the period's path and its own `?bill=`, and
 * offers its own actions with no other plugin's; and while Payments is off
 * the tab is still listed and the view loads with the gate's notice, its
 * actions enabled as when Payments is on (whilePluginOff in ../../surface.ts),
 * while billing's actions still follow billing's own state.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateDecision } from "@/lib/runtime/gate";
import type { ActionDef, SurfaceRequest, ViewDef } from "@/lib/gui/surface";
import type { RegisteredAction, RegisteredView, SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";

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
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { PERIOD_REVIEW_LOADED_EXAMPLES } from "@/lib/billing/surface/period-review-examples";
import { PAYMENTS_SURFACE } from "../../surface";
import { BILL_ATTEMPTS_LOADED_EXAMPLES } from "../bill-attempts-examples";

const MG = "e8500000-0000-4000-8002-0000000000a1";
const PERIOD = "e8500000-0000-4000-8002-0000000000b1";
const BILL = "e8500000-0000-4000-8002-0000000000d1";
const PAYMENTS_OFF = {
  ok: false,
  status: 409,
  code: "payments_disabled",
  message: "Payments are disabled for this organization. Enable them in Settings → Plugins; history and reconciliation are preserved.",
} as const;

let gates: Map<string, GateDecision>;
let review: RegisteredView;
let attempts: RegisteredView;

function registered(plugin: RegisteredView["plugin"], def: ViewDef, model: unknown): RegisteredView {
  return { plugin, def: { ...def, load: vi.fn(async () => ({ ok: true, model: structuredClone(model) })) } as ViewDef };
}
const loadOf = (v: RegisteredView) => v.def.load as unknown as ReturnType<typeof vi.fn>;

/** Every action of both plugins, without available(), which reads payments (bill-attempts-actions.test.ts covers it). */
function actions(): SurfaceSnapshot["actions"] {
  const all = [
    ...BILLING_SURFACE.actions!.map((def) => ({ plugin: "billing" as const, def })),
    ...PAYMENTS_SURFACE.actions!.map((def) => ({ plugin: "payments" as const, def })),
  ];
  return new Map(all.map(({ plugin, def }) => [def.id as `${string}.${string}`, { plugin, def: { ...def, available: undefined } as ActionDef } satisfies RegisteredAction]));
}

function ctx() {
  return contextFor(
    [managerOf(ORG_A)],
    vi.fn(
      async () =>
        tableClient({
          microgrids: { data: [{ id: MG, name: "Kiwumu", community_id: null }] },
          billing_periods: { data: [{ id: PERIOD, start_date: "2026-11-01", end_date: "2026-11-30", microgrid_id: MG }] },
        }).client as SupabaseClient,
    ),
  );
}

beforeEach(() => {
  gates = new Map();
  const reviewDef = BILLING_SURFACE.views!.find((v) => v.id === "billing.period-review")!;
  const attemptsDef = PAYMENTS_SURFACE.views!.find((v) => v.id === "payments.bill-attempts")!;
  review = registered("billing", reviewDef, {
    ...PERIOD_REVIEW_LOADED_EXAMPLES[0],
    entity: { kind: "billingPeriod", id: PERIOD, label: "November" },
  });
  attempts = registered("payments", attemptsDef, BILL_ATTEMPTS_LOADED_EXAMPLES[1]);
  snapshot = { views: [review, attempts], actions: actions(), nav: [], signals: [], status: [], search: [], entities: new Map(), guis: [] };
  resolveTargetOrganization.mockReset().mockResolvedValue(ORG_A);
  checkGate.mockReset().mockImplementation(async (_s: unknown, r: { plugin: string }) => gates.get(r.plugin) ?? { ok: true, organizationId: ORG_A });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("payments.bill-attempts under the period review", () => {
  it("is listed as the review's Payments tab", async () => {
    const out = await dispatchView(ctx(), `/microgrids/${MG}/billing/${PERIOD}`);
    expect(out.ok && out.value.attached).toEqual([
      { view: "payments.bill-attempts", title: "Payments", href: `/microgrids/${MG}/billing/${PERIOD}/payments`, hint: "tab" },
    ]);
  });

  it("loads one bill from ?bill=, with the period's path and nothing else", async () => {
    const out = await dispatchView(ctx(), `/microgrids/${MG}/billing/${PERIOD}/payments?bill=${BILL}&ui.tab=x&other=1`);
    expect(out).toMatchObject({ ok: true, value: { view: "payments.bill-attempts", kind: "collection", org: ORG_A } });
    const req = loadOf(attempts).mock.calls[0][0] as SurfaceRequest;
    expect([...req.search]).toEqual([["bill", BILL]]);
    expect(req.params).toEqual({ id: MG, periodId: PERIOD });
    expect(req.organizationId).toBe(ORG_A);
  });

  it("offers its own actions on each attempt, and no other plugin's anywhere", async () => {
    const out = await dispatchView(ctx(), `/microgrids/${MG}/billing/${PERIOD}/payments?bill=${BILL}`);
    if (!out.ok || out.value.kind !== "collection") throw new Error("view did not load");
    expect(out.value.actions).toEqual([]);
    expect(out.value.entity).toBeUndefined();
    const row = out.value.body.rows[0];
    expect(row.actions.map((a) => [a.action, a.enabled, a.from])).toEqual([
      ["payments.refresh-attempt", true, undefined],
      ["payments.record-adjustment", true, undefined],
      ["payments.accept-receipts", true, undefined],
    ]);
    expect(row.actions.find((a) => a.action === "payments.record-adjustment")).toMatchObject({ tone: "danger", prefill: { action: "record_external" } });
  });

  it("while Payments is off, is still the review's Payments tab, and loads with the gate's notice and its actions enabled", async () => {
    gates.set("payments", PAYMENTS_OFF);
    const day = await dispatchView(ctx(), `/microgrids/${MG}/billing/${PERIOD}`);
    expect(day.ok && day.value.attached).toEqual([
      { view: "payments.bill-attempts", title: "Payments", href: `/microgrids/${MG}/billing/${PERIOD}/payments`, hint: "tab" },
    ]);
    const out = await dispatchView(ctx(), `/microgrids/${MG}/billing/${PERIOD}/payments?bill=${BILL}`);
    if (!out.ok || out.value.kind !== "collection") throw new Error("view did not load");
    expect(out.value.notice).toEqual({ tone: "warning", text: PAYMENTS_OFF.message });
    expect(out.value.body.rows[0].actions.map((a) => [a.action, a.enabled, a.reason])).toEqual([
      ["payments.refresh-attempt", true, undefined],
      ["payments.record-adjustment", true, undefined],
      ["payments.accept-receipts", true, undefined],
    ]);
  });

  it("while billing is off, still shows billing's own actions on the review disabled with billing's copy", async () => {
    const BILLING_OFF = { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled for this organization." } as const;
    gates.set("payments", PAYMENTS_OFF);
    gates.set("billing", BILLING_OFF);
    const out = await dispatchView(ctx(), `/microgrids/${MG}/billing/${PERIOD}`);
    if (!out.ok || out.value.kind !== "collection") throw new Error("view did not load");
    const own = [...out.value.actions, ...out.value.body.rows.flatMap((r) => r.actions)];
    expect(own.length).toBeGreaterThan(0);
    for (const a of own) expect([a.action, a.enabled, a.reason]).toEqual([a.action, false, BILLING_OFF.message]);
    expect(out.value.attached.map((a) => a.view)).toEqual(["payments.bill-attempts"]);
  });
});
