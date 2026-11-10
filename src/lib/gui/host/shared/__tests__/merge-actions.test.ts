import { describe, expect, it } from "vitest";
import type { ActionRef, EntityRef } from "../../../contract";
import {
  appendTargetedActions,
  fillPath,
  idFits,
  mapActionSlots,
  type ActionSlots,
  type GateState,
  type MergeAction,
  type MergeActionDef,
  type MergeInput,
} from "../merge-actions";

const M1 = "e7200000-0000-4000-8000-0000000000c1";
const H1 = "e7200000-0000-4000-8000-0000000000b1";
const H2 = "e7200000-0000-4000-8000-0000000000b2";
const L1 = "e7200000-0000-4000-8000-0000000000d1";
const MG = { kind: "microgrid", id: M1, label: "Kiwumu" } as const satisfies EntityRef;
const HH = { kind: "household", id: H1, label: "House 1" } as const satisfies EntityRef;
const HH2 = { kind: "household", id: H2, label: "House 2" } as const satisfies EntityRef;
const LINE = { kind: "lineItem", id: L1, label: "Bill 1" } as const satisfies EntityRef;

function def(id: MergeActionDef["id"], over: Partial<MergeActionDef> = {}): MergeActionDef {
  return {
    id,
    title: id,
    target: "household",
    path: "/api/x/[id]",
    method: "POST",
    risk: "write",
    confirm: "confirm",
    bind: { path: { id: "household" } },
    ...over,
  } as MergeActionDef;
}

const OK: GateState = { ok: true };
function input(actions: MergeAction[], over: Partial<MergeInput> = {}): MergeInput {
  return {
    plugin: "community-management",
    actions,
    scope: { microgrid: MG },
    gate: new Map([
      ["community-management", OK],
      ["metering", OK],
      ["billing", OK],
      ["payments", OK],
    ]),
    isReleased: () => true,
    ...over,
  };
}

const own = (action: ActionRef["action"], label: string = action): ActionRef => ({
  action,
  params: {},
  label,
  enabled: true,
});

