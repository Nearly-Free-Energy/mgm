/**
 * billing.close-period, as billing contributes it: POST
 * /api/billing-periods/[periodId]/close with ClosePeriodBody, a ceremony
 * whose prepare returns the route's own (closeCeremony over the close
 * review), human-only and offered only by the close checklist. Its
 * refusals, its availability, and the confirmation the host sends.
 * gui-surface.test.ts holds the action to its route file, schema, gate and
 * released routes.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionDef, ActionLink, SurfaceRequest } from "@/lib/gui/surface";
import type { RegisteredAction, SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";
import { CLOSE_ACKNOWLEDGEMENTS, CLOSE_REFUSAL_COPY, parseCloseReview } from "../../close";
import { closeCeremony } from "../../close-ceremony";
import { CLOSE_PERIOD_BODY_VERSION, ClosePeriodBody } from "../../schemas";

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
import { resolveOwnAndTargeted } from "@/lib/gui/host/server/merge";
import { prepareAction } from "@/lib/gui/host/server/prepare";
import { ORG_A, managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { ActionSlots, MergeInput } from "@/lib/gui/host/shared/merge-actions";
import { PERIOD_REVIEW_LOADED_EXAMPLES } from "../period-review-examples";
import type { UserRoleRecord } from "@/lib/types/domain";
import { BILLING_SURFACE } from "../../surface";
import { CLOSE_PERIOD_REFUSALS, closePeriodAvailable, prepareClosePeriod } from "../close-checklist";
import { CLOSE_CHECKLIST_LOADED_EXAMPLES } from "../close-checklist-examples";

const MG = "e7f00000-0000-4000-8002-0000000000a1";
const PERIOD = "e7f00000-0000-4000-8003-0000000000b1";
const actions = BILLING_SURFACE.actions as ActionDef[];
const CLOSE = actions.find((a) => a.id === "billing.close-period")!;
const USER = { id: "e7f00000-0000-4000-8fff-000000000001", email: "host@test.local" } as User;
const SECRET = "permission denied for function fn_billing_period_close_review";
const fmt = createFmt({ locale: "en-GB" });

const PERIOD_ROW = { id: PERIOD, microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31", rate_schedule_id: "e7f00000-0000-4000-8000-0000000000e1" };
const REVIEW = {
  periodId: PERIOD,
  microgridId: MG,
  status: "draft",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  currency: "UGX",
  billCount: 3,
  totalAmount: 90000,
  usageKwh: 42.5,
  unbilled: [{ tenantId: "t-4", tenantName: "House 4" }],
  unmetered: [{ tenantId: "t-3", tenantName: "House 3" }],
  fractionalTotals: [],
  acknowledgements: ["totals_reviewed", "tenants_without_bills", "bills_without_usage"],
  digest: "v1:abc",
};

/** A host context with the real Fmt, since the ceremony formats its facts. */
function contextWith(client: SupabaseClient, roles: UserRoleRecord[] = [managerOf(ORG_A)]) {
  const made = hostContext({ user: USER, roles }, new Headers({ "accept-language": "en-GB" }), {
    newClient: async () => client,
    makeFmt: (locale) => createFmt({ locale }),
    now: new Date("2026-11-18T08:00:00Z"),
  });
  if (!made.ok) throw new Error("fixture context refused");
  return made.ctx;
}

const tables = (o: { period?: unknown; periodError?: boolean; review?: () => { data: unknown; error?: { message: string } } } = {}) =>
  tableClient(
    {
      microgrids: { data: [{ id: MG, name: "North", community_id: null }] },
      billing_periods: o.periodError ? { data: null, error: { message: SECRET } } : { data: o.period === undefined ? [PERIOD_ROW] : o.period },
    },
    { fn_billing_period_close_review: o.review ?? (() => ({ data: REVIEW })) },
  );

const prepare = (client = tables().client) => prepareAction(contextWith(client), { action: CLOSE.id, params: { periodId: PERIOD } });

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

