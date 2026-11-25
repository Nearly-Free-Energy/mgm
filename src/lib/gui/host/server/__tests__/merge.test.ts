import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { Id } from "../../../contract";
import type { ActionDef, ActionLink, LoadedModel, SurfaceRequest } from "../../../surface";
import type { GateDecision } from "@/lib/runtime/gate";
import { AVAILABILITY_BUDGET_MS, UNCHECKED_REASON, resolveActions, type MergeContext } from "../merge";
import type { RegisteredAction, RegisteredView } from "../surface-registry";
import { ORG_A, contextFor, managerOf, superAdmin } from "./host-fakes";

const P1 = "e7100000-0000-4000-8000-0000000000a1";
const H1 = "e7100000-0000-4000-8000-0000000000b1";
const H2 = "e7100000-0000-4000-8000-0000000000b2";
const MG = { kind: "microgrid", id: "e7100000-0000-4000-8000-0000000000c1", label: "Kiwumu" } as const;

type Available = NonNullable<ActionDef["available"]>;

function action(plugin: MgmPluginName, id: Id, over: Partial<ActionDef> = {}): RegisteredAction {
  const def = {
    id,
    title: id,
    target: "tenant",
    input: z.object({}),
    inputVersion: 1,
    path: "/api/tenants/[id]/assignments",
    method: "POST",
    bind: { path: { id: "tenant" } },
    risk: "write",
    confirm: "confirm",
    humanOnly: false,
    repeat: "safe",
    ...over,
  } as ActionDef;
  return { plugin, def };
}

const close = action("billing", "billing.close", {
  title: "Close period",
  target: "billingPeriod",
  path: "/api/billing-periods/[id]/close",
  bind: { path: { id: "billingPeriod" } },
  input: z.object({
    note: z.string(),
    token: z.string().meta({ writeOnly: true }),
    confirmation: z.unknown().optional(),
  }),
});

const VIEW = { plugin: "billing", def: { id: "billing.periods", kind: "collection" } } as unknown as RegisteredView;

function loaded(rows: { id: string; tenant?: string; actions?: ActionLink[] }[], actions: ActionLink[] = []) {
  return {
    title: "Periods",
    entity: MG,
    actions,
    body: {
      columns: [],
      rows: rows.map((r) => ({
        id: r.id,
        entity: { kind: "billingPeriod", id: P1, label: "March" },
        ...(r.tenant ? { related: [{ kind: "tenant", id: r.tenant, label: r.id }] } : {}),
        cells: {},
        actions: r.actions ?? [],
      })),
      empty: { title: "No periods" },
    },
  } as LoadedModel<"collection">;
}

type ContextOver = Partial<Omit<MergeContext, "organizationId" | "gate">> &
  ({ organizationId?: undefined; gate?: undefined } | { organizationId: null; gate: null });

