/**
 * The period review's actions, as billing contributes them: generating a
 * draft's bills from meter data, regenerating one bill on its own route, correcting an
 * unmetered bill's usage, and the five payment-status transitions on the
 * payment-status route. All human-only and money; prepared by the host as
 * the kit needs them. gui-surface.test.ts holds each action to its route
 * file, schema, gate and released routes, and parity.test.ts to the parity
 * table.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRef, Confirm, Confirmation, Json } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionDef, ActionLink, SurfaceRequest } from "@/lib/gui/surface";
import type { RegisteredAction, SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";
import {
  GENERATE_FROM_METERS_BODY_VERSION,
  GENERATE_FROM_METERS_COPY,
  GenerateFromMetersBody,
  LINE_ITEM_PAYMENT_STATUS_BODY_VERSION,
  LINE_ITEM_USAGE_BODY_VERSION,
  LineItemPaymentStatusBody,
  LineItemUsageBody,
  REGENERATE_BILL_BODY_VERSION,
  REGENERATE_PAID_ACKNOWLEDGEMENT,
  REGENERATE_REFUSAL_COPY,
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
  GENERATE_REFUSALS,
  generateFromMetersAvailable,
  prepareGenerateFromMeters,
  recordUsageAvailable,
  regenerateBillAvailable,
  REGENERATE_PAID_LABEL,
  USAGE_REASONS,
} from "../period-review";
import { PERIOD_REVIEW_LOADED_EXAMPLES } from "../period-review-examples";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const PERIOD = "e7100000-0000-4000-8003-0000000000b1";
const BILL = "e7100000-0000-4000-8005-0000000000c1";
const TENANT = "e7100000-0000-4000-8004-0000000000d1";
const actions = BILLING_SURFACE.actions as ActionDef[];
const def = (id: string) => actions.find((a) => a.id === id)!;
const GENERATE = def("billing.generate-from-meters");
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
  it("generate a draft's bills from meter data on their own route, offered only by the review, with a prepare", () => {
    expect(GENERATE).toMatchObject({
      id: "billing.generate-from-meters",
      title: "Generate bills from meter data",
      target: "billingPeriod",
      method: "POST",
      path: "/api/billing-periods/[periodId]/generate-from-meters",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "money",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
    });
    expect(GENERATE.input).toBe(GenerateFromMetersBody);
    expect(GENERATE.inputVersion).toBe(GENERATE_FROM_METERS_BODY_VERSION);
    expect(typeof GENERATE.prepare).toBe("function");
    expect(typeof GENERATE.available).toBe("function");
    // The full-body action on POST /api/billing/generate is retired.
    expect(actions.some((a) => a.id === "billing.generate-bills")).toBe(false);
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
      // A ceremony, so the host sends a paid bill's acknowledgement to the route.
      confirm: "ceremony",
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
    // Typed: a refund is final, so the person types the tenant's name.
    ["billing.mark-refunded", "Mark as refunded", "typed"],
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
      const refs = resolved.body.rows.flatMap((r) => r.actions);
      expect(refs.every((a) => a.enabled)).toBe(true);
      // Only a DELETE or destructive action is shown as dangerous (actionTone in merge-actions.ts), and
      // none of these is one, typed Mark as refunded and ceremony Regenerate bill included.
      for (const a of refs) expect([a.action, a.tone]).toEqual([a.action, undefined]);
    },
  );
});

// ── Availability ────────────────────────────────────────────────────────────

const req = (client: SupabaseClient) => ({ supabase: client }) as unknown as SurfaceRequest;
const GONE = "e7100000-0000-4000-8005-0000000000ff";

describe("availability", () => {
  it("offers Generate on a draft, and explains a closed or missing period with the route's copy", async () => {
    const CLOSED = "e7100000-0000-4000-8003-0000000000b2";
    const { client, calls } = tableClient({ billing_periods: { data: [{ id: PERIOD, status: "draft" }, { id: CLOSED, status: "closed" }] } });
    expect(await generateFromMetersAvailable(req(client), [PERIOD, CLOSED, GONE])).toEqual({
      [PERIOD]: true,
      [CLOSED]: GENERATE_FROM_METERS_COPY.closed,
      [GONE]: "This billing period could not be found.",
    });
    expect(calls).toEqual([{ table: "billing_periods", ops: [["select", ["id, status"]], ["in", ["id", [PERIOD, CLOSED, GONE]]]] }]);
  });

  it("offers regenerating a bill in a draft that is neither invoiced nor refunded, in one read", async () => {
    const id = (n: number) => `e7100000-0000-4000-8005-0000000000c${n}`;
    const draft = { status: "draft" };
    const closed = { status: "closed" };
    const { client, calls } = tableClient({
      billing_line_items: {
        data: [
          { id: BILL, payment_status: "paid", invoice_number: null, billing_periods: draft },
          { id: id(1), payment_status: "unpaid", invoice_number: null, billing_periods: [draft] },
          { id: id(2), payment_status: "refunded", invoice_number: null, billing_periods: draft },
          { id: id(3), payment_status: "unpaid", invoice_number: "EXS-2026-00001", billing_periods: draft },
          { id: id(4), payment_status: "unpaid", invoice_number: null, billing_periods: closed },
          // A closed period's reason comes first, then an invoice number's, then a refund's: the route's order.
          { id: id(5), payment_status: "refunded", invoice_number: "EXS-2026-00002", billing_periods: closed },
          { id: id(6), payment_status: "refunded", invoice_number: "EXS-2026-00003", billing_periods: draft },
          // A bill whose period row-level security hides is not found.
          { id: id(7), payment_status: "unpaid", invoice_number: null, billing_periods: null },
        ],
      },
    });
    const ids = [BILL, ...[1, 2, 3, 4, 5, 6, 7].map(id), GONE];
    expect(await regenerateBillAvailable(req(client), ids)).toEqual({
      [BILL]: true,
      [id(1)]: true,
      [id(2)]: BILL_REFUSALS.refunded.message,
      [id(3)]: BILL_REFUSALS.invoiced.message,
      [id(4)]: BILL_REFUSALS.closed.message,
      [id(5)]: BILL_REFUSALS.closed.message,
      [id(6)]: BILL_REFUSALS.invoiced.message,
      [id(7)]: BILL_REFUSALS.notFound.message,
      [GONE]: BILL_REFUSALS.notFound.message,
    });
    expect(calls).toEqual([
      {
        table: "billing_line_items",
        ops: [["select", ["id, payment_status, invoice_number, billing_periods(status)"]], ["in", ["id", ids]]],
      },
    ]);
    // The route's copy.
    expect(BILL_REFUSALS.closed.message).toBe(REGENERATE_REFUSAL_COPY.closed);
    expect(BILL_REFUSALS.invoiced.message).toBe(REGENERATE_REFUSAL_COPY.invoiced);
    expect(BILL_REFUSALS.refunded.message).toBe(REGENERATE_REFUSAL_COPY.refunded);
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
    ["generate-from-meters", generateFromMetersAvailable, "billing_periods"],
    ["regenerate-bill", regenerateBillAvailable, "billing_line_items"],
    ["record-usage", recordUsageAvailable, "billing_line_items"],
  ] as const)("%s throws on a failed read, so the host shows it as not checked", async (_label, available, table) => {
    const { client } = tableClient({ [table]: { data: null, error: { message: "permission denied" } } });
    await expect(available(req(client), [BILL])).rejects.toThrow();
    const ref: ActionRef = { action: `billing.${_label}`, params: _label === "generate-from-meters" ? { periodId: PERIOD } : { lineItemId: BILL }, label: "x", enabled: true };
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
async function sent(prepared: PreparedAction, form: Json | null, level: Confirm, confirmation?: Confirmation): Promise<unknown> {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
  expect(await invoke(prepared, form, { level, ...(confirmation === undefined ? {} : { confirmation }) }, fetch)).toMatchObject({ ok: true });
  const [url, init] = fetch.mock.calls[0];
  expect([url, init.method]).toEqual([prepared.path, prepared.method]);
  return JSON.parse(init.body as string);
}

describe("preparing the period review's actions", () => {
  it("prepares Generate with the path filled, what it will read and who has no meter, and sends the {} GenerateFromMetersBody parses", async () => {
    const out = await prepare({ action: GENERATE.id, params: { periodId: PERIOD } }, generateTables().client);
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({
      confirm: "confirm",
      method: "POST",
      path: `/api/billing-periods/${PERIOD}/generate-from-meters`,
      bound: {},
    });
    expect(out.value.ceremony).toEqual({
      type: "ceremony",
      statement:
        "Read each tenant's meter for this period and calculate their bills. Bills entered by hand, and paid, invoiced or refunded bills, are left as they are; any other bill is recalculated, one with a pending payment link included.",
      facts: [
        { label: "Period", value: { t: "text", text: expect.any(String) } },
        { label: "Read from meters", value: expect.objectContaining({ t: "number", v: 2, text: "2" }) },
        { label: "Of these, already billed", value: expect.objectContaining({ v: 1 }) },
        { label: "Kept, entered by hand", value: expect.objectContaining({ v: 1 }) },
        { label: "Left as they are: paid, invoiced or refunded", value: expect.objectContaining({ v: 1 }) },
        { label: "Not billed: no meter for the period", value: expect.objectContaining({ v: 1 }) },
        { label: "Not billed: a meter assignment gap", value: expect.objectContaining({ v: 1 }) },
      ],
      warnings: [
        "No meter for this period, so not billed: Unit 5.",
        "A meter assignment gap in this period (no one meter assigned for all of it), so not billed: Unit 6.",
        // A bill is recalculated (unit 2's): what a new total does to a payment under way.
        "If a bill's total changes, a payment already started for it is held for reconciliation instead of marking the bill paid.",
        "A tenant whose meter has no data for the period is not billed, and a bill they already have is left as it is; the result says how many.",
        "Where a meter's starting reading is unknown, its bill bills the usage the meter measured and leaves the starting and ending readings blank.",
      ],
      acknowledgements: [],
    });
    // Nothing to fill: the form has no field, and the host sends only the bound path.
    expect((out.value.spec.input as { properties: Record<string, unknown> }).properties).toEqual({});
    const body = await sent(out.value, null, "confirm");
    expect(body).toEqual({});
    expect(GenerateFromMetersBody.parse(body)).toEqual({});
  });

  it("refuses to prepare Generate on a closed period, with the route's copy", async () => {
    const out = await prepare({ action: GENERATE.id, params: { periodId: PERIOD } }, generateTables({ period: { ...OCTOBER, status: "closed" } }).client);
    expect(out).toMatchObject({ ok: false, status: 409, message: GENERATE_FROM_METERS_COPY.closed });
  });

  it("refuses to prepare Generate with nothing to read from meters", async () => {
    const out = await prepare(
      { action: GENERATE.id, params: { periodId: PERIOD } },
      generateTables({ tenants: [genTenant(5, []), genTenant(3, [link()])], bills: [genBill(3, { reading_source: "manual" })] }).client,
    );
    expect(out).toMatchObject({ ok: false, status: 409, message: GENERATE_FROM_METERS_COPY.nothingToRead });
  });

  it("prepares Regenerate with the bill's facts, keeps the loader's prefill, and sends a body RegenerateBillBody parses", async () => {
    const out = await prepare(onBill(REGENERATE.id, { body: { readings: "manual", start_kwh: 0 } }));
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({
      confirm: "ceremony",
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
      acknowledgements: [],
    });
    // The form never shows the confirmation: the host sends it.
    const input = out.value.spec.input as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(input.properties)).toEqual(["readings", "start_kwh", "end_kwh", "reason"]);
    const body = await sent(out.value, { readings: "manual", start_kwh: 0, end_kwh: 12 }, "ceremony", { acknowledged: [] });
    expect(RegenerateBillBody.parse(body)).toEqual({ readings: "manual", start_kwh: 0, end_kwh: 12, confirmation: { acknowledged: [] } });
  });

  it("asks a paid bill's regeneration to be acknowledged, and sends the acknowledgement the route requires", async () => {
    const client = tables({ bill: [billRow({ payment_status: "paid" })] }).client;
    const out = await prepare(onBill(REGENERATE.id, { body: { readings: "edge" } }), client);
    if (!out.ok) throw new Error(out.message);
    expect(out.value.ceremony).toMatchObject({
      warnings: [],
      acknowledgements: [{ id: REGENERATE_PAID_ACKNOWLEDGEMENT, label: REGENERATE_PAID_LABEL }],
    });
    expect(REGENERATE_PAID_LABEL).toContain("The bill is currently marked paid.");
    const body = await sent(out.value, { readings: "edge" }, "ceremony", { acknowledged: [REGENERATE_PAID_ACKNOWLEDGEMENT] });
    expect(RegenerateBillBody.parse(body)).toEqual({ readings: "edge", confirmation: { acknowledged: [REGENERATE_PAID_ACKNOWLEDGEMENT] } });
  });

  it.each(["unpaid", "paid"])("refuses to regenerate a %s bill in a closed period, as the route does", async (payment_status) => {
    const out = await prepare(onBill(REGENERATE.id), tables({ bill: [billRow({ payment_status }, { status: "closed" })] }).client);
    expect(out).toMatchObject({ ok: false, status: 409, message: BILL_REFUSALS.closed.message });
  });

  it.each(["unpaid", "paid"])("refuses to regenerate an invoiced %s bill, as the route does", async (payment_status) => {
    const out = await prepare(onBill(REGENERATE.id), tables({ bill: [billRow({ payment_status, invoice_number: "EXS-2026-00001" })] }).client);
    expect(out).toMatchObject({ ok: false, status: 409, message: BILL_REFUSALS.invoiced.message });
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

  // The step never names the new status: the form can change it after prepare.
  const PAYMENT_STATEMENT = "Change this bill's payment status to the one chosen in the form.";

  const REFUND_WARNING = "A refund is final: no change leads out of refunded.";

  it.each([
    ["billing.mark-paid", "unpaid", "paid", PAYMENT_STATEMENT, []],
    ["billing.mark-paid", "failed", "paid", PAYMENT_STATEMENT, []],
    ["billing.mark-unpaid", "paid", "unpaid", PAYMENT_STATEMENT, []],
    ["billing.mark-failed", "link_generated", "failed", PAYMENT_STATEMENT, []],
    ["billing.cancel-payment-link", "link_generated", "unpaid", PAYMENT_STATEMENT, ["The pending payment link stops working; they'll need a new link to pay."]],
  ])("prepares %s on a %s bill for a super admin, and sends status %s", async (action, current, to, statement, warnings) => {
    const client = tables({ bill: [billRow({ payment_status: current })] }).client;
    const out = await prepare(onBill(action, { body: { status: to } }), client, [superAdmin()]);
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({ confirm: "confirm", method: "PATCH", path: `/api/billing-line-items/${BILL}/payment-status`, prefill: { status: to } });
    expect(out.value.ceremony).toMatchObject({
      statement,
      facts: [{ label: "Tenant" }, { label: "Period" }, { label: "Total", value: { t: "money", v: 5000 } }, { label: "Status now" }],
      warnings,
      acknowledgements: [],
    });
    expect(out.value.ceremony).not.toHaveProperty("typed");
    const body = await sent(out.value, { status: to, notes: "receipt 42" }, "confirm");
    expect(LineItemPaymentStatusBody.parse(body)).toEqual({ status: to, notes: "receipt 42" });
  });

  it("prepares Mark as refunded on a paid bill for a super admin as a typed step: the tenant's name, and the refund's finality", async () => {
    const client = tables({ bill: [billRow({ payment_status: "paid" })] }).client;
    const out = await prepare(onBill("billing.mark-refunded", { body: { status: "refunded" } }), client, [superAdmin()]);
    if (!out.ok) throw new Error(out.message);
    expect(out.value).toMatchObject({
      confirm: "typed",
      method: "PATCH",
      path: `/api/billing-line-items/${BILL}/payment-status`,
      prefill: { status: "refunded" },
    });
    expect(out.value.ceremony).toMatchObject({
      statement: PAYMENT_STATEMENT,
      facts: [
        { label: "Tenant", value: { t: "text", text: "Akello" } },
        { label: "Period" },
        { label: "Total", value: { t: "money", v: 5000 } },
        { label: "Status now" },
      ],
      warnings: [REFUND_WARNING],
      acknowledgements: [],
      typed: "Akello",
    });
    // The host sends the typed name as the confirmation, beside the form's status and notes.
    const body = await sent(out.value, { status: "refunded", notes: "receipt 42" }, "typed", { acknowledged: [], typed: "Akello" });
    expect(body).toEqual({ status: "refunded", notes: "receipt 42", confirmation: { acknowledged: [], typed: "Akello" } });
    // The route parses exactly that body: the schema takes the host's confirmation (version 2).
    expect(LineItemPaymentStatusBody.parse(body)).toEqual({ status: "refunded", notes: "receipt 42", confirmation: { acknowledged: [], typed: "Akello" } });
  });

  it("refuses Mark as refunded on a bill whose tenant's name cannot be read, since there is no name to type", async () => {
    for (const tenants of [null, { display_name: "" }]) {
      const client = tables({ bill: [billRow({ payment_status: "paid", tenants })] }).client;
      expect(await prepare(onBill("billing.mark-refunded"), client, [superAdmin()])).toMatchObject({
        ok: false,
        status: 409,
        message: BILL_REFUSALS.transition.message,
      });
    }
    // The other transitions ask for no name, so they still prepare.
    const client = tables({ bill: [billRow({ payment_status: "paid", tenants: null })] }).client;
    expect(await prepare(onBill("billing.mark-unpaid"), client, [superAdmin()])).toMatchObject({ ok: true });
  });

  it("prepares Mark as unpaid for an organization manager with a confirmation step, like its siblings", async () => {
    const out = await prepare(onBill("billing.mark-unpaid", { body: { status: "unpaid" } }), tables({ bill: [billRow({ payment_status: "paid" })] }).client);
    if (!out.ok) throw new Error(out.message);
    expect(out.value.confirm).toBe("confirm");
    expect(out.value.ceremony).toMatchObject({
      statement: PAYMENT_STATEMENT,
      facts: [{ label: "Tenant" }, { label: "Period" }, { label: "Total", value: { t: "money", v: 5000 } }, { label: "Status now" }],
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

// ── Generate's prepare, on its own ─────────────────────────────────────────

const genTenantId = (n: number) => `e7100000-0000-4000-8004-0000000001${String(n).padStart(2, "0")}`;
const link = (o: Record<string, unknown> = {}) => ({
  role: "primary_consumption_meter",
  effective_from: "2026-01-01",
  effective_to: null,
  devices: { openems_component_id: "meter0", edges: { openems_edge_id: "edge0" } },
  ...o,
});
const genTenant = (n: number, links: unknown[]) => ({ id: genTenantId(n), display_name: `Unit ${n}`, tenant_devices: links });
const genBill = (n: number, o: Record<string, unknown> = {}) => ({
  id: `e7100000-0000-4000-8005-0000000001${String(n).padStart(2, "0")}`,
  tenant_id: genTenantId(n),
  reading_source: "edge",
  payment_status: "unpaid",
  invoice_number: null,
  ...o,
});
/**
 * 1 metered with no bill, 2 metered with an unpaid bill, 3 a manual bill, 4
 * a paid bill, 5 no meter, 6 a meter assigned only after the period.
 */
