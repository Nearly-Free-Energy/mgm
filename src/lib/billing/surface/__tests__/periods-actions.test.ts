/**
 * The periods view's two writes, as billing contributes them: create on the
 * microgrid (POST /api/billing-periods, CreatePeriodBody, no confirmation)
 * and delete on a draft period (DELETE /api/billing-periods/[periodId],
 * DeletePeriodBody, the period's name typed). Both human-only, prepared by
 * the host as the kit needs them; create is offered only by this view.
 * gui-surface.test.ts holds each action to its route file, schema, gate and
 * released routes.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRef, Json } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionDef, ActionLink, SurfaceRequest } from "@/lib/gui/surface";
import type { RegisteredAction, SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";
import { periodName } from "../../close";
import { DELETE_DRAFT_PERIOD_DESCRIPTION, PERIOD_KEPT_CLOSED_MESSAGE, PERIOD_KEPT_PAYMENTS_MESSAGE } from "../../period-delete";
import {
  CREATE_PERIOD_BODY_VERSION,
  CreatePeriodBody,
  DELETE_PERIOD_BODY_VERSION,
  DeletePeriodBody,
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
import { checkAvailability, resolveOwnAndTargeted } from "@/lib/gui/host/server/merge";
import { prepareAction, type PreparedAction } from "@/lib/gui/host/server/prepare";
import { ORG_A, managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { ActionSlots, MergeInput } from "@/lib/gui/host/shared/merge-actions";
import { SITE_DAY_LOADED_EXAMPLES } from "@/lib/metering/surface/examples";
import type { UserRoleRecord } from "@/lib/types/domain";
import { BILLING_SURFACE } from "../../surface";
import { deletePeriodAvailable } from "../periods";
import { PERIODS_LOADED_EXAMPLES } from "../periods-examples";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const PERIOD = "e7100000-0000-4000-8003-0000000000b1";
const OCTOBER = { id: PERIOD, microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft" };
const actions = BILLING_SURFACE.actions as ActionDef[];
const def = (id: string) => actions.find((a) => a.id === id)!;
const CREATE = def("billing.create-period");
const DELETE = def("billing.delete-period");
const USER = { id: "e7100000-0000-4000-8fff-000000000001", email: "host@test.local" } as User;

/** A host context with the real Fmt, since the delete's ceremony formats its facts. */
function contextWith(client: SupabaseClient, roles: UserRoleRecord[] = [managerOf(ORG_A)]) {
  const made = hostContext({ user: USER, roles }, new Headers({ "accept-language": "en-GB" }), {
    newClient: async () => client,
    makeFmt: (locale) => createFmt({ locale }),
    now: new Date("2026-11-18T08:00:00Z"),
  });
  if (!made.ok) throw new Error("fixture context refused");
  return made.ctx;
}

const tables = (o: { period?: unknown; items?: unknown[] } = {}) =>
  tableClient({
    microgrids: { data: [{ id: MG, name: "North", community_id: null }] },
    billing_periods: { data: o.period === undefined ? [OCTOBER] : o.period },
    billing_line_items: { data: o.items ?? [] },
  });

const prepare = (body: unknown, client = tables().client) => prepareAction(contextWith(client), body);

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