function context(registered: RegisteredAction[], over: ContextOver = {}) {
  const newClient = vi.fn(async () => ({}) as SupabaseClient);
  const states = new Map<string, GateDecision>();
  const gate = vi.fn(
    async (plugin: MgmPluginName): Promise<GateDecision> => states.get(plugin) ?? { ok: true, organizationId: ORG_A },
  );
  const m: MergeContext = {
    view: VIEW,
    actions: new Map(registered.map((r) => [r.def.id, r])),
    scope: { microgrid: MG },
    organizationId: ORG_A,
    gate,
    ctx: contextFor([managerOf(ORG_A)], newClient),
    ...over,
  } as MergeContext;
  return { m, gate, states, newClient };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe("resolveActions: the view's own links", () => {
  it("resolves label, provenance and prefill, and leaves out unknown, misbound and unreleased links", async () => {
    const provenance = { by: "assistant", at: "2026-11-09T08:00:00Z" } as const;
    const unreleased = action("billing", "billing.hidden", {
      path: "/api/billing-periods/[id]/hidden",
      target: "billingPeriod",
      bind: { path: { id: "billingPeriod" } },
    });
    const { m } = context([close, unreleased]);
    const links: ActionLink[] = [
      {
        action: "billing.close",
        params: { id: P1 },
        label: "Close March",
        prefill: { note: "n", token: "t" },
        provenance,
      },
      { action: "billing.close", params: { id: P1 }, prefill: { note: 5 } },
      { action: "billing.nope", params: {} },
      { action: "billing.close", params: { id: "not-an-id" } },
      { action: "billing.close", params: { id: `x${P1}` } },
      { action: "billing.close", params: { id: `${P1}/..` } },
      { action: "billing.close", params: { id: P1, extra: P1 } },
      { action: "billing.hidden", params: { id: P1 } },
    ];
    const out = await resolveActions(loaded([], links), m);

    expect(out.actions).toEqual([
      {
        action: "billing.close",
        params: { id: P1 },
        label: "Close March",
        enabled: true,
        prefill: { note: "n" },
        provenance,
      },
      { action: "billing.close", params: { id: P1 }, label: "Close period", enabled: true },
    ]);
    const logged = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(logged).toEqual([
      "[gui] view billing.periods: action billing.close prefill dropped",
      "[gui] view billing.periods: action billing.nope left out (unknown)",
      "[gui] view billing.periods: action billing.close left out (params)",
      "[gui] view billing.periods: action billing.close left out (params)",
      "[gui] view billing.periods: action billing.close left out (params)",
      "[gui] view billing.periods: action billing.close left out (params)",
      "[gui] view billing.periods: action billing.hidden left out (unreleased)",
    ]);
  });

  it("checks a plugin-owned kind's ids as short tokens, not UUIDs", async () => {
    const kind = "billing.site" as ActionDef["target"];
    const { m } = context([action("billing", "billing.site", { target: kind, bind: { path: { id: kind } } })]);
    const token = P1.replaceAll("-", "_");
    const ids = ["abc_1", "a/b", "..", "a".repeat(129), token];
    const out = await resolveActions(
      loaded(
        [],
        ids.map((id) => ({ action: "billing.site", params: { id } })),
      ),
      m,
    );
    expect(out.actions.map((a) => a.params.id)).toEqual(["abc_1", token]);
  });

  it("removes confirmation, bound body fields and undeclared keys from a prefill", async () => {
    const note = action("billing", "billing.note", {
      target: "billingPeriod",
      path: "/api/billing-periods/[id]",
      bind: { path: { id: "billingPeriod" }, body: { tenant_id: "tenant" } },
      input: z.object({ note: z.string(), tenant_id: z.string(), confirmation: z.unknown().optional() }),
    });
    const { m } = context([note]);
    const prefill = { note: "n", confirmation: "CLOSE", tenant_id: "other", extra: 1 };
    const link: ActionLink = { action: "billing.note", params: { id: P1, tenant_id: H1 }, prefill };
    const out = await resolveActions(loaded([], [link]), m);
    expect(out.actions[0].prefill).toEqual({ note: "n" });
  });

  it("drops keys the input does not declare at every depth, not only at the top", async () => {
    const move = action("billing", "billing.move", {
      target: "billingPeriod",
      path: "/api/billing-periods/[id]",
      bind: { path: { id: "billingPeriod" } },
      input: z.object({
        address: z.object({ street: z.string() }),
        stops: z.array(z.object({ name: z.string() })),
      }),
    } as Partial<ActionDef>);
    const { m } = context([move]);
    const prefill = {
      address: { street: "x", nationalId: "CM123", internalNote: "n" },
      stops: [{ name: "a", hidden: true }],
    };
    const link: ActionLink = { action: "billing.move", params: { id: P1 }, prefill };
    const out = await resolveActions(loaded([], [link]), m);
    expect(out.actions[0].prefill).toEqual({ address: { street: "x" }, stops: [{ name: "a" }] });
  });

  it("removes a field with writeOnly anywhere in it, and copes with fields JSON Schema cannot express", async () => {
    const secret = z.string().meta({ id: "mergeTestSecret", writeOnly: true });
    const onPeriod = {
      target: "billingPeriod",
      path: "/api/billing-periods/[id]",
      bind: { path: { id: "billingPeriod" } },
    };
    const kept = action("billing", "billing.kept", {
      ...onPeriod,
      input: z.object({
        note: z.string(),
        nullable: z.string().meta({ writeOnly: true }).nullable(),
        shared: secret,
        nested: z.object({ key: z.string().meta({ writeOnly: true }) }),
        list: z.array(z.object({ key: z.string().meta({ writeOnly: true }) })),
      }),
    } as Partial<ActionDef>);
    const dated = action("billing", "billing.dated", {
      ...onPeriod,
      input: z.object({ note: z.string(), at: z.date().optional() }),
    } as Partial<ActionDef>);
    const { m } = context([kept, dated]);
    const prefill = { note: "n", nullable: "s1", shared: "s2", nested: { key: "s3" }, list: [{ key: "s4" }] };
    const links: ActionLink[] = [
      { action: "billing.kept", params: { id: P1 }, prefill },
      { action: "billing.dated", params: { id: P1 }, prefill: { note: "n" } },
    ];
    const out = await resolveActions(loaded([], links), m);
    expect(out.actions.map((a) => [a.action, a.prefill])).toEqual([
      ["billing.kept", { note: "n" }],
      ["billing.dated", { note: "n" }],
    ]);
  });

  it("checks a prefill field by field against an input with object-level refinements", async () => {
    const onPeriod = {
      target: "billingPeriod",
      path: "/api/billing-periods/[id]",
      bind: { path: { id: "billingPeriod" }, body: { tenant_id: "tenant" } },
    };
    const range = (b: { from: string; to: string }) => b.from <= b.to;
    const strict = action("billing", "billing.strict-range", {
      ...onPeriod,
      input: z
        .strictObject({
          tenant_id: z.string(),
          from: z.iso.date(),
          to: z.iso.date(),
          token: z.string().meta({ writeOnly: true }).optional(),
          confirmation: z.unknown().optional(),
        })
        .refine(range, { path: ["from"] }),
    } as Partial<ActionDef>);
    const loose = action("billing", "billing.loose-range", {
      ...onPeriod,
      input: z.looseObject({ tenant_id: z.string(), from: z.iso.date(), to: z.iso.date() }).superRefine(() => {}),
    } as Partial<ActionDef>);
    const { m } = context([strict, loose]);
    const params = { id: P1, tenant_id: H1 };
    const links: ActionLink[] = [
      // One date only, and dates the refinement would refuse: starting values, checked per field.
      { action: "billing.strict-range", params, prefill: { from: "2026-10-01" } },
      { action: "billing.strict-range", params, prefill: { from: "2026-10-31", to: "2026-10-01" } },
      // A writeOnly field is parsed, then left out.
      { action: "billing.strict-range", params, prefill: { from: "2026-10-01", token: "t" } },
      // A loose input lets undeclared, bound and host-managed keys through the parse; the prefill still never carries them.
      { action: "billing.loose-range", params, prefill: { to: "2026-10-31", extra: 1, tenant_id: "other", confirmation: "x" } },
    ];
    const out = await resolveActions(loaded([], links), m);
    expect(out.actions.map((a) => a.prefill)).toEqual([
      { from: "2026-10-01" },
      { from: "2026-10-31", to: "2026-10-01" },
      { from: "2026-10-01" },
      { to: "2026-10-31" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still drops a prefill whose field a refined input refuses, or with a key its strict object does not take", async () => {
    const strict = action("billing", "billing.strict-range", {
      target: "billingPeriod",
      path: "/api/billing-periods/[id]",
      bind: { path: { id: "billingPeriod" }, body: { tenant_id: "tenant" } },
      input: z.strictObject({ tenant_id: z.string(), from: z.iso.date(), to: z.iso.date() }).refine((b) => b.from <= b.to),
    } as Partial<ActionDef>);
    const { m } = context([strict]);
    const params = { id: P1, tenant_id: H1 };
    const links: ActionLink[] = [
      { action: "billing.strict-range", params, prefill: { from: "1 October" } },
      { action: "billing.strict-range", params, prefill: { from: "2026-10-01", extra: 1 } },
      // A bound field is never a starting value, as for an unrefined strict input.
      { action: "billing.strict-range", params, prefill: { from: "2026-10-01", tenant_id: "other" } },
    ];
    const out = await resolveActions(loaded([], links), m);
    expect(out.actions.map((a) => a.prefill)).toEqual([undefined, undefined, undefined]);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(
      Array(3).fill("[gui] view billing.periods: action billing.strict-range prefill dropped"),
    );
  });

  it("disables the view's own action while its plugin is off, and drops another plugin's", async () => {
    const assign = action("metering", "metering.assign");
    const payments = action("payments", "payments.other", { target: "paymentAttempt" });
    const { m, states, gate } = context([close, assign, payments]);
    const message = "Billing is disabled for this organization.";
    states.set("billing", { ok: false, status: 409, code: "billing_disabled", message });
    states.set("metering", { ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled." });
    const out = await resolveActions(
      loaded(
        [{ id: "r1", tenant: H1 }],
        [
          { action: "billing.close", params: { id: P1 } },
          { action: "metering.assign", params: { id: H1 } },
        ],
      ),
      m,
    );

    expect(out.actions).toEqual([
      { action: "billing.close", params: { id: P1 }, label: "Close period", enabled: false, reason: message },
    ]);
    expect(out.kind === "collection" && out.body.rows[0].actions).toEqual([]);
    expect(gate.mock.calls.map((c: [MgmPluginName]) => c[0]).sort()).toEqual(["billing", "metering"]);
  });

  it("disables an action whose plugin state cannot be read", async () => {
    const { m, gate } = context([action("metering", "metering.assign")]);
    gate.mockRejectedValueOnce(new Error("db down"));
    const out = await resolveActions(loaded([{ id: "r1", tenant: H1 }]), m);
    const rows = out.kind === "collection" ? out.body.rows : [];
    expect(rows[0].actions).toEqual([
      {
        action: "metering.assign",
        params: { id: H1 },
        label: "metering.assign",
        enabled: false,
        reason: "Could not verify whether Metering is enabled.",
        from: "Metering",
      },
    ]);
  });

  it("does not change the loader's model", async () => {
    const { m } = context([close, action("metering", "metering.assign")]);
    const links: ActionLink[] = [{ action: "billing.close", params: { id: P1 }, prefill: { note: "n" } }];
    const model = loaded([{ id: "r1", tenant: H1 }], links);
    const copy = structuredClone(model);
    const out = await resolveActions(model, m);
    expect(model).toEqual(copy);
    expect(out.actions[0].params).toEqual(links[0].params);
    expect(out.actions[0].params).not.toBe(links[0].params);
  });
});

describe("resolveActions: availability", () => {
  it("asks each action once with every target id, on its own client, and applies the answers", async () => {
    const available = vi.fn<Available>(async () => ({ [H1]: true, [H2]: "Already assigned" }));
    const other = vi.fn<Available>(async () => ({ [H1]: true, [H2]: true }));
    const { m, newClient } = context([
      action("metering", "metering.assign", { available }),
      action("payments", "payments.note", { available: other, title: "Note" }),
    ]);
    const out = await resolveActions(
      loaded([
        { id: "r1", tenant: H1 },
        { id: "r2", tenant: H2 },
      ]),
      m,
    );

    expect(available).toHaveBeenCalledTimes(1);
    expect(available.mock.calls[0][1]).toEqual([H1, H2]);
    expect((available.mock.calls[0][0] as SurfaceRequest).organizationId).toBe(ORG_A);
    expect(newClient).toHaveBeenCalledTimes(2);
    const rows = out.kind === "collection" ? out.body.rows : [];
    expect(rows.map((r) => r.actions.map((a) => [a.action, a.enabled, a.reason]))).toEqual([
      [
        ["metering.assign", true, undefined],
        ["payments.note", true, undefined],
      ],
      [
        ["metering.assign", false, "Already assigned"],
        ["payments.note", true, undefined],
      ],
    ]);
  });

  it("shows an action unchecked when available() throws, without its error text", async () => {
    const available = vi.fn<Available>(async () => {
      throw new Error("secret detail");
    });
    const { m } = context([action("metering", "metering.assign", { available })]);
    const out = await resolveActions(loaded([{ id: "r1", tenant: H1 }]), m);
    const rows = out.kind === "collection" ? out.body.rows : [];
    expect(rows[0].actions[0]).toMatchObject({ enabled: false, reason: UNCHECKED_REASON });
    expect(JSON.stringify(out)).not.toContain("secret detail");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret detail");
  });

  it("caps a reason at 300 characters, and treats a blank one as unchecked", async () => {
    const available = vi.fn<Available>(async () => ({ [H1]: "x".repeat(400), [H2]: "  " }));
    const { m } = context([action("metering", "metering.assign", { available })]);
    const out = await resolveActions(
      loaded([
        { id: "r1", tenant: H1 },
        { id: "r2", tenant: H2 },
      ]),
      m,
    );
    const rows = out.kind === "collection" ? out.body.rows : [];
    expect(rows.map((r) => r.actions[0].reason)).toEqual(["x".repeat(300), UNCHECKED_REASON]);
  });

  it("asks available() about the id bound to the action's target kind", async () => {
    const available = vi.fn<Available>(async () => ({ [H1]: true }));
    const assign = action("metering", "metering.assign", {
      path: "/api/microgrids/[mg]/edges/register",
      bind: { path: { mg: "microgrid" }, body: { tenant_id: "tenant" } },
      available,
    });
    const { m } = context([assign]);
    const out = await resolveActions(loaded([{ id: "r1", tenant: H1 }]), m);
    expect(available.mock.calls[0][1]).toEqual([H1]);
    const rows = out.kind === "collection" ? out.body.rows : [];
    expect(rows[0].actions[0]).toMatchObject({ params: { mg: MG.id, tenant_id: H1 }, enabled: true });
  });

  it("gives every call one shared budget of 1,000 ms, and shows the late ones unchecked", async () => {
    expect(AVAILABILITY_BUDGET_MS).toBe(1_000);
    vi.useFakeTimers();
    const slow = vi.fn<Available>(() => new Promise(() => {}));
    const late = vi.fn<Available>(() => new Promise((resolve) => setTimeout(() => resolve({ [P1]: true }), 999)));
    const fast = vi.fn<Available>(async () => ({ [H1]: true }));
    const { m } = context([
      action("metering", "metering.assign", { available: slow }),
      action("payments", "payments.fast", { available: fast, title: "Fast" }),
      { ...close, def: { ...close.def, available: late } as ActionDef },
    ]);
    let done = false;
    const pending = resolveActions(
      loaded([{ id: "r1", tenant: H1 }], [{ action: "billing.close", params: { id: P1 } }]),
      m,
    ).then((value) => {
      done = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;

    expect(out.actions[0]).toMatchObject({ action: "billing.close", enabled: true });
    const rows = out.kind === "collection" ? out.body.rows : [];
    expect(rows[0].actions.map((a) => [a.action, a.enabled, a.reason])).toEqual([
      ["metering.assign", false, UNCHECKED_REASON],
      ["payments.fast", true, undefined],
    ]);
  });

  it("asks about an action kept enabled while its plugin is off, within the same budget, and not about the others", async () => {
    vi.useFakeTimers();
    const keptAnswer = vi.fn<Available>(async () => ({ [P1]: true }));
    const offAnswer = vi.fn<Available>(async () => ({ [P1]: true }));
    const slowAnswer = vi.fn<Available>(() => new Promise(() => {}));
    const kept = { ...close, def: { ...close.def, id: "billing.kept", title: "Kept", available: keptAnswer, whilePluginOff: "enabled" } as ActionDef };
    const off = { ...close, def: { ...close.def, id: "billing.off", title: "Off", available: offAnswer } as ActionDef };
    const slow = { ...close, def: { ...close.def, id: "billing.slow", title: "Slow", available: slowAnswer, whilePluginOff: "enabled" } as ActionDef };
    const { m, states } = context([kept, off, slow]);
    states.set("billing", { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled." });
    const links = (["billing.kept", "billing.off", "billing.slow"] as const).map((action) => ({ action, params: { id: P1 } }));
    const pending = resolveActions(loaded([], links), m);
    await vi.advanceTimersByTimeAsync(AVAILABILITY_BUDGET_MS);
    const out = await pending;

    expect(keptAnswer).toHaveBeenCalledWith(expect.anything(), [P1]);
    expect(offAnswer).not.toHaveBeenCalled();
    expect(out.actions.map((a) => [a.action, a.enabled, a.reason])).toEqual([
      ["billing.kept", true, undefined],
      ["billing.off", false, "Billing is disabled."],
      ["billing.slow", false, UNCHECKED_REASON],
    ]);
  });

  it("does not ask about disabled actions, nor without an organization", async () => {
    const available = vi.fn<Available>(async () => ({ [H1]: true }));
    const assign = action("metering", "metering.assign", { available });
    const off = context([assign]);
    off.states.set("metering", { ok: false, status: 503, code: "metering_gate_unavailable", message: "unreadable" });
    const offOut = await resolveActions(loaded([{ id: "r1", tenant: H1 }]), off.m);
    expect(available).not.toHaveBeenCalled();
    const offRows = offOut.kind === "collection" ? offOut.body.rows : [];
    expect(offRows[0].actions[0]).toMatchObject({
      enabled: false,
      reason: "Could not verify whether Metering is enabled.",
    });

    // A super admin reaches any organization id, so only the merge itself keeps available() from being asked.
    const ctx = contextFor(
      [superAdmin()],
      vi.fn(async () => ({}) as SupabaseClient),
    );
    const installation = context([assign], { organizationId: null, gate: null, ctx });
    const out = await resolveActions(loaded([{ id: "r1", tenant: H1 }]), installation.m);
    expect(available).not.toHaveBeenCalled();
    const rows = out.kind === "collection" ? out.body.rows : [];
    expect(rows[0].actions[0]).toMatchObject({ enabled: false, reason: UNCHECKED_REASON });
  });
});