const GEN_TENANTS = [
  genTenant(1, [link()]),
  genTenant(2, [link()]),
  genTenant(3, [link()]),
  genTenant(4, [link()]),
  genTenant(5, []),
  genTenant(6, [link({ effective_from: "2026-11-01" })]),
];
const GEN_BILLS = [genBill(2), genBill(3, { reading_source: "manual" }), genBill(4, { payment_status: "paid" })];

function generateTables(o: { period?: unknown; tenants?: unknown[]; bills?: unknown[]; error?: "period" | "bills" | "tenants" } = {}) {
  const failed = { data: null, error: { message: "permission denied" } };
  return tableClient({
    microgrids: { data: [{ id: MG, name: "North", community_id: null }] },
    billing_periods: o.error === "period" ? failed : { data: o.period === null ? [] : [o.period ?? OCTOBER] },
    billing_line_items: o.error === "bills" ? failed : { data: o.bills ?? GEN_BILLS },
    tenants: o.error === "tenants" ? failed : { data: o.tenants ?? GEN_TENANTS },
  });
}

const fmtReq = (client: SupabaseClient) => ({ supabase: client, fmt: createFmt({ locale: "en-GB" }) }) as unknown as SurfaceRequest;
const prepareGenerate = (client: SupabaseClient) => prepareGenerateFromMeters(fmtReq(client), { params: { periodId: PERIOD } });