describe("billing.close-period", () => {
  it("is the close route's POST with ClosePeriodBody, a human-only ceremony offered only where a loader links it", () => {
    expect(CLOSE).toMatchObject({
      id: "billing.close-period",
      title: "Close period",
      target: "billingPeriod",
      method: "POST",
      path: "/api/billing-periods/[periodId]/close",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "money",
      confirm: "ceremony",
      humanOnly: true,
      targeted: false,
      // The route's 409 for totals that changed (totalsChanged in ../../capability.ts).
      prepareAgainOn: ["billing_period_totals_changed"],
    });
    expect(CLOSE.input).toBe(ClosePeriodBody);
    expect(CLOSE.inputVersion).toBe(CLOSE_PERIOD_BODY_VERSION);
    expect(typeof CLOSE.prepare).toBe("function");
    expect(typeof CLOSE.available).toBe("function");
  });

  it("prepares the route's own ceremony, with nothing for a form to show", async () => {
    const { client, calls } = tables();
    const out = await prepare(client);
    expect(out).toMatchObject({
      ok: true,
      value: { confirm: "ceremony", method: "POST", path: `/api/billing-periods/${PERIOD}/close`, bound: {}, tone: "neutral", prepareAgainOn: ["billing_period_totals_changed"] },
    });
    if (!out.ok) return;
    expect(out.value.ceremony).toEqual(closeCeremony(parseCloseReview(REVIEW)!, fmt));
    expect(out.value.ceremony).toMatchObject({
      typed: "October 2026",
      digest: "v1:abc",
      acknowledgements: [
        { id: "totals_reviewed", label: CLOSE_ACKNOWLEDGEMENTS.totals_reviewed },
        { id: "tenants_without_bills", label: CLOSE_ACKNOWLEDGEMENTS.tenants_without_bills },
        { id: "bills_without_usage", label: CLOSE_ACKNOWLEDGEMENTS.bills_without_usage },
      ],
    });
    // The confirmation is the host's: ClosePeriodBody's only field is hidden.
    expect((out.value.spec.input as { properties: object }).properties).toEqual({});
    expect(checkGate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ plugin: "billing", access: "write" }));
    // Every read is the person's own client: the host resolves the period,
    // available() reads the period and the review, and prepare reads them again.
    expect(calls.map((c) => c.table).filter((t) => t !== "microgrids")).toEqual([
      "billing_periods",
      "billing_periods",
      "rpc:fn_billing_period_close_review",
      "billing_periods",
      "rpc:fn_billing_period_close_review",
    ]);
  });

  it("sends the digest, acknowledgements and typed name as ClosePeriodBody's confirmation", async () => {
    const out = await prepare();
    if (!out.ok) throw new Error(out.message);
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ period: {} }), { status: 200 }));
    const confirmation = { digest: "v1:abc", acknowledged: ["totals_reviewed", "tenants_without_bills", "bills_without_usage"], typed: "October 2026" };
    expect(await invoke(out.value, null, { level: "ceremony", confirmation }, fetch)).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect([url, init.method]).toEqual([`/api/billing-periods/${PERIOD}/close`, "POST"]);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ confirmation });
    expect(ClosePeriodBody.safeParse(body).success).toBe(true);
  });

  const review = (o: Record<string, unknown>) => () => ({ data: { ...REVIEW, ...o } });
  it.each([
    ["a closed period", { review: review({ status: "closed" }) }, 409, CLOSE_REFUSAL_COPY.closed],
    ["a period with no bills", { review: review({ billCount: 0, totalAmount: 0, usageKwh: 0, unmetered: [] }) }, 409, CLOSE_PERIOD_REFUSALS.noBills.message],
    [
      "a total that is not a whole number",
      { review: review({ fractionalTotals: [{ tenantId: "t-1", tenantName: "House 1" }] }) },
      409,
      "Regenerate the bills for House 1 before closing: their totals are not whole numbers.",
    ],
  ])("refuses %s, with availability's reason", async (_label, o, status, message) => {
    expect(await prepare(tables(o).client)).toMatchObject({ ok: false, status, code: "gui_action_unavailable", message });
  });

  it("refuses a period with no pinned tariff, with the period review's copy", async () => {
    // Availability gives prepare's reason, so the host refuses before prepare reads anything.
    expect(await prepare(tables({ period: [{ ...PERIOD_ROW, rate_schedule_id: null }] }).client)).toMatchObject({
      ok: false,
      status: 409,
      code: "gui_action_unavailable",
      message: CLOSE_PERIOD_REFUSALS.noTariff.message.slice(0, 300),
    });
    // Past availability, prepare refuses it itself, before reading the review.
    const { client, calls } = tables({ period: [{ ...PERIOD_ROW, rate_schedule_id: null }] });
    const req = { supabase: client, fmt } as unknown as SurfaceRequest;
    expect(await prepareClosePeriod(req, { params: { periodId: PERIOD } })).toEqual(CLOSE_PERIOD_REFUSALS.noTariff);
    expect(calls.map((c) => c.table)).toEqual(["billing_periods"]);
  });

  it("refuses a period row-level security hides as not found", async () => {
    expect(await prepare(tables({ review: () => ({ data: null }) }).client)).toMatchObject({ ok: false, status: 409, code: "gui_action_unavailable", message: CLOSE_PERIOD_REFUSALS.notFound.message });
    // Past availability, prepare's own read answers 404.
    expect(await prepare(tables({ period: null }).client)).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
  });

  it("refuses an unreadable period or review in prepare with fixed copy", async () => {
    // Called directly: the host's own read of the period would fail first.
    const req = (client: SupabaseClient) => ({ supabase: client, fmt }) as unknown as SurfaceRequest;
    for (const o of [{ periodError: true }, { review: () => ({ data: null, error: { message: SECRET } }) }]) {
      const out = await prepareClosePeriod(req(tables(o).client), { params: { periodId: PERIOD } });
      expect(out).toEqual(CLOSE_PERIOD_REFUSALS.unavailable);
      expect(out).toMatchObject({ status: 503, message: CLOSE_REFUSAL_COPY.reviewUnavailable });
      expect(JSON.stringify(out)).not.toContain("permission denied");
    }
  });

  // Availability and prepare read the review separately, so the period can
  // close, lose its bills or gain a fractional total between the two reads;
  // prepare then refuses on its own. No bills is this GUI's rule, not the
  // route's, so prepare is its only guard there.
  it.each([
    ["a closed period", review({ status: "closed" }), CLOSE_PERIOD_REFUSALS.closed],
    ["a period with no bills", review({ billCount: 0, totalAmount: 0, usageKwh: 0, unmetered: [] }), CLOSE_PERIOD_REFUSALS.noBills],
    [
      "a total that is not a whole number",
      review({ fractionalTotals: [{ tenantId: "t-1", tenantName: "House 1" }] }),
      { ok: false, status: 409, message: "Regenerate the bills for House 1 before closing: their totals are not whole numbers." },
    ],
  ])("refuses %s in prepare itself, past availability", async (_label, read, refusal) => {
    const req = (client: SupabaseClient) => ({ supabase: client, fmt }) as unknown as SurfaceRequest;
    expect(await prepareClosePeriod(req(tables({ review: read }).client), { params: { periodId: PERIOD } })).toEqual(refusal);
  });

  it("refuses while billing is off, with the gate's copy", async () => {
    checkGate.mockResolvedValue({ ok: false, status: 409, code: "plugin_disabled", message: "Billing is disabled for this organization." });
    expect(await prepare()).toMatchObject({ ok: false, status: 409 });
  });

  it.each([
    ["an assistant's proposal", { by: "assistant", proposal: "e7f00000-0000-4000-8009-0000000000c1", at: "2026-11-09T08:00:00Z" }],
    ["a watcher's proposal", { by: "watcher", at: "2026-11-09T08:00:00Z" }],
  ])("is not proposable: %s is refused", async (_label, provenance) => {
    expect(await prepareAction(contextWith(tables().client), { action: CLOSE.id, params: { periodId: PERIOD }, provenance })).toMatchObject({
      ok: false,
      status: 403,
      code: "gui_human_only",
    });
  });
});

