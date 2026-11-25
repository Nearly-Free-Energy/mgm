/**
 * The action catalog with fakes: the gate, the entity resolver and the
 * snapshot are stubbed, as prepare.test.ts stubs them. catalog.db.test.ts
 * (src/app/api/gui/catalog/__tests__) runs it against the real ones.
 */
import { inspect } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { CatalogEntry } from "../../../contract";
import type { ActionDef } from "../../../surface";
import type { RegisteredAction, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", async (importOriginal) => ({
  codePrefix: (await importOriginal<typeof import("@/lib/runtime/gate")>()).codePrefix,
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
const takeSnapshot = vi.fn(async () => snapshot);
vi.mock("../snapshot", () => ({ surfaceSnapshot: () => takeSnapshot() }));

import { buildActionCatalog, readCatalogQuery, type CatalogQuery } from "../catalog";
import { AVAILABILITY_BUDGET_MS, UNCHECKED_REASON } from "../merge";
import { ORG_A, ORG_B, contextFor, managerOf, tableClient, tenantOf } from "./host-fakes";

const PERIOD = "e7100000-0000-4000-8006-0000000000a1";
const MG = "e7100000-0000-4000-8002-0000000000a1";
const HOUSE = "e7100000-0000-4000-8005-0000000000b1";
const ATTEMPT = "e7100000-0000-4000-8007-0000000000c1";
const CANARY = "CANARY-5c1e02";

type Available = NonNullable<ActionDef["available"]>;

function action(plugin: MgmPluginName, over: Partial<Record<keyof ActionDef, unknown>>): RegisteredAction {
  const def = {
    title: "An action",
    input: z.strictObject({ note: z.string().max(200).optional() }),
    inputVersion: 1,
    method: "POST",
    risk: "money",
    confirm: "confirm",
    humanOnly: true,
    repeat: "safe",
    ...over,
  } as unknown as ActionDef;
  return { plugin, def };
}

const close = (over: Partial<Record<keyof ActionDef, unknown>> = {}) =>
  action("billing", {
    id: "billing.close-period",
    title: "Close period",
    target: "billingPeriod",
    path: "/api/billing-periods/[periodId]/close",
    bind: { path: { periodId: "billingPeriod" } },
    input: z.strictObject({
      note: z.string().optional(),
      confirmation: z.strictObject({ digest: z.string() }).optional(),
    }),
    confirm: "ceremony",
    targeted: false,
    prepareAgainOn: ["billing_period_totals_changed"],
    ...over,
  });
const create = action("billing", {
  id: "billing.create-period",
  title: "New billing period",
  target: "microgrid",
  path: "/api/billing-periods",
  bind: { body: { microgrid_id: "microgrid" } },
  input: z.strictObject({ microgrid_id: z.uuid(), start_date: z.iso.date() }),
  risk: "write",
});
const billFromReadings = action("billing", {
  id: "billing.bill-from-readings",
  target: "billingPeriod",
  path: "/api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings",
  bind: { path: { periodId: "billingPeriod", tenantId: "tenant" } },
  available: vi.fn<Available>(async () => ({})),
});
const refresh = action("payments", {
  id: "payments.refresh-attempt",
  title: "Check again",
  target: "paymentAttempt",
  path: "/api/payments/attempts/[id]/refresh",
  bind: { path: { id: "paymentAttempt" } },
  input: z.strictObject({}),
  risk: "write",
  confirm: "none",
  whilePluginOff: "enabled",
});
const unreleased = action("billing", {
  id: "billing.unreleased",
  target: "billingPeriod",
  path: "/api/billing-periods/[periodId]/not-yet",
  bind: { path: { periodId: "billingPeriod" } },
});

let roles: UserRoleRecord[];
let gates: Map<string, GateDecision>;
let tables: Parameters<typeof tableClient>[0];
let callLists: ReturnType<typeof tableClient>["calls"][];
let newClient: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

const use = (...actions: RegisteredAction[]) => {
  snapshot = {
    views: [],
    actions: new Map(actions.map((a) => [a.def.id, a])),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
};
const ctx = () => contextFor(roles, newClient as unknown as () => Promise<SupabaseClient>);
const catalog = (q: CatalogQuery = {}) => buildActionCatalog(ctx(), q);
const ok = async (q: CatalogQuery = {}) => {
  const out = await catalog(q);
  if (!out.ok) throw new Error(`refused: ${out.code}`);
  return out.value;
};
const entry = (entries: CatalogEntry[], id: string) => entries.find((e) => e.id === id)!;
const logged = () => inspect([error.mock.calls, warn.mock.calls], { depth: 10 });

beforeEach(() => {
  callLists = [];
  roles = [managerOf(ORG_A)];
  gates = new Map();
  tables = {
    organizations: { data: [{ id: ORG_A, name: "Org A" }, { id: ORG_B, name: "Org B" }] },
    billing_periods: { data: [{ id: PERIOD, start_date: "2026-10-01", end_date: "2026-10-31", microgrid_id: MG }] },
    tenants: { data: [{ id: HOUSE, display_name: "House of Nakato", microgrid_id: MG }] },
    payment_attempts: { data: [{ id: ATTEMPT, org_id: ORG_A }] },
  };
  newClient = vi.fn(async () => {
    const made = tableClient(tables);
    callLists.push(made.calls);
    return made.client;
  });
  use(close(), create, billFromReadings, refresh, unreleased);
  checkGate.mockReset().mockImplementation(async (_s: unknown, r: { plugin: string }) => gates.get(r.plugin) ?? { ok: true, organizationId: ORG_A });
  resolveTargetOrganization.mockReset().mockResolvedValue(ORG_A);
  takeSnapshot.mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  // The catalog only reads: every query is a select.
  for (const call of callLists.flat()) expect(call.ops[0]?.[0]).toBe("select");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("buildActionCatalog for an organization", () => {
  it("lists every action in catalog order and then by id, each with the same keys", async () => {
    const out = await ok();
    expect(out).toMatchObject({ type: "catalog", contract: "0.2.1", org: ORG_A, entities: [] });
    expect(out.actions.map((a) => a.id)).toEqual([
      "billing.bill-from-readings",
      "billing.close-period",
      "billing.create-period",
      "billing.unreleased",
      "payments.refresh-attempt",
    ]);
    for (const a of out.actions) {
      expect(Object.keys(a)).toEqual([
        "id",
        "title",
        "plugin",
        "target",
        "method",
        "path",
        "bind",
        "input",
        "inputVersion",
        "risk",
        "confirm",
        "humanOnly",
        "targeted",
        "prepareAgainOn",
        "repeat",
        "availability",
      ]);
    }
  });

  it("describes each action as prepare does", async () => {
    const out = await ok();
    expect(entry(out.actions, "billing.close-period")).toEqual({
      id: "billing.close-period",
      title: "Close period",
      plugin: "billing",
      target: "billingPeriod",
      method: "POST",
      path: "/api/billing-periods/[periodId]/close",
      bind: { path: { periodId: "billingPeriod" }, body: {} },
      input: expect.objectContaining({ type: "object", properties: { note: { type: "string" } }, additionalProperties: false }),
      inputVersion: 1,
      risk: "money",
      confirm: "ceremony",
      humanOnly: true,
      targeted: false,
      prepareAgainOn: ["billing_period_totals_changed"],
      repeat: "safe",
      availability: { available: true, reasons: [], unchecked: ["configured", "authorized", "state"] },
    });
    // A bound body field is not the person's to enter.
    const created = entry(out.actions, "billing.create-period");
    expect(Object.keys((created.input as { properties: object }).properties)).toEqual(["start_date"]);
    expect(created).toMatchObject({ bind: { path: {}, body: { microgrid_id: "microgrid" } }, targeted: true });
  });

  it("asks no available() without an entity, and never decides configured or authorized", async () => {
    const available = vi.fn<Available>(async () => ({}));
    use(close({ available }));
    const [only] = (await ok()).actions;
    expect(available).not.toHaveBeenCalled();
    expect(only.availability).toEqual({ available: true, reasons: [], unchecked: ["configured", "authorized", "state"] });
  });

  it("lists a disabled plugin's actions unavailable with the gate's code and copy, except one kept enabled", async () => {
    gates.set("billing", { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled for this organization." });
    gates.set("payments", { ok: false, status: 409, code: "payments_disabled", message: "Payments are disabled." });
    const out = await ok();
    expect(entry(out.actions, "billing.create-period").availability).toEqual({
      available: false,
      reasons: [{ check: "enabled", code: "billing_disabled", message: "Billing is disabled for this organization." }],
      unchecked: ["configured", "authorized", "state"],
    });
    // whilePluginOff: "enabled": its route takes it while Payments is off.
    expect(entry(out.actions, "payments.refresh-attempt").availability).toMatchObject({ available: true, reasons: [] });
    // The gate is asked as a write, once per plugin.
    expect(checkGate).toHaveBeenCalledTimes(2);
    expect(checkGate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ plugin: "billing", access: "write", target: { kind: "organization", id: ORG_A } }));
  });

  it("marks an action unhealthy, and enabled not decided, when the gate cannot be read or throws", async () => {
    gates.set("billing", { ok: false, status: 503, code: "billing_gate_unavailable", message: "Could not verify whether Billing is enabled." });
    checkGate.mockImplementation(async (_s: unknown, r: { plugin: string }) => {
      if (r.plugin === "payments") throw new Error(CANARY);
      return gates.get(r.plugin) ?? { ok: true, organizationId: ORG_A };
    });
    const out = await ok();
    expect(entry(out.actions, "billing.create-period").availability).toEqual({
      available: false,
      reasons: [{ check: "healthy", code: "billing_gate_unavailable", message: "Could not verify whether Billing is enabled." }],
      unchecked: ["enabled", "configured", "authorized", "state"],
    });
    // Kept enabled while off, but an unreadable gate still refuses it, with the gate's own code.
    expect(entry(out.actions, "payments.refresh-attempt").availability.reasons).toEqual([
      { check: "healthy", code: "payments_gate_unavailable", message: "Could not check whether this part of MGM is enabled." },
    ]);
    expect(JSON.stringify(out) + logged()).not.toContain(CANARY);
  });

  it("marks an action whose route is not released as not installed", async () => {
    expect(entry((await ok()).actions, "billing.unreleased").availability).toEqual({
      available: false,
      reasons: [{ check: "installed", code: "gui_not_released", message: "This action is not part of the MGM release installed here." }],
      unchecked: ["configured", "authorized", "state"],
    });
  });

  it("answers for the organization org names, and 404 for one the person cannot see", async () => {
    roles = [managerOf(ORG_A), managerOf(ORG_B)];
    expect((await ok({ org: ORG_B.toUpperCase() })).org).toBe(ORG_B);
    expect((await ok({ preferred: ORG_B })).org).toBe(ORG_B);
    expect((await ok()).org).toBe(ORG_A);
    roles = [managerOf(ORG_A)];
    expect(await catalog({ org: ORG_B })).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    // The last used organization is a hint only.
    expect((await ok({ preferred: ORG_B })).org).toBe(ORG_A);
  });

  it("answers 503 when the organizations cannot be read, without the error", async () => {
    tables.organizations = { data: null, error: { message: CANARY } };
    expect(await catalog()).toEqual({ ok: false, status: 503, code: "gui_unavailable", message: expect.any(String) });
    expect(logged()).not.toContain(CANARY);
  });

  it("answers 500 rather than describe an input JSON Schema cannot", async () => {
    use(create, close({ input: z.strictObject({ at: z.date() }) }));
    expect(await catalog()).toMatchObject({ ok: false, status: 500, code: "gui_output_invalid" });
    expect(logged()).toContain("billing.close-period");
  });
});

describe("buildActionCatalog on entities", () => {
  it("lists only the actions offered on the kinds given, filled and asked about the entity", async () => {
    const available = vi.fn<Available>(async (_req, ids) => Object.fromEntries(ids.map((id) => [id, true as const])));
    use(close({ available }), create, billFromReadings, refresh);
    const out = await ok({ entities: [{ kind: "billingPeriod", id: PERIOD.toUpperCase() }] });
    expect(out.entities).toEqual([{ kind: "billingPeriod", id: PERIOD }]);
    expect(out.actions.map((a) => a.id)).toEqual(["billing.bill-from-readings", "billing.close-period"]);
    const closing = entry(out.actions, "billing.close-period");
    expect(closing.params).toEqual({ periodId: PERIOD });
    expect(closing.availability).toEqual({ available: true, reasons: [], unchecked: ["configured", "authorized"] });
    expect(available).toHaveBeenCalledOnce();
    expect(available.mock.calls[0][1]).toEqual([PERIOD]);
    expect(available.mock.calls[0][0].organizationId).toBe(ORG_A);
    // Without its tenant, bill-from-readings cannot be filled: no params, and its state is not asked.
    const billing = entry(out.actions, "billing.bill-from-readings");
    expect(billing).not.toHaveProperty("params");
    expect(billing.availability.unchecked).toContain("state");
    expect(billFromReadings.def.available).not.toHaveBeenCalled();
  });

  it("fills an action bound to two kinds when both are given", async () => {
    const available = vi.fn<Available>(async () => ({ [PERIOD]: true }));
    use({ ...billFromReadings, def: { ...billFromReadings.def, available } as ActionDef });
    const out = await ok({ entities: [{ kind: "billingPeriod", id: PERIOD }, { kind: "tenant", id: HOUSE }] });
    expect(out.actions[0]).toMatchObject({ params: { periodId: PERIOD, tenantId: HOUSE }, availability: { available: true } });
    expect(available).toHaveBeenCalledWith(expect.anything(), [PERIOD]);
  });

  it("files available()'s text as state, and a throw, a late answer or a blank one as unchecked", async () => {
    vi.useFakeTimers();
    const said = (answer: string | true) => vi.fn<Available>(async (_r, ids) => Object.fromEntries(ids.map((id) => [id, answer])));
    const cases: [string, Available][] = [
      ["billing.a-text", said("This period is closed.")],
      ["billing.b-throw", async () => { throw new Error(CANARY); }],
      ["billing.c-late", () => new Promise(() => {})],
      ["billing.d-blank", said("  ")],
      ["billing.e-unchecked-text", said(UNCHECKED_REASON)],
    ];
    use(...cases.map(([id, available]) => close({ id, title: id, available })));
    const pending = catalog({ entities: [{ kind: "billingPeriod", id: PERIOD }] });
    await vi.advanceTimersByTimeAsync(AVAILABILITY_BUDGET_MS);
    const out = await pending;
    if (!out.ok) throw new Error("refused");
    const unchecked = { check: "healthy", code: "gui_availability_unchecked", message: UNCHECKED_REASON };
    expect(Object.fromEntries(out.value.actions.map((a) => [a.id, a.availability]))).toEqual({
      "billing.a-text": { available: false, reasons: [{ check: "state", code: "gui_action_unavailable", message: "This period is closed." }], unchecked: ["configured", "authorized"] },
      "billing.b-throw": { available: false, reasons: [unchecked], unchecked: ["configured", "authorized", "state"] },
      "billing.c-late": { available: false, reasons: [unchecked], unchecked: ["configured", "authorized", "state"] },
      "billing.d-blank": { available: false, reasons: [unchecked], unchecked: ["configured", "authorized", "state"] },
      // A reason whose text is the host's own is still the action's reason.
      "billing.e-unchecked-text": { available: false, reasons: [{ check: "state", code: "gui_action_unavailable", message: UNCHECKED_REASON }], unchecked: ["configured", "authorized"] },
    });
    expect(JSON.stringify(out) + logged()).not.toContain(CANARY);
  });

  it("does not ask available() of an action another check refused, nor of one without it", async () => {
    const available = vi.fn<Available>(async () => ({ [PERIOD]: true }));
    use(close({ available }), { ...unreleased, def: { ...unreleased.def, available } as ActionDef });
    gates.set("billing", { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled." });
    const out = await ok({ entities: [{ kind: "billingPeriod", id: PERIOD }] });
    expect(available).not.toHaveBeenCalled();
    expect(out.actions.map((a) => [a.id, a.availability.reasons.map((r) => r.check), a.availability.unchecked])).toEqual([
      ["billing.close-period", ["enabled"], ["configured", "authorized", "state"]],
      ["billing.unreleased", ["installed", "enabled"], ["configured", "authorized", "state"]],
    ]);

    gates.clear();
    use(close());
    const [only] = (await ok({ entities: [{ kind: "billingPeriod", id: PERIOD }] })).actions;
    expect(only.availability).toEqual({ available: true, reasons: [], unchecked: ["configured", "authorized", "state"] });
  });

  it("asks available() while a plugin is off for an action kept enabled", async () => {
    const available = vi.fn<Available>(async () => ({ [ATTEMPT]: "Nothing to check." }));
    use({ ...refresh, def: { ...refresh.def, available } as ActionDef });
    gates.set("payments", { ok: false, status: 409, code: "payments_disabled", message: "Payments are disabled." });
    const [only] = (await ok({ entities: [{ kind: "paymentAttempt", id: ATTEMPT }] })).actions;
    expect(only.availability.reasons).toEqual([{ check: "state", code: "gui_action_unavailable", message: "Nothing to check." }]);
  });

  it("answers 404 for an entity the person cannot see, or entities in two organizations, and 503 for a failed lookup", async () => {
    tables.billing_periods = { data: [] };
    expect(await catalog({ entities: [{ kind: "billingPeriod", id: PERIOD }] })).toMatchObject({ status: 404, code: "gui_not_found" });

    tables.billing_periods = { data: [{ id: PERIOD, start_date: "2026-10-01", end_date: "2026-10-31", microgrid_id: MG }] };
    resolveTargetOrganization.mockImplementation(async (_s: unknown, t: { kind: string }) => (t.kind === "tenant" ? ORG_B : ORG_A));
    roles = [managerOf(ORG_A), managerOf(ORG_B)];
    expect(await catalog({ entities: [{ kind: "billingPeriod", id: PERIOD }, { kind: "tenant", id: HOUSE }] })).toMatchObject({ status: 404 });

    resolveTargetOrganization.mockResolvedValue(ORG_B);
    roles = [managerOf(ORG_A)];
    expect(await catalog({ entities: [{ kind: "billingPeriod", id: PERIOD }] })).toMatchObject({ status: 404 });

    resolveTargetOrganization.mockRejectedValue(new Error(CANARY));
    expect(await catalog({ entities: [{ kind: "billingPeriod", id: PERIOD }] })).toMatchObject({ status: 503, code: "gui_unavailable" });
    expect(checkGate).not.toHaveBeenCalled();
    expect(logged()).not.toContain(CANARY);
  });

  it("echoes the entities by kind and id, never their labels", async () => {
    const out = await ok({ entities: [{ kind: "tenant", id: HOUSE }] });
    expect(out.entities).toEqual([{ kind: "tenant", id: HOUSE }]);
    expect(JSON.stringify(out)).not.toContain("Nakato");
  });
});

describe("buildActionCatalog for a person who reaches no organization", () => {
  it("gives a person whose rows are all tenant rows no actions, reading nothing and asking no gate", async () => {
    roles = [tenantOf(HOUSE)];
    expect(await catalog()).toEqual({ ok: true, value: { type: "catalog", contract: "0.2.1", org: null, entities: [], actions: [] } });
    expect(newClient).not.toHaveBeenCalled();
    expect(checkGate).not.toHaveBeenCalled();
    expect(takeSnapshot).not.toHaveBeenCalled();
  });

  it("answers 404 to a tenant-only person who names an entity or an organization, their own unit included", async () => {
    roles = [tenantOf(HOUSE)];
    expect(await catalog({ entities: [{ kind: "tenant", id: HOUSE }] })).toMatchObject({ status: 404, code: "gui_not_found" });
    expect(await catalog({ org: ORG_A })).toMatchObject({ status: 404, code: "gui_not_found" });
    expect(newClient).not.toHaveBeenCalled();
  });

  it("gives staff who see no organization but hold a unit no actions, as the manifest gives them the tenant one", async () => {
    roles = [managerOf(ORG_B), tenantOf(HOUSE)];
    tables.organizations = { data: [] };
    expect(await catalog()).toEqual({ ok: true, value: { type: "catalog", contract: "0.2.1", org: null, entities: [], actions: [] } });
    expect(checkGate).not.toHaveBeenCalled();
  });

  it("answers 403 to staff who see no organization and hold no unit", async () => {
    tables.organizations = { data: [] };
    expect(await catalog()).toMatchObject({ ok: false, status: 403, code: "gui_no_access" });
  });

  it("gives a person with staff and tenant rows the organization's catalog", async () => {
    roles = [managerOf(ORG_A), tenantOf(HOUSE)];
    expect((await ok()).actions).toHaveLength(5);
  });
});

describe("the catalog's query", () => {
  const read = (search: string, preferred: string | null = null) => readCatalogQuery(new URLSearchParams(search), preferred);

  it("reads org, or repeated entity=<kind>:<id>, and the last used organization", () => {
    expect(read("")).toEqual({ ok: true, value: { org: null, preferred: null, entities: [] } });
    expect(read(`org=${ORG_A.toUpperCase()}`, ORG_B)).toEqual({ ok: true, value: { org: ORG_A, preferred: ORG_B, entities: [] } });
    expect(read(`entity=billingPeriod:${PERIOD}&entity=tenant:${HOUSE}&entity=sms.reminder:r-1`)).toEqual({
      ok: true,
      value: {
        org: null,
        preferred: null,
        entities: [
          { kind: "billingPeriod", id: PERIOD },
          { kind: "tenant", id: HOUSE },
          { kind: "sms.reminder", id: "r-1" },
        ],
      },
    });
  });

  it.each([
    ["an unknown key", `org=${ORG_A}&orgs=${ORG_A}`],
    ["a ui.* key", "ui.tab=1"],
    ["an org that is not a UUID", "org=org-a"],
    ["an empty org", "org="],
    ["two orgs", `org=${ORG_A}&org=${ORG_B}`],
    ["org with an entity", `org=${ORG_A}&entity=billingPeriod:${PERIOD}`],
    ["an entity without a kind", `entity=${PERIOD}`],
    ["an unknown core-like kind", `entity=period:${PERIOD}`],
    ["a core id that is not a UUID", "entity=billingPeriod:march"],
    ["a plugin id with a colon", "entity=sms.reminder:r:1"],
    ["a kind given twice", `entity=billingPeriod:${PERIOD}&entity=billingPeriod:${PERIOD}`],
    ["five entities", ["billingPeriod", "tenant", "lineItem", "microgrid", "paymentAttempt"].map((k) => `entity=${k}:${PERIOD}`).join("&")],
  ])("refuses %s with 400", (_name, search) => {
    expect(read(search)).toMatchObject({ ok: false, status: 400, code: "gui_bad_request" });
  });

  it("refuses the same rules from an in-process caller", async () => {
    expect(await catalog({ org: ORG_A, entities: [{ kind: "billingPeriod", id: PERIOD }] })).toMatchObject({ status: 400 });
    expect(await catalog({ entities: [{ kind: "billingPeriod", id: "march" }] })).toMatchObject({ status: 400 });
    expect(newClient).not.toHaveBeenCalled();
  });

  it("refuses a context hostContext did not issue, before reading anything", async () => {
    await expect(buildActionCatalog({ ...ctx() }, {})).rejects.toThrow(/did not issue/);
    expect(takeSnapshot).not.toHaveBeenCalled();
  });
});
