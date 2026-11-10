import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { ActionDef } from "../../../surface";
import type { RegisteredAction, RegisteredSignal, RegisteredStatus, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({ checkGate: (...args: unknown[]) => checkGate(...args) }));
let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { UNCHECKED_REASON } from "../merge";
import { MAX_TOP, collectSignals, collectStatus } from "../signals";
import { ORG_A, ORG_B, contextFor, managerOf, superAdmin, tableClient } from "./host-fakes";

const MG = "e7100000-0000-4000-8002-0000000000a1";
const CANARY = "CANARY-7f3a91";
const AT = "2026-11-09T07:00:00Z";

const base = { severity: "warn", title: "Readings missing", href: "/microgrids", at: AT };
const watcher = (plugin: MgmPluginName, id: string, load: () => Promise<unknown>, budgetMs?: number): RegisteredSignal =>
  ({ plugin, id, load, ...(budgetMs ? { budgetMs } : {}) }) as unknown as RegisteredSignal;
const action = (over: Record<string, unknown> = {}, plugin: MgmPluginName = "metering"): RegisteredAction => ({
  plugin,
  def: {
    id: "metering.backend",
    title: "Change the data source",
    target: "microgrid",
    input: z.object({ url: z.string() }),
    inputVersion: 1,
    path: "/api/microgrids/[id]/openems-backend",
    method: "PUT",
    bind: { path: { id: "microgrid" } },
    risk: "write",
    confirm: "confirm",
    humanOnly: false,
    ...over,
  } as unknown as ActionDef,
});
const provenance = { by: "watcher", at: AT };
const proposal = (over: Record<string, unknown> = {}) => ({
  ...base,
  id: "p1",
  kind: "proposal",
  action: { action: "metering.backend", params: { id: MG }, provenance, ...over },
});