describe("billing.generate-from-meters' prepare", () => {
  it("reads the period, its bills and the microgrid's tenants with their primary links, through the person's client", async () => {
    const { client, calls } = generateTables();
    expect(await prepareGenerate(client)).toMatchObject({ ok: true });
    expect(calls.map((c) => c.table)).toEqual(["billing_periods", "billing_line_items", "tenants"]);
    expect(calls[0].ops).toContainEqual(["eq", ["id", PERIOD]]);
    expect(calls[1].ops).toContainEqual(["eq", ["billing_period_id", PERIOD]]);
    expect(calls[2].ops).toContainEqual(["eq", ["microgrid_id", MG]]);
    expect(calls[2].ops).toContainEqual(["eq", ["tenant_devices.role", "primary_consumption_meter"]]);
    // It pins no tariff and reads no meter.
    expect(calls.some((c) => c.table.startsWith("rpc:"))).toBe(false);
  });

  it.each([
    ["a period it cannot see", { period: null }, GENERATE_REFUSALS.notFound],
    ["a closed period", { period: { ...OCTOBER, status: "closed" } }, GENERATE_REFUSALS.closed],
    ["a failed period read", { error: "period" as const }, GENERATE_REFUSALS.unavailable],
    ["a failed bills read", { error: "bills" as const }, GENERATE_REFUSALS.unavailable],
    ["a failed tenants read", { error: "tenants" as const }, GENERATE_REFUSALS.unavailable],
    ["no tenant to read from a meter", { tenants: [genTenant(5, [])] }, GENERATE_REFUSALS.nothingToRead],
  ])("refuses %s with fixed copy", async (_label, o, refusal) => {
    expect(await prepareGenerate(generateTables(o).client)).toEqual(refusal);
  });

  it("names the first five tenants with no meter, then counts the rest", async () => {
    const tenants = [genTenant(1, [link()]), ...[11, 12, 13, 14, 15, 16, 17].map((n) => genTenant(n, []))];
    const out = await prepareGenerate(generateTables({ tenants, bills: [] }).client);
    if (!out.ok) throw new Error(out.message);
    expect(out.model.warnings[0]).toBe("No meter for this period, so not billed: Unit 11, Unit 12, Unit 13, Unit 14, Unit 15 and 2 more.");
    // With no bill, nothing is already billed, kept or left: those facts are left out.
    expect(out.model.facts.map((f) => f.label)).toEqual(["Period", "Read from meters", "Not billed: no meter for the period"]);
  });

  it("says a bill whose meter cannot be read is left as it is, not that its tenant is not billed, by the reason the result gives", async () => {
    const tenants = [
      genTenant(1, [link()]),
      genTenant(5, []),
      // A meter replaced mid-period: two links, neither covering all of it.
      genTenant(6, [link({ effective_to: "2026-10-15" }), link({ effective_from: "2026-10-15" })]),
      genTenant(7, []),
    ];
    const out = await prepareGenerate(generateTables({ tenants, bills: [genBill(5), genBill(6)] }).client);
    if (!out.ok) throw new Error(out.message);
    expect(out.model.facts.map((f) => [f.label, f.value.text])).toEqual([
      ["Period", expect.any(String)],
      ["Read from meters", "1"],
      ["Not billed: no meter for the period", "1"],
      ["Bill left as it is, not refreshed: no meter for the period", "1"],
      ["Bill left as it is, not refreshed: a meter assignment gap", "1"],
    ]);
    expect(out.model.warnings.slice(0, 3)).toEqual([
      "No meter for this period, so not billed: Unit 7.",
      "No meter for this period, so their bills are left as they are, not refreshed: Unit 5.",
      "A meter assignment gap in this period (no one meter assigned for all of it), so their bills are left as they are, not refreshed: Unit 6.",
    ]);
  });

  it("counts the bills with a pending payment link it will recalculate, and says what a new total does to them", async () => {
    const tenants = [1, 2, 3, 4].map((n) => genTenant(n, [link()]));
    const bills = [
      genBill(1, { payment_status: "link_generated" }),
      genBill(2, { payment_status: "link_generated" }),
      // Not recalculated, so not counted: kept or left.
      genBill(3, { payment_status: "link_generated", reading_source: "manual" }),
      genBill(4, { payment_status: "link_generated", invoice_number: "EXS-1" }),
    ];
    const out = await prepareGenerate(generateTables({ tenants, bills }).client);
    if (!out.ok) throw new Error(out.message);
    expect(out.model.facts.map((f) => [f.label, f.value.text])).toContainEqual(["Of these, with a pending payment link", "2"]);
    expect(out.model.warnings.slice(0, 2)).toEqual([
      "2 bills to be recalculated have a pending payment link. Where a bill's total changes, its link stops working and the tenant needs a new one.",
      "If a bill's total changes, a payment already started for it is held for reconciliation instead of marking the bill paid.",
    ]);
    const one = await prepareGenerate(generateTables({ tenants, bills: bills.slice(1) }).client);
    if (!one.ok) throw new Error(one.message);
    expect(one.model.warnings[0]).toBe(
      "1 bill to be recalculated has a pending payment link. If its total changes, the link stops working and the tenant needs a new one.",
    );
  });

  it("says nothing of tenants with no meter when every tenant has one", async () => {
    const out = await prepareGenerate(generateTables({ tenants: [genTenant(1, [link()])], bills: [] }).client);
    if (!out.ok) throw new Error(out.message);
    expect(out.model.warnings).toHaveLength(2);
    expect(out.model.facts.map((f) => f.label)).toEqual(["Period", "Read from meters"]);
  });
});