describe("billing's period actions", () => {
  it("are create and delete on the period routes, parsed with their schemas, and human-only", () => {
    expect(CREATE).toMatchObject({
      id: "billing.create-period",
      title: "New billing period",
      target: "microgrid",
      method: "POST",
      path: "/api/billing-periods",
      bind: { body: { microgrid_id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    });
    expect(CREATE.input).toBe(CreatePeriodBody);
    expect(CREATE.inputVersion).toBe(CREATE_PERIOD_BODY_VERSION);
    expect(DELETE).toMatchObject({
      id: "billing.delete-period",
      title: "Delete period",
      target: "billingPeriod",
      method: "DELETE",
      path: "/api/billing-periods/[periodId]",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "destructive",
      confirm: "typed",
      humanOnly: true,
    });
    expect(DELETE.input).toBe(DeletePeriodBody);
    expect(DELETE.inputVersion).toBe(DELETE_PERIOD_BODY_VERSION);
    expect(typeof DELETE.prepare).toBe("function");
    expect(typeof DELETE.available).toBe("function");
  });

  it("prepare create with the microgrid bound and the view's starting dates, and no confirmation step", async () => {
    // The ref the periods view offers, as the action host sends its prefill.
    const ref = PERIODS_LOADED_EXAMPLES[0].actions[0];
    expect(ref.prefill).toEqual({ start_date: "2026-11-01", end_date: "2026-11-30" });
    const out = await prepare({ action: CREATE.id, params: { microgrid_id: MG }, body: ref.prefill });
    expect(out).toMatchObject({
      ok: true,
      value: { confirm: "none", method: "POST", path: "/api/billing-periods", bound: { microgrid_id: MG }, ceremony: null },
    });
    if (!out.ok) return;
    const input = out.value.spec.input as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(input.properties)).toEqual(["start_date", "end_date"]);
    expect(input.required).toEqual(["start_date", "end_date"]);
    // CreatePeriodBody's start <= end refinement does not keep the host from checking the dates.
    expect(out.value.prefill).toEqual({ start_date: "2026-11-01", end_date: "2026-11-30" });
    expect(checkGate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ plugin: "billing", access: "write" }));
    // No body, no prefill: the form opens empty.
    const bare = await prepare({ action: CREATE.id, params: { microgrid_id: MG } });
    expect(bare.ok && "prefill" in bare.value).toBe(false);
  });

  it("prepare create with starting dates checked one by one: the bound microgrid left out, a date that is not one refused", async () => {
    const out = await prepare({ action: CREATE.id, params: { microgrid_id: MG }, body: { start_date: "2026-10-01", microgrid_id: PERIOD } });
    expect(out).toMatchObject({ ok: true, value: { bound: { microgrid_id: MG }, prefill: { start_date: "2026-10-01" } } });
    // Dates the route would refuse together are still each a date: the route checks the order on submit.
    expect(await prepare({ action: CREATE.id, params: { microgrid_id: MG }, body: { start_date: "2026-10-31", end_date: "2026-10-01" } })).toMatchObject({
      ok: true,
      value: { prefill: { start_date: "2026-10-31", end_date: "2026-10-01" } },
    });
    for (const body of [{ start_date: "2026-02-30" }, { end_date: "October" }, { start_date: "2026-10-01", timezone: "UTC" }]) {
      expect(await prepare({ action: CREATE.id, params: { microgrid_id: MG }, body }), JSON.stringify(body)).toMatchObject({
        ok: false,
        status: 400,
        code: "gui_bad_request",
      });
    }
  });

  it("send create's dates with the bound microgrid", async () => {
    const out = await prepare({ action: CREATE.id, params: { microgrid_id: MG } });
    if (!out.ok) throw new Error(out.message);
    const body = await sent(out.value, { start_date: "2026-11-01", end_date: "2026-11-30" }, { level: "none" });
    expect(CreatePeriodBody.parse(body)).toEqual({ microgrid_id: MG, start_date: "2026-11-01", end_date: "2026-11-30" });
  });

  it("prepare delete with the period's name to type and no digest", async () => {
    const out = await prepare({ action: DELETE.id, params: { periodId: PERIOD } }, tables({ items: [{ payment_status: "unpaid", paid_at: null }] }).client);
    expect(out).toMatchObject({ ok: true, value: { confirm: "typed", method: "DELETE", path: `/api/billing-periods/${PERIOD}`, bound: {} } });
    if (!out.ok) return;
    expect(out.value.ceremony).toEqual({
      type: "ceremony",
      statement: DELETE_DRAFT_PERIOD_DESCRIPTION,
      facts: [
        { label: "Period", value: { t: "text", text: "October 2026" } },
        { label: "Bills", value: { t: "number", v: 1, text: "1" } },
      ],
      warnings: [],
      acknowledgements: [],
      typed: periodName("2026-10-01", "2026-10-31"),
    });
    // The form has nothing to fill: the confirmation is the host's.
    expect((out.value.spec.input as { properties: object }).properties).toEqual({});
  });

  it("send delete's typed name as the confirmation DeletePeriodBody parses, and follow the route's href", async () => {
    const out = await prepare({ action: DELETE.id, params: { periodId: PERIOD } });
    if (!out.ok) throw new Error(out.message);
    const href = `/microgrids/${MG}/billing`;
    const body = await sent(out.value, null, { level: "typed", confirmation: { acknowledged: [], typed: "October 2026" } }, { href });
    expect(body).toEqual({ confirmation: { acknowledged: [], typed: "October 2026" } });
    expect(DeletePeriodBody.safeParse(body).success).toBe(true);
  });

  it.each([
    ["a closed period", { period: [{ ...OCTOBER, status: "closed" }] }, 409, PERIOD_KEPT_CLOSED_MESSAGE],
    ["a period with a recorded payment", { items: [{ payment_status: "paid", paid_at: "2026-11-02T10:00:00Z" }] }, 409, PERIOD_KEPT_PAYMENTS_MESSAGE],
  ])("refuse to prepare delete for %s, with the route's copy", async (_label, o, status, message) => {
    expect(await prepare({ action: DELETE.id, params: { periodId: PERIOD } }, tables(o).client)).toMatchObject({ ok: false, status, message });
  });

  it("refuse to prepare delete for a period row-level security hides", async () => {
    expect(await prepare({ action: DELETE.id, params: { periodId: PERIOD } }, tables({ period: null }).client)).toMatchObject({
      ok: false,
      status: 404,
      code: "gui_not_found",
    });
  });

  it.each([
    ["an assistant's proposal", { by: "assistant", proposal: "e7100000-0000-4000-8009-0000000000c1", at: "2026-11-09T08:00:00Z" }],
    ["a watcher's proposal", { by: "watcher", at: "2026-11-09T08:00:00Z" }],
  ])("are not proposable: %s is refused", async (_label, provenance) => {
    expect(await prepare({ action: CREATE.id, params: { microgrid_id: MG }, provenance })).toMatchObject({ ok: false, status: 403, code: "gui_human_only" });
    expect(await prepare({ action: DELETE.id, params: { periodId: PERIOD }, provenance })).toMatchObject({ ok: false, status: 403, code: "gui_human_only" });
  });
});