describe("close's availability", () => {
  const req = (client: SupabaseClient) => ({ supabase: client }) as unknown as SurfaceRequest;

  it("is true for a draft with a tariff and bills, whatever it asks to acknowledge, in one read of the periods and the review", async () => {
    const { client, calls } = tables();
    expect(await closePeriodAvailable(req(client), [PERIOD])).toEqual({ [PERIOD]: true });
    expect(calls).toEqual([
      { table: "billing_periods", ops: [["select", ["id, rate_schedule_id"]], ["in", ["id", [PERIOD]]]] },
      { table: "rpc:fn_billing_period_close_review", ops: [["rpc", [{ _period_id: PERIOD }]]] },
    ]);
  });

  it.each([
    ["missing", {}, () => ({ data: null }), CLOSE_PERIOD_REFUSALS.notFound.message],
    ["row-level security hides", { period: [] }, undefined, CLOSE_PERIOD_REFUSALS.notFound.message],
    ["with no pinned tariff", { period: [{ ...PERIOD_ROW, rate_schedule_id: null }] }, undefined, CLOSE_PERIOD_REFUSALS.noTariff.message],
    // The tariff first, as prepare refuses.
    ["closed, with no pinned tariff", { period: [{ ...PERIOD_ROW, rate_schedule_id: null }] }, () => ({ data: { ...REVIEW, status: "closed" } }), CLOSE_PERIOD_REFUSALS.noTariff.message],
    ["closed", {}, () => ({ data: { ...REVIEW, status: "closed" } }), CLOSE_REFUSAL_COPY.closed],
    ["without bills", {}, () => ({ data: { ...REVIEW, billCount: 0 } }), CLOSE_PERIOD_REFUSALS.noBills.message],
  ])("gives the reason for a period %s", async (_label, o, answer, reason) => {
    expect(await closePeriodAvailable(req(tables({ ...o, review: answer }).client), [PERIOD])).toEqual({ [PERIOD]: reason });
  });

  it.each([
    ["a failed read of the review", {}, () => ({ data: null, error: { message: SECRET } })],
    ["a review in another shape", {}, () => ({ data: { ...REVIEW, digest: "" } })],
    ["a failed read of the periods", { periodError: true }, undefined],
  ])("throws on %s, so the host shows it as not checked", async (_label, o, answer) => {
    const out = closePeriodAvailable(req(tables({ ...o, review: answer }).client), [PERIOD]);
    await expect(out).rejects.toThrow("billing.close-period: availability not read");
  });
});

