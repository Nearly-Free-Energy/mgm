/**
 * The period review's actions, as billing contributes them: generating a
 * draft's bills, regenerating one bill on its own route, correcting an
 * unmetered bill's usage, and the five payment-status transitions on the
 * payment-status route. All human-only and money; prepared by the host as
 * the kit needs them. gui-surface.test.ts holds each action to its route
 * file, schema, gate and released routes, and parity.test.ts to the parity
 * table.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRef, Json } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionDef, ActionLink, SurfaceRequest } from "@/lib/gui/surface";
import type { RegisteredAction, SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";
import {
  GENERATE_BILLS_BODY_VERSION,
  GenerateBillsBody,
  LINE_ITEM_PAYMENT_STATUS_BODY_VERSION,
  LINE_ITEM_USAGE_BODY_VERSION,
  LineItemPaymentStatusBody,
  LineItemUsageBody,
  REGENERATE_BILL_BODY_VERSION,
  RegenerateBillBody,
} from "../../schemas";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
vi.mock("@/lib/gui/host/server/snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { invoke } from "@/lib/gui/host/client/invoke";
import { hostContext } from "@/lib/gui/host/server/access";
import { checkAvailability, resolveOwnAndTargeted, UNCHECKED_REASON } from "@/lib/gui/host/server/merge";
import { prepareAction, type PreparedAction } from "@/lib/gui/host/server/prepare";
import { ORG_A, managerOf, superAdmin, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { ActionSlots, MergeInput } from "@/lib/gui/host/shared/merge-actions";
import type { UserRoleRecord } from "@/lib/types/domain";
import { BILLING_SURFACE } from "../../surface";
import {
  BILL_REFUSALS,
  GENERATE_CLOSED_REASON,
  generateBillsAvailable,
  recordUsageAvailable,
  regenerateBillAvailable,
  USAGE_REASONS,
} from "../period-review";
import { PERIOD_REVIEW_LOADED_EXAMPLES } from "../period-review-examples";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const PERIOD = "e7100000-0000-4000-8003-0000000000b1";
const BILL = "e7100000-0000-4000-8005-0000000000c1";
const TENANT = "e7100000-0000-4000-8004-0000000000d1";
const actions = BILLING_SURFACE.actions as ActionDef[];
const def = (id: string) => actions.find((a) => a.id === id)!;
const GENERATE = def("billing.generate-bills");
const REGENERATE = def("billing.regenerate-bill");
const USAGE = def("billing.record-usage");
const PAYMENT_IDS = ["billing.mark-paid", "billing.mark-unpaid", "billing.mark-refunded", "billing.mark-failed", "billing.cancel-payment-link"];
const USER = { id: "e7100000-0000-4000-8fff-000000000001", email: "host@test.local" } as User;

/** A host context with the real Fmt, since the ceremonies format their facts. */
function contextWith(client: SupabaseClient, roles: UserRoleRecord[] = [managerOf(ORG_A)]) {
  const made = hostContext({ user: USER, roles }, new Headers({ "accept-language": "en-GB" }), {
    newClient: async () => client,
    makeFmt: (locale) => createFmt({ locale }),
    now: new Date("2026-11-18T08:00:00Z"),
  });
  if (!made.ok) throw new Error("fixture context refused");
  return made.ctx;
}