describe("delete's availability", () => {
  const req = (client: SupabaseClient) => ({ supabase: client }) as unknown as SurfaceRequest;
  const CLOSED = "e7100000-0000-4000-8003-0000000000b2";
  const GONE = "e7100000-0000-4000-8003-0000000000b3";

  it("explains a closed or missing period in one read, and leaves payments to prepare", async () => {
    const { client, calls } = tableClient({ billing_periods: { data: [{ id: PERIOD, status: "draft" }, { id: CLOSED, status: "closed" }] } });
    expect(await deletePeriodAvailable(req(client), [PERIOD, CLOSED, GONE])).toEqual({
      [PERIOD]: true,
      [CLOSED]: PERIOD_KEPT_CLOSED_MESSAGE,
      [GONE]: "This billing period could not be found.",
    });
    expect(calls).toEqual([{ table: "billing_periods", ops: [["select", ["id, status"]], ["in", ["id", [PERIOD, CLOSED, GONE]]]] }]);
  });

  it("throws on a failed read, so the host shows it as not checked", async () => {
    const { client } = tableClient({ billing_periods: { data: null, error: { message: "permission denied" } } });
    await expect(deletePeriodAvailable(req(client), [PERIOD])).rejects.toThrow();
  });
});

// ── In the periods view, and elsewhere ──────────────────────────────────────

const NORTH = { kind: "microgrid", id: MG, label: "North" } as const;
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

describe("billing's period actions in the views", () => {
  it("resolve enabled in the periods view: create on the view and Delete on the draft row", () => {
    const loaded = PERIODS_LOADED_EXAMPLES[0];
    const model = { kind: "collection", body: loaded.body, actions: loaded.actions, entity: NORTH } as ActionSlots<ActionLink>;
    const { model: resolved, dropped } = resolveOwnAndTargeted(model, mergeInput("billing"), snapshot.actions);
    expect(dropped).toEqual([]);
    expect(resolved.actions).toEqual([
      {
        action: CREATE.id,
        params: { microgrid_id: loaded.actions[0].params.microgrid_id },
        label: "New billing period",
        enabled: true,
        prefill: { start_date: "2026-11-01", end_date: "2026-11-30" },
      },
    ]);
    if (resolved.kind !== "collection") throw new Error("not a collection");
    expect(resolved.body.empty.action).toEqual(resolved.actions[0]);
    expect(resolved.body.rows.map((r) => r.actions.map((a) => [a.action, a.enabled, a.tone]))).toEqual([[[DELETE.id, true, "danger"]], []]);
  });

  it("disable Delete with the reason availability gives", async () => {
    const draft = PERIODS_LOADED_EXAMPLES[0].body.rows[0].id;
    const ref: ActionRef = { action: DELETE.id, params: { periodId: draft }, label: "Delete period", enabled: true, tone: "danger" };
    const { client } = tableClient({ billing_periods: { data: [{ id: draft, status: "closed" }] } });
    const [checked] = (
      await checkAvailability({ kind: "record", body: { sections: [] }, actions: [ref] }, { actions: snapshot.actions, request: async () => ({ supabase: client }) as unknown as SurfaceRequest })
    ).actions;
    expect(checked).toMatchObject({ enabled: false, reason: PERIOD_KEPT_CLOSED_MESSAGE });
  });

  it("do not add create to another plugin's view of the microgrid", () => {
    const loaded = SITE_DAY_LOADED_EXAMPLES[0];
    const model = { kind: "metrics", body: loaded.body, actions: loaded.actions, entity: NORTH } as ActionSlots<ActionLink>;
    const bar = resolveOwnAndTargeted(model, mergeInput("metering"), snapshot.actions).model.actions;
    expect(bar.map((a) => a.action)).not.toContain(CREATE.id);
  });
});

/** The body the host sends for `prepared`, answered with `answer`; the result must be ok. */
async function sent(
  prepared: PreparedAction,
  form: Json | null,
  options: Parameters<typeof invoke>[2],
  answer: Record<string, unknown> = {},
): Promise<unknown> {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(answer), { status: 200 }));
  const result = await invoke(prepared, form, options, fetch);
  expect(result).toMatchObject({ ok: true, ...(answer.href ? { href: answer.href } : {}) });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect([url, init.method]).toEqual([prepared.path, prepared.method]);
  return JSON.parse(init.body as string);
}