function record(entity?: EntityRef, actions: ActionRef[] = []): ActionSlots<ActionRef> {
  return { kind: "record", body: { sections: [] }, actions, ...(entity ? { entity } : {}) };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("appendTargetedActions", () => {
  it("appends other plugins' actions on the view's entity after its own, in catalog order, then by id", () => {
    const actions: MergeAction[] = [
      { plugin: "billing", def: def("billing.zz", { title: "Bill" }) },
      { plugin: "metering", def: def("metering.b", { title: "Meter B" }) },
      { plugin: "metering", def: def("metering.a", { title: "Meter A" }) },
      { plugin: "community-management", def: def("community.own", { title: "Own" }) },
      { plugin: "billing", def: def("billing.other", { target: "microgrid", title: "Other kind" }) },
    ];
    const { model, dropped } = appendTargetedActions(record(HH, [own("community.edit", "Edit")]), input(actions));

    expect(model.actions.map((a) => a.action)).toEqual(["community.edit", "metering.a", "metering.b", "billing.zz"]);
    expect(model.actions[1]).toEqual({
      action: "metering.a",
      params: { id: H1 },
      label: "Meter A",
      enabled: true,
      from: "Metering",
    });
    expect(dropped).toEqual([]);
  });

  it("fills params from the entity for its own kind and from the path scope for others", () => {
    const a = def("metering.assign", { bind: { path: { id: "household" }, body: { microgrid_id: "microgrid" } } });
    const { model } = appendTargetedActions(record(HH), input([{ plugin: "metering", def: a }]));
    expect(model.actions[0].params).toEqual({ id: H1, microgrid_id: M1 });
  });

  it("leaves out an action whose bound kind is not available, and reports it", () => {
    const a = def("metering.assign", { bind: { path: { id: "household" }, body: { edge: "edge" } } });
    const { model, dropped } = appendTargetedActions(record(HH), input([{ plugin: "metering", def: a }]));
    expect(model.actions).toEqual([]);
    expect(dropped).toEqual([{ action: "metering.assign", reason: "unbound" }]);
  });

  it("leaves out an action whose bound id does not have its kind's shape", () => {
    const refresh = def("payments.refresh", { target: "paymentAttempt", bind: { path: { id: "paymentAttempt" } } });
    const released: string[] = [];
    const isReleased = (path: string) => (released.push(path), true);
    for (const id of ["..", "not a uuid; drop", `x${H1}`, `${H1}/..`]) {
      const on = { kind: "paymentAttempt", id, label: "Attempt" } as const;
      const { model, dropped } = appendTargetedActions(
        record(on),
        input([{ plugin: "payments", def: refresh }], { isReleased }),
      );
      expect(model.actions).toEqual([]);
      expect(dropped).toEqual([{ action: "payments.refresh", reason: "params" }]);
    }
    expect(released).toEqual([]);
  });

  it("adds each row the actions targeted at its entity or a related entity, bound to that entity", () => {
    const actions: MergeAction[] = [
      { plugin: "metering", def: def("metering.assign") },
      { plugin: "payments", def: def("payments.refresh", { target: "lineItem", bind: { path: { id: "lineItem" } } }) },
    ];
    const model: ActionSlots<ActionRef> = {
      kind: "collection",
      body: {
        columns: [],
        rows: [
          { id: "r1", entity: LINE, related: [HH], cells: {}, actions: [] },
          { id: "r2", entity: HH2, cells: {}, actions: [] },
          { id: "r3", cells: {}, actions: [] },
        ],
        empty: { title: "None" },
      },
      actions: [],
    };
    const out = appendTargetedActions(model, input(actions)).model;
    if (out.kind !== "collection") throw new Error("kind changed");
    const rows = out.body.rows.map((r) => r.actions.map((a) => [a.action, a.params.id]));
    expect(rows).toEqual([
      [
        ["metering.assign", H1],
        ["payments.refresh", L1],
      ],
      [["metering.assign", H2]],
      [],
    ]);
    expect(out.actions).toEqual([]);
    expect(out.body.empty).toEqual({ title: "None" });
  });

  it("does not repeat an action already present, and drops one whose label matches", () => {
    const actions: MergeAction[] = [
      { plugin: "metering", def: def("metering.assign", { title: "Assign" }) },
      { plugin: "billing", def: def("billing.edit", { title: " edit " }) },
      { plugin: "payments", def: def("payments.assign", { title: "ASSIGN" }) },
    ];
    const start = record(HH, [own("metering.assign", "Assign meter"), own("community.edit", "Edit")]);
    const { model, dropped } = appendTargetedActions(start, input(actions));
    expect(model.actions.map((a) => a.action)).toEqual(["metering.assign", "community.edit", "payments.assign"]);
    expect(model.actions[0].label).toBe("Assign meter");
    expect(dropped).toEqual([{ action: "billing.edit", reason: "label" }]);
  });

  it("drops a targeted action whose label matches an earlier targeted one", () => {
    const actions: MergeAction[] = [
      { plugin: "metering", def: def("metering.note", { title: "Add note" }) },
      { plugin: "billing", def: def("billing.note", { title: "add note" }) },
    ];
    const { model, dropped } = appendTargetedActions(record(HH), input(actions));
    expect(model.actions.map((a) => a.action)).toEqual(["metering.note"]);
    expect(dropped).toEqual([{ action: "billing.note", reason: "label" }]);
  });

  it("leaves out an action whose filled path is not released", () => {
    const released: string[] = [];
    const { model, dropped } = appendTargetedActions(
      record(HH),
      input([{ plugin: "metering", def: def("metering.assign", { path: "/api/households/[id]/assign" }) }], {
        isReleased: (path) => {
          released.push(path);
          return false;
        },
      }),
    );
    expect(released).toEqual([`/api/households/${H1}/assign`]);
    expect(model.actions).toEqual([]);
    expect(dropped).toEqual([{ action: "metering.assign", reason: "unreleased" }]);
  });

  it("leaves out another plugin's action while that plugin is disabled for the organization", () => {
    const gate = new Map<string, GateState>([
      ["metering", { ok: false, status: 409, message: "Metering is disabled for this organization." }],
    ]) as MergeInput["gate"];
    const { model, dropped } = appendTargetedActions(
      record(HH),
      input([{ plugin: "metering", def: def("metering.assign") }], { gate }),
    );
    expect(model.actions).toEqual([]);
    expect(dropped).toEqual([{ action: "metering.assign", reason: "disabled" }]);
  });

  it("shows an action disabled when its plugin's state could not be read", () => {
    const gate = new Map<string, GateState>([
      ["billing", { ok: false, status: 503, message: "Could not verify whether Billing is enabled. Retry." }],
    ]) as MergeInput["gate"];
    const actions: MergeAction[] = [
      { plugin: "billing", def: def("billing.charge") },
      { plugin: "metering", def: def("metering.assign") },
    ];
    const { model } = appendTargetedActions(record(HH), input(actions, { gate }));
    expect(model.actions.map((a) => [a.action, a.enabled, a.reason])).toEqual([
      ["metering.assign", false, "Could not verify whether Metering is enabled."],
      ["billing.charge", false, "Could not verify whether Billing is enabled."],
    ]);
  });

  it("marks typed, ceremony, destructive and DELETE actions as danger", () => {
    const actions: MergeAction[] = [
      { plugin: "metering", def: def("metering.a", { confirm: "typed" }) },
      { plugin: "metering", def: def("metering.b", { confirm: "ceremony" }) },
      { plugin: "metering", def: def("metering.c", { risk: "destructive" }) },
      { plugin: "metering", def: def("metering.d", { method: "DELETE" }) },
      { plugin: "metering", def: def("metering.e") },
    ];
    const { model } = appendTargetedActions(record(HH), input(actions));
    expect(model.actions.map((a) => a.tone)).toEqual(["danger", "danger", "danger", "danger", undefined]);
  });

  it("adds nothing to a view without an entity, and never changes its inputs", () => {
    const actions = deepFreeze<MergeAction[]>([{ plugin: "metering", def: def("metering.assign") }]);
    const start = deepFreeze(record(undefined, [own("community.edit")]));
    expect(appendTargetedActions(start, input(actions)).model).toEqual(start);
    const withEntity = deepFreeze(record(HH, [own("community.edit")]));
    const copy = structuredClone(withEntity);
    expect(appendTargetedActions(withEntity, input(actions)).model.actions).toHaveLength(2);
    expect(withEntity).toEqual(copy);
  });

  it("never changes a collection's rows, and gives its empty state no targeted action", () => {
    const actions = deepFreeze<MergeAction[]>([{ plugin: "metering", def: def("metering.assign") }]);
    const start: ActionSlots<ActionRef> = deepFreeze({
      kind: "collection",
      entity: HH,
      body: { columns: [], rows: [{ id: "r1", entity: HH, cells: {}, actions: [] }], empty: { title: "None" } },
      actions: [],
    });
    const copy = structuredClone(start);
    const out = appendTargetedActions(start, input(actions)).model;
    if (out.kind !== "collection") throw new Error("kind changed");
    expect(out.actions.map((a) => a.action)).toEqual(["metering.assign"]);
    expect(out.body.rows[0].actions.map((a) => a.action)).toEqual(["metering.assign"]);
    expect(out.body.empty).not.toHaveProperty("action");
    expect(start).toEqual(copy);
  });
});

const ENTRY = { at: "2026-11-09T08:00:00Z", author: { kind: "system" as const, name: "MGM" }, text: [] };

describe("mapActionSlots", () => {
  it("visits every slot, removes what the function drops, and leaves the input as it was", () => {
    const keep = own("community.keep");
    const drop = own("community.drop");
    const feed: ActionSlots<ActionRef> = deepFreeze({
      kind: "feed",
      body: {
        entries: [
          { ...ENTRY, id: "e1", embed: { type: "action", ref: drop } },
          { ...ENTRY, id: "e2", embed: { type: "action", ref: keep } },
        ],
        compose: { action: drop, textField: "text", placeholder: "Ask" },
        stop: keep,
      },
      actions: [keep, drop],
    });
    const seen: string[] = [];
    const out = mapActionSlots(feed, (a) => {
      seen.push(a.action);
      return a.action === "community.drop" ? null : a;
    });
    expect(seen).toHaveLength(6);
    if (out.kind !== "feed") throw new Error("kind changed");
    expect(out.actions).toEqual([keep]);
    expect(out.body.entries[0]).not.toHaveProperty("embed");
    expect(out.body.entries[1].embed).toEqual({ type: "action", ref: keep });
    expect(out.body).not.toHaveProperty("compose");
    expect(out.body.stop).toEqual(keep);

    const flow: ActionSlots<ActionRef> = {
      kind: "flow",
      body: { steps: [{ id: "s", title: "Step", state: "current", action: drop }] },
      actions: [],
    };
    const mapped = mapActionSlots(flow, () => null);
    expect(mapped.body).toEqual({ steps: [{ id: "s", title: "Step", state: "current" }] });
    expect(flow.body).toEqual({ steps: [{ id: "s", title: "Step", state: "current", action: drop }] });
  });
});

describe("fillPath", () => {
  it("encodes each segment and refuses a missing one", () => {
    expect(fillPath("/api/x/[id]/y", { id: "a/b" })).toBe("/api/x/a%2Fb/y");
    expect(fillPath("/api/x/[id]", {})).toBeNull();
    expect(fillPath("/api/x/[toString]", {})).toBeNull();
    expect(fillPath("/api/[a]/x/[b]", { a: "1", b: "2" })).toBe("/api/1/x/2");
    expect(fillPath("/api/[a]/x/[b]", { a: "1" })).toBeNull();
    expect(fillPath("/api/[a]", { a: "" })).toBeNull();
  });
});

describe("idFits", () => {
  it("wants a UUID for a core kind and a short token for a plugin's own kind", () => {
    expect(idFits("household", H1)).toBe(true);
    expect(idFits("household", "abc_1")).toBe(false);
    expect(idFits("household", `x${H1}`)).toBe(false);
    expect(idFits("household", `${H1}x`)).toBe(false);
    expect(idFits("metering.site", "abc_1")).toBe(true);
    expect(idFits("metering.site", "a".repeat(128))).toBe(true);
    for (const bad of ["a/b", "..", "", "a".repeat(129)]) expect(idFits("metering.site", bad)).toBe(false);
  });
});