const OCTOBER = { id: PERIOD, microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft" };
const billRow = (o: Record<string, unknown> = {}, period: Record<string, unknown> = {}) => ({
  id: BILL,
  billing_period_id: PERIOD,
  tenant_id: TENANT,
  device_id: null,
  start_kwh: 0,
  total_amount: 5000,
  payment_status: "unpaid",
  tenants: { display_name: "Akello" },
  billing_periods: { ...OCTOBER, ...period, microgrids: { currency: "UGX" } },
  ...o,
});

const tables = (o: { bill?: unknown; period?: unknown; links?: unknown[]; billError?: boolean } = {}) =>
  tableClient({
    microgrids: { data: [{ id: MG, name: "North", community_id: null }] },
    billing_periods: { data: o.period === undefined ? [OCTOBER] : o.period },
    billing_line_items: o.billError ? { data: null, error: { message: "permission denied" } } : { data: o.bill === undefined ? [billRow()] : o.bill },
    tenant_devices: { data: o.links ?? [] },
  });

const prepare = (body: unknown, client = tables().client, roles?: UserRoleRecord[]) => prepareAction(contextWith(client, roles), body);
const onBill = (action: string, o: { body?: Json } = {}) => ({ action, params: { lineItemId: BILL }, ...o });

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

describe("the period review's actions", () => {
  it("generate a draft's bills on the generate route, offered only by the review", () => {
    expect(GENERATE).toMatchObject({
      id: "billing.generate-bills",
      title: "Generate bills",
      target: "billingPeriod",
      method: "POST",
      path: "/api/billing/generate",
      bind: { body: { billingPeriodId: "billingPeriod" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
    });
    expect(GENERATE.input).toBe(GenerateBillsBody);
    expect(GENERATE.inputVersion).toBe(GENERATE_BILLS_BODY_VERSION);
    expect(GENERATE.prepare).toBeUndefined();
    expect(typeof GENERATE.available).toBe("function");
  });

  it("regenerate one bill on its own route, targeted, with availability and a prepare", () => {
    expect(REGENERATE).toMatchObject({
      id: "billing.regenerate-bill",
      title: "Regenerate bill",
      target: "lineItem",
      method: "POST",
      path: "/api/billing-line-items/[lineItemId]/regenerate",
      bind: { path: { lineItemId: "lineItem" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
    });
    expect(REGENERATE).not.toHaveProperty("targeted");
    expect(REGENERATE.input).toBe(RegenerateBillBody);
    expect(REGENERATE.inputVersion).toBe(REGENERATE_BILL_BODY_VERSION);
    expect(typeof REGENERATE.prepare).toBe("function");
    expect(typeof REGENERATE.available).toBe("function");
  });

  it("correct an unmetered bill's usage on the usage route, with no confirmation step", () => {
    expect(USAGE).toMatchObject({
      id: "billing.record-usage",
      title: "Correct usage",
      target: "lineItem",
      method: "PATCH",
      path: "/api/billing-line-items/[lineItemId]/usage",
      bind: { path: { lineItemId: "lineItem" } },
      risk: "money",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    });
    expect(USAGE.input).toBe(LineItemUsageBody);
    expect(USAGE.inputVersion).toBe(LINE_ITEM_USAGE_BODY_VERSION);
    expect(USAGE.prepare).toBeUndefined();
    expect(typeof USAGE.available).toBe("function");
  });

  it.each([
    ["billing.mark-paid", "Mark as paid", "confirm"],
    ["billing.mark-unpaid", "Mark as unpaid", "confirm"],
    ["billing.mark-refunded", "Mark as refunded", "confirm"],
    ["billing.mark-failed", "Mark as failed", "confirm"],
    ["billing.cancel-payment-link", "Cancel pending link", "confirm"],
  ])("%s on the payment-status route, prepared, with no available()", (id, title, confirm) => {
    expect(def(id)).toMatchObject({
      title,
      target: "lineItem",
      method: "PATCH",
      path: "/api/billing-line-items/[lineItemId]/payment-status",
      bind: { path: { lineItemId: "lineItem" } },
      risk: "money",
      confirm,
      humanOnly: true,
      targeted: false,
    });
    expect(def(id).input).toBe(LineItemPaymentStatusBody);
    expect(def(id).inputVersion).toBe(LINE_ITEM_PAYMENT_STATUS_BODY_VERSION);
    expect(typeof def(id).prepare).toBe("function");
    expect(def(id).available).toBeUndefined();
  });
});

// ── In the review ───────────────────────────────────────────────────────────

const mergeInput = (): MergeInput => ({
  plugin: "billing",
  actions: [...snapshot.actions.values()],
  scope: { microgrid: { kind: "microgrid", id: MG, label: "North" } },
  gate: new Map([["billing", { ok: true }]]),
  isReleased: () => true,
});

describe("the period review's actions in the view", () => {
  it.each(PERIOD_REVIEW_LOADED_EXAMPLES.map((m, i) => [i, m] as const))(
    "resolve every link of example %i, and keep every prefill as the loader gave it",
    (_i, loaded) => {
      const model = { kind: "collection", body: loaded.body, actions: loaded.actions, entity: loaded.entity } as ActionSlots<ActionLink>;
      const { model: resolved, dropped } = resolveOwnAndTargeted(model, mergeInput(), snapshot.actions);
      // Check 5 (gui-surface.test.ts) would not see a dropped prefill, so it is checked here.
      expect(dropped).toEqual([]);
      if (resolved.kind !== "collection") throw new Error("not a collection");
      const given = loaded.body.rows.flatMap((r) => r.actions.map((a) => a.prefill));
      const kept = resolved.body.rows.flatMap((r) => r.actions.map((a) => a.prefill));
      expect(kept).toEqual(given);
      expect(resolved.body.rows.flatMap((r) => r.actions).every((a) => a.enabled && a.tone === undefined)).toBe(true);
    },
  );
});

// ── Availability ────────────────────────────────────────────────────────────

const req = (client: SupabaseClient) => ({ supabase: client }) as unknown as SurfaceRequest;
const GONE = "e7100000-0000-4000-8005-0000000000ff";

describe("availability", () => {
  it("offers Generate on a draft, and explains a closed or missing period", async () => {
    const CLOSED = "e7100000-0000-4000-8003-0000000000b2";
    const { client, calls } = tableClient({ billing_periods: { data: [{ id: PERIOD, status: "draft" }, { id: CLOSED, status: "closed" }] } });
    expect(await generateBillsAvailable(req(client), [PERIOD, CLOSED, GONE])).toEqual({
      [PERIOD]: true,
      [CLOSED]: GENERATE_CLOSED_REASON,
      [GONE]: "This billing period could not be found.",
    });
    expect(calls).toEqual([{ table: "billing_periods", ops: [["select", ["id, status"]], ["in", ["id", [PERIOD, CLOSED, GONE]]]] }]);
  });

  it("offers regenerating any bill but a refunded one", async () => {
    const REFUNDED = "e7100000-0000-4000-8005-0000000000c2";
    const { client, calls } = tableClient({
      billing_line_items: { data: [{ id: BILL, payment_status: "paid" }, { id: REFUNDED, payment_status: "refunded" }] },
    });
    expect(await regenerateBillAvailable(req(client), [BILL, REFUNDED, GONE])).toEqual({
      [BILL]: true,
      [REFUNDED]: BILL_REFUSALS.refunded.message,
      [GONE]: BILL_REFUSALS.notFound.message,
    });
    expect(calls).toHaveLength(1);
  });

  it("offers a usage correction where the usage route accepts one, with its copy, in two reads", async () => {
    const id = (n: number) => `e7100000-0000-4000-8005-00000000000${n}`;
    const tenant = (n: number) => `e7100000-0000-4000-8004-00000000000${n}`;
    const row = (n: number, o: Record<string, unknown> = {}, status = "draft") => ({
      id: id(n),
      tenant_id: tenant(n),
      device_id: null,
      start_kwh: 0,
      billing_periods: { status, start_date: "2026-10-01", end_date: "2026-10-31" },
      ...o,
    });
    const { client, calls } = tableClient({
      billing_line_items: {
        data: [row(1), row(2, {}, "closed"), row(3, { device_id: "e7100000-0000-4000-8006-000000000001" }), row(4), row(5, { start_kwh: null }), row(6)],
      },
      tenant_devices: {
        data: [
          { tenant_id: tenant(4), effective_from: "2026-10-15", effective_to: null },
          // Ended before the period: not a meter in it.
          { tenant_id: tenant(6), effective_from: "2026-01-01", effective_to: "2026-10-01" },
        ],
      },
    });
    expect(await recordUsageAvailable(req(client), [1, 2, 3, 4, 5, 6].map(id).concat(GONE))).toEqual({
      [id(1)]: true,
      [id(2)]: USAGE_REASONS.closed,
      [id(3)]: USAGE_REASONS.metered,
      [id(4)]: USAGE_REASONS.metered,
      [id(5)]: USAGE_REASONS.noStart,
      [id(6)]: true,
      [GONE]: BILL_REFUSALS.notFound.message,
    });
    expect(calls.map((c) => c.table)).toEqual(["billing_line_items", "tenant_devices"]);
    expect(calls[1].ops).toContainEqual(["eq", ["role", "primary_consumption_meter"]]);
  });

  it.each([
    ["generate-bills", generateBillsAvailable, "billing_periods"],
    ["regenerate-bill", regenerateBillAvailable, "billing_line_items"],
    ["record-usage", recordUsageAvailable, "billing_line_items"],
  ] as const)("%s throws on a failed read, so the host shows it as not checked", async (_label, available, table) => {
    const { client } = tableClient({ [table]: { data: null, error: { message: "permission denied" } } });
    await expect(available(req(client), [BILL])).rejects.toThrow();
    const ref: ActionRef = { action: `billing.${_label}`, params: _label === "generate-bills" ? { billingPeriodId: PERIOD } : { lineItemId: BILL }, label: "x", enabled: true };
    const [checked] = (
      await checkAvailability({ kind: "record", body: { sections: [] }, actions: [ref] }, { actions: snapshot.actions, request: async () => req(client) })
    ).actions;
    expect(checked).toMatchObject({ enabled: false, reason: UNCHECKED_REASON });
  });

  it("record-usage throws when the meter assignments cannot be read", async () => {
    const { client } = tableClient({
      billing_line_items: { data: [{ id: BILL, tenant_id: TENANT, device_id: null, start_kwh: 0, billing_periods: OCTOBER }] },
      tenant_devices: { data: null, error: { message: "permission denied" } },
    });
    await expect(recordUsageAvailable(req(client), [BILL])).rejects.toThrow();
  });
});

// ── Prepare, end to end ─────────────────────────────────────────────────────

/** The body the host sends for `prepared` with the form's values; the result must be ok. */
async function sent(prepared: PreparedAction, form: Json | null, level: "none" | "confirm"): Promise<unknown> {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
  expect(await invoke(prepared, form, { level }, fetch)).toMatchObject({ ok: true });
  const [url, init] = fetch.mock.calls[0];
  expect([url, init.method]).toEqual([prepared.path, prepared.method]);
  return JSON.parse(init.body as string);
}

describe("preparing the period review's actions", () => {
  it("prepares Generate with the period bound, and sends a body GenerateBillsBody parses", async () => {
    const out = await prepare({ action: GENERATE.id, params: { billingPeriodId: PERIOD } });
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({ confirm: "confirm", method: "POST", path: "/api/billing/generate", bound: { billingPeriodId: PERIOD }, ceremony: null });
    expect(GenerateBillsBody.parse(await sent(out.value, {}, "confirm"))).toEqual({ billingPeriodId: PERIOD });
  });

  it("refuses to prepare Generate on a closed period", async () => {
    const out = await prepare({ action: GENERATE.id, params: { billingPeriodId: PERIOD } }, tables({ period: [{ ...OCTOBER, status: "closed" }] }).client);
    expect(out).toMatchObject({ ok: false, status: 409, message: GENERATE_CLOSED_REASON });
  });

  it("prepares Regenerate with the bill's facts, keeps the loader's prefill, and sends a body RegenerateBillBody parses", async () => {
    const out = await prepare(onBill(REGENERATE.id, { body: { readings: "manual", start_kwh: 0 } }));
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({
      confirm: "confirm",
      method: "POST",
      path: `/api/billing-line-items/${BILL}/regenerate`,
      bound: {},
      prefill: { readings: "manual", start_kwh: 0 },
    });
    expect(out.value.ceremony).toMatchObject({
      statement: "Regenerate this bill from meter data or the readings you enter.",
      facts: [
        { label: "Tenant", value: { t: "text", text: "Akello" } },
        { label: "Period", value: { t: "text" } },
        { label: "Current total", value: { t: "money", v: 5000, currency: "UGX" } },
        { label: "Payment", value: { t: "status", v: "unpaid" } },
      ],
      warnings: [],
    });
    const input = out.value.spec.input as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(input.properties)).toEqual(["readings", "start_kwh", "end_kwh", "reason"]);
    const body = await sent(out.value, { readings: "manual", start_kwh: 0, end_kwh: 12 }, "confirm");
    expect(RegenerateBillBody.parse(body)).toEqual({ readings: "manual", start_kwh: 0, end_kwh: 12 });
  });

  it("warns before regenerating a paid bill or one in a closed period", async () => {
    const client = tables({ bill: [billRow({ payment_status: "paid" }, { status: "closed" })] }).client;
    const out = await prepare(onBill(REGENERATE.id), client);
    if (!out.ok) throw new Error(out.message);
    expect(out.value.ceremony?.warnings).toEqual([
      expect.stringContaining("The bill is currently marked paid."),
      "Regenerating writes an audit-log revision; the period stays closed.",
    ]);
  });

  it("refuses to regenerate a refunded bill", async () => {
    const out = await prepare(onBill(REGENERATE.id), tables({ bill: [billRow({ payment_status: "refunded" })] }).client);
    expect(out).toMatchObject({ ok: false, status: 409, message: BILL_REFUSALS.refunded.message });
  });

  it("prepares a usage correction with no confirmation step", async () => {
    const out = await prepare(onBill(USAGE.id));
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({ confirm: "none", method: "PATCH", path: `/api/billing-line-items/${BILL}/usage`, ceremony: null });
    expect(LineItemUsageBody.parse(await sent(out.value, { usage_kwh: 12 }, "none"))).toEqual({ usage_kwh: 12 });
  });

  it.each([
    ["billing.mark-paid", "unpaid", "paid", "Mark this bill as paid", []],
    ["billing.mark-paid", "failed", "paid", "Mark this bill as paid", []],
    ["billing.mark-unpaid", "paid", "unpaid", "Mark this bill as unpaid", []],
    ["billing.mark-refunded", "paid", "refunded", "Mark this bill as refunded", []],
    ["billing.mark-failed", "link_generated", "failed", "Mark this bill as failed", []],
    ["billing.cancel-payment-link", "link_generated", "unpaid", "Cancel pending payment link?", ["They'll need a new link to pay."]],
  ])("prepares %s on a %s bill for a super admin, and sends status %s", async (action, current, to, statement, warnings) => {
    const client = tables({ bill: [billRow({ payment_status: current })] }).client;
    const out = await prepare(onBill(action, { body: { status: to } }), client, [superAdmin()]);
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({ confirm: "confirm", method: "PATCH", path: `/api/billing-line-items/${BILL}/payment-status`, prefill: { status: to } });
    expect(out.value.ceremony).toMatchObject({
      statement,
      facts: [{ label: "Tenant" }, { label: "Period" }, { label: "Total", value: { t: "money", v: 5000 } }],
      warnings,
      acknowledgements: [],
    });
    const body = await sent(out.value, { status: to, notes: "receipt 42" }, "confirm");
    expect(LineItemPaymentStatusBody.parse(body)).toEqual({ status: to, notes: "receipt 42" });
  });

  it("prepares Mark as unpaid for an organization manager with a confirmation step, like its siblings", async () => {
    const out = await prepare(onBill("billing.mark-unpaid", { body: { status: "unpaid" } }), tables({ bill: [billRow({ payment_status: "paid" })] }).client);
    if (!out.ok) throw new Error(out.message);
    expect(out.value.confirm).toBe("confirm");
    expect(out.value.ceremony).toMatchObject({
      statement: "Mark this bill as unpaid",
      facts: [{ label: "Tenant" }, { label: "Period" }, { label: "Total", value: { t: "money", v: 5000 } }],
      warnings: [],
    });
  });

  it.each(["billing.mark-refunded", "billing.mark-failed"])("refuses %s to an organization manager, with the route's copy", async (action) => {
    const client = tables({ bill: [billRow({ payment_status: action === "billing.mark-failed" ? "link_generated" : "paid" })] }).client;
    expect(await prepare(onBill(action), client)).toMatchObject({ ok: false, status: 403, message: BILL_REFUSALS.superAdmin.message });
  });

  it.each([
    ["billing.mark-paid", "paid", BILL_REFUSALS.noOp.message],
    ["billing.mark-unpaid", "unpaid", BILL_REFUSALS.noOp.message],
    ["billing.mark-unpaid", "link_generated", BILL_REFUSALS.transition.message],
    ["billing.cancel-payment-link", "paid", BILL_REFUSALS.transition.message],
    ["billing.mark-paid", "refunded", BILL_REFUSALS.transition.message],
  ])("refuses %s on a %s bill that changed since the view loaded", async (action, current, message) => {
    const client = tables({ bill: [billRow({ payment_status: current })] }).client;
    expect(await prepare(onBill(action), client, [superAdmin()])).toMatchObject({ ok: false, status: 409, message });
  });

  it.each(PAYMENT_IDS.concat(REGENERATE.id))("refuses %s on a bill row-level security hides, or one that cannot be read", async (action) => {
    expect(await prepare(onBill(action), tables({ bill: null }).client, [superAdmin()])).toMatchObject({ ok: false, status: 404 });
    expect(await prepare(onBill(action), tables({ billError: true }).client, [superAdmin()])).toMatchObject({ ok: false });
  });

  it.each([...PAYMENT_IDS, REGENERATE.id, USAGE.id])("does not let an assistant propose %s", async (action) => {
    const provenance = { by: "assistant", proposal: "e7100000-0000-4000-8009-0000000000c1", at: "2026-11-09T08:00:00Z" };
    expect(await prepare({ ...onBill(action), provenance })).toMatchObject({ ok: false, status: 403, code: "gui_human_only" });
  });
});