let roles: UserRoleRecord[];
let gates: Map<string, GateDecision>;
/** A plugin whose gate read throws, as pluginGate's does when its client cannot be made. */
let throwing: MgmPluginName | null = null;
const use = (signals: RegisteredSignal[], actions: RegisteredAction[] = []) => {
  snapshot = {
    views: [],
    actions: new Map(actions.map((a) => [a.def.id, a])),
    nav: [],
    signals,
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
};
const orgs = [
  { id: ORG_A, name: "A" },
  { id: ORG_B, name: "B" },
];
let organizations: { data: unknown; error?: { message: string } };
const ctx = () => contextFor(roles, async () => tableClient({ organizations }).client);
const collect = (requested?: string) => collectSignals(ctx(), { requested });
const logged = () => inspect([vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls], { depth: 10 });
async function value() {
  const out = await collect();
  if (!out.ok) throw new Error(`refused: ${out.code}`);
  return out.value;
}

beforeEach(() => {
  roles = [managerOf(ORG_A)];
  organizations = { data: orgs };
  gates = new Map();
  use([]);
  checkGate.mockReset().mockImplementation(async (_s: unknown, r: { plugin: string }) => {
    if (r.plugin === throwing) throw new Error(CANARY);
    return gates.get(r.plugin) ?? { ok: true, organizationId: ORG_A };
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  throwing = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("collectSignals", () => {
  it("sets each signal's source, lists the watchers that answered, and sorts by severity, due date and time", async () => {
    use([
      watcher("metering", "metering.readings", async () => [
        { ...base, id: "a", kind: "info", severity: "info" },
        { ...base, id: "b", kind: "alarm", severity: "critical", at: "2026-11-08T07:00:00Z" },
        { ...base, id: "c", kind: "your-move", due: "2026-11-12" },
        { ...base, id: "u", kind: "question" },
        // 06:00Z, older than a's 07:00Z although it reads later as text.
        { ...base, id: "f", kind: "info", severity: "info", at: "2026-11-09T09:00:00+03:00" },
      ]),
      watcher("billing", "billing.due", async () => [
        { ...base, id: "d", kind: "alarm", severity: "critical" },
        { ...base, id: "e", kind: "question", due: "2026-11-10" },
        // 2026-11-09T23:00Z, before e's date although it reads later as text.
        { ...base, id: "g", kind: "question", due: "2026-11-10T02:00:00+03:00" },
      ]),
    ]);
    const out = await value();
    expect(out).toMatchObject({ type: "signals", org: ORG_A, count: 8, checked: ["metering.readings", "billing.due"], unchecked: [] });
    expect(out.top.map((s) => [s.id, s.source])).toEqual([
      ["d", "billing.due"],
      ["b", "metering.readings"],
      ["g", "billing.due"],
      ["e", "billing.due"],
      ["c", "metering.readings"],
      ["u", "metering.readings"],
      ["a", "metering.readings"],
      ["f", "metering.readings"],
    ]);
  });

  it(`counts every signal and sends the first ${MAX_TOP}`, async () => {
    use([watcher("metering", "metering.many", async () => Array.from({ length: 30 }, (_, i) => ({ ...base, id: `s${i}`, kind: "info" })))]);
    const out = await value();
    expect([out.count, out.top.length]).toEqual([30, MAX_TOP]);
  });

  it("lists a watcher that misses its own budget, or the default one, as unchecked, without holding the others", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const after = (ms: number) => () => new Promise<unknown>((resolve) => setTimeout(() => resolve([]), ms));
    use([
      watcher("metering", "metering.slow", () => new Promise(() => {})),
      watcher("metering", "metering.short", after(500), 200),
      watcher("metering", "metering.default", after(1_000)),
      watcher("metering", "metering.long", after(1_600), 3_000),
      watcher("billing", "billing.due", async () => [{ ...base, id: "d", kind: "alarm" }]),
    ]);
    const pending = collect();
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await pending;
    expect(out.ok && [out.value.checked, out.value.unchecked, out.value.count]).toEqual([
      ["metering.default", "metering.long", "billing.due"],
      ["metering.slow", "metering.short"],
      1,
    ]);
    expect(logged()).toContain("metering.slow: not checked (late)");
    expect(logged()).toContain("metering.short: not checked (late)");
  });

  it("skips a disabled plugin's watchers and lists one whose plugin state cannot be read as unchecked", async () => {
    const off = vi.fn(async () => []);
    const unknown = vi.fn(async () => []);
    gates.set("billing", { ok: false, status: 409, code: "billing_disabled", message: "Billing is off" });
    gates.set("payments", { ok: false, status: 503, code: "payments_gate_unavailable", message: "?" });
    use([watcher("billing", "billing.due", off), watcher("payments", "payments.failed", unknown), watcher("metering", "metering.ok", async () => [])]);
    const out = await value();
    expect([out.checked, out.unchecked]).toEqual([["metering.ok"], ["payments.failed"]]);
    expect(off).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();
    expect(logged()).toContain("payments.failed: not checked (gate)");
  });

  it("lists a watcher whose plugin state read throws as unchecked, without running it or repeating the error", async () => {
    throwing = "payments";
    const load = vi.fn(async () => []);
    use([watcher("payments", "payments.failed", load), watcher("metering", "metering.ok", async () => [])]);
    const out = await collect();
    expect(out.ok && [out.value.checked, out.value.unchecked]).toEqual([["metering.ok"], ["payments.failed"]]);
    expect(load).not.toHaveBeenCalled();
    expect(logged()).toContain("payments.failed: not checked (gate)");
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(logged()).not.toContain(CANARY);
  });

  it.each<[string, unknown]>([
    ["a watcher that throws", new Error(CANARY)],
    ["a signal extra", [{ ...base, id: "x", kind: "info", phone: CANARY }]],
    ["an EntityRef extra", [{ ...base, id: "x", kind: "info", entity: { kind: "microgrid", id: MG, label: "K", email: CANARY } }]],
    ["a your-move signal with an action", [{ ...base, id: "x", kind: "your-move", action: { action: "metering.backend", params: { id: MG }, label: CANARY } }]],
    ["a source the watcher set itself", [{ ...base, id: "x", kind: "info", source: "billing.due", title: CANARY }]],
    ["an unreleased href", [{ ...base, id: "x", kind: "info", href: `/microgrids/${CANARY}/x` }]],
    ["an unreleased href in a fact", [{ ...base, id: "x", kind: "info", facts: [{ t: "ref", text: "K", ref: { kind: "microgrid", id: "k", label: "K", href: `/${CANARY}` } }] }]],
    ["an action link extra on a proposal", [proposal({ secret: CANARY })]],
    ["a proposal without provenance", [proposal({ provenance: undefined, label: CANARY })]],
    ["a proposal claiming the assistant proposed it", [proposal({ provenance: { by: "assistant", at: AT }, label: CANARY })]],
    ["a proposal naming a proposal id", [proposal({ provenance: { ...provenance, proposal: CANARY } })]],
    ["more signals than one watcher may send", Array.from({ length: 51 }, (_, i) => ({ ...base, id: `s${i}`, kind: "info", title: CANARY }))],
    ["a signal over the size cap", [{ ...base, id: "x", kind: "info", title: `${CANARY}${"x".repeat(5_000)}` }]],
  ])("lists %s as unchecked, without repeating its output", async (_name, answer) => {
    const load = async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    };
    use([watcher("metering", "metering.readings", load), watcher("billing", "billing.due", async () => [])], [action()]);
    const out = await collect();
    expect(out.ok && [out.value.checked, out.value.unchecked, out.value.count]).toEqual([["billing.due"], ["metering.readings"], 0]);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(logged()).toContain(`metering.readings: not checked (${answer instanceof Error ? "threw" : "invalid"})`);
    expect(logged()).not.toContain(CANARY);
  });

  it("resolves a proposal's action for the person, with its provenance, and asks its available()", async () => {
    const available = vi.fn(async (_req: unknown, ids: string[]) => Object.fromEntries(ids.map((id) => [id, "Backend is busy"])));
    use([watcher("metering", "metering.fix", async () => [proposal({ label: "Point at the new backend" })])], [action({ available })]);
    const out = await value();
    expect(out.top).toEqual([
      {
        ...base,
        id: "p1",
        kind: "proposal",
        source: "metering.fix",
        action: { action: "metering.backend", params: { id: MG }, label: "Point at the new backend", enabled: false, reason: "Backend is busy", provenance },
      },
    ]);
    expect(available).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), [MG]);
  });

  it("gives each proposal its own action and availability, after sorting", async () => {
    const MG2 = "e7100000-0000-4000-8002-0000000000a2";
    const available = vi.fn(async (_req: unknown, ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === MG ? "Backend is busy" : true])));
    use(
      [
        watcher("metering", "metering.fix", async () => [
          proposal({ label: "First" }),
          { ...proposal({ params: { id: MG2 }, label: "Second" }), id: "p2", severity: "critical" },
        ]),
      ],
      [action({ available })],
    );
    const out = await value();
    expect(out.top.map((s) => [s.id, s.kind === "proposal" && s.action])).toEqual([
      ["p2", expect.objectContaining({ params: { id: MG2 }, label: "Second", enabled: true })],
      ["p1", expect.objectContaining({ params: { id: MG }, label: "First", enabled: false, reason: "Backend is busy" })],
    ]);
  });

  it("shows a proposal of another plugin whose state read throws disabled, as a view's action is", async () => {
    throwing = "billing";
    use([watcher("metering", "metering.fix", async () => [proposal()])], [action({}, "billing")]);
    const out = await value();
    expect(out.top[0]).toMatchObject({ id: "p1", action: { enabled: false, reason: "Could not verify whether Billing is enabled." } });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("answers 503 without repeating the error when the organizations cannot be read", async () => {
    organizations = { data: null, error: { message: CANARY } };
    const out = await collect();
    expect(out).toMatchObject({ ok: false, status: 503, code: "gui_unavailable" });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("shows a proposal disabled when its available() cannot answer", async () => {
    use([watcher("metering", "metering.fix", async () => [proposal()])], [action({ available: async () => Promise.reject(new Error(CANARY)) })]);
    const out = await value();
    expect(out.top[0]).toMatchObject({ kind: "proposal", action: { enabled: false, reason: UNCHECKED_REASON } });
    expect(logged()).not.toContain(CANARY);
  });

  it.each<[string, RegisteredAction[]]>([
    ["an unknown action", []],
    ["a human-only action", [action({ humanOnly: true })]],
    ["an action of a plugin that is off", [action({}, "billing")]],
    ["an action on an unreleased route", [action({ path: "/api/microgrids/[id]/unreleased" })]],
  ])("leaves out a proposal of %s and keeps the watcher's other signals", async (_name, actions) => {
    gates.set("billing", { ok: false, status: 409, code: "billing_disabled", message: "Billing is off" });
    use([watcher("metering", "metering.fix", async () => [proposal(), { ...base, id: "kept", kind: "info" }])], actions);
    const out = await value();
    expect([out.checked, out.top.map((s) => s.id)]).toEqual([["metering.fix"], ["kept"]]);
  });

  it("collects for the organization asked for when the person can see it, otherwise their first", async () => {
    roles = [superAdmin()];
    const seen: (string | null)[] = [];
    use([watcher("metering", "metering.seen", async (...args: unknown[]) => (seen.push((args[0] as { organizationId: string }).organizationId), []))]);
    for (const requested of [ORG_B, "not-a-uuid", undefined]) {
      const out = await collect(requested);
      expect(out.ok && out.value.org).toBe(seen.at(-1));
    }
    expect(seen).toEqual([ORG_B, ORG_A, ORG_A]);
  });

  it("refuses with 403 when the person can see no organization", async () => {
    roles = [managerOf("e7100000-0000-4000-8000-0000000000ff")];
    expect(await collect()).toMatchObject({ ok: false, status: 403, code: "gui_no_access" });
  });

  it("refuses a context hostContext did not issue", async () => {
    await expect(collectSignals({ ...ctx() }, {})).rejects.toThrow(/did not issue/);
  });
});

describe("collectStatus", () => {
  // The manifest model drops an unreleased `open` too (../shared/manifest-model.ts); this pins the loader's own check.
  it("leaves out an item that opens a page that is not released, or is not an object", async () => {
    const status = (id: string, load: () => Promise<unknown>) => ({ plugin: "metering", id, load }) as unknown as RegisteredStatus;
    const items = await collectStatus(ctx(), ORG_A, [
      status("metering.kept", async () => ({ label: "Kept", state: "idle", open: "/microgrids" })),
      status("metering.unreleased", async () => ({ label: "Elsewhere", state: "idle", open: "/microgrids/x/unreleased" })),
      status("metering.undefined", async () => undefined),
    ]);
    expect(items).toEqual([{ id: "metering.kept", label: "Kept", state: "idle", open: "/microgrids" }, null, null]);
  });
});