// ── In the checklist, and elsewhere ─────────────────────────────────────────

const OCTOBER = { kind: "billingPeriod", id: CLOSE_CHECKLIST_LOADED_EXAMPLES[0].entity!.id, label: "October" } as const;
const mergeInput = (plugin: MergeInput["plugin"]): MergeInput => ({
  plugin,
  actions: [...snapshot.actions.values()],
  scope: { billingPeriod: OCTOBER },
  gate: new Map([
    ["billing", { ok: true }],
    ["payments", { ok: true }],
  ]),
  isReleased: () => true,
});

describe("billing.close-period in the views", () => {
  it("resolves on the checklist's close step, with no danger tone: a close is neither a DELETE nor destructive", () => {
    const loaded = CLOSE_CHECKLIST_LOADED_EXAMPLES[0];
    const model = { kind: "flow", body: loaded.body, actions: loaded.actions, entity: OCTOBER } as ActionSlots<ActionLink>;
    const { model: resolved, dropped } = resolveOwnAndTargeted(model, mergeInput("billing"), snapshot.actions);
    expect(dropped).toEqual([]);
    if (resolved.kind !== "flow") throw new Error("not a flow");
    expect(resolved.body.steps.at(-1)?.action).toEqual({
      action: CLOSE.id,
      params: { periodId: OCTOBER.id },
      label: "Close period",
      enabled: true,
    });
  });

  it("is not appended to another view of the period", () => {
    const loaded = PERIOD_REVIEW_LOADED_EXAMPLES[0];
    const model = { kind: "collection", body: loaded.body, actions: loaded.actions, entity: OCTOBER } as ActionSlots<ActionLink>;
    const bar = resolveOwnAndTargeted(model, mergeInput("payments"), snapshot.actions).model.actions;
    expect(bar.map((a) => a.action)).not.toContain(CLOSE.id);
  });
});
