import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { RegisteredSearch, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({ checkGate: (...args: unknown[]) => checkGate(...args) }));
let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { MAX_HITS, SEARCH_BUDGET_MS, runSearch } from "../search";
import { ORG_A, ORG_B, contextFor, managerOf, superAdmin, tableClient } from "./host-fakes";

const CANARY = "CANARY-7f3a91";
const mg = (i: number) => `e7100000-0000-4000-8002-${String(i).padStart(12, "0")}`;
const hit = (i: number, over: Record<string, unknown> = {}) => ({ kind: "microgrid", id: mg(i), label: `Site ${i}`, href: `/microgrids/${mg(i)}`, ...over });
const search = (plugin: MgmPluginName, find: (req: unknown, q: string) => Promise<unknown>, prefix: "@" | "#" = "@", entity = "microgrid") =>
  ({ plugin, prefix, entity, find }) as unknown as RegisteredSearch;

let roles: UserRoleRecord[];
let gates: Map<string, GateDecision>;
/** A plugin whose gate read throws, as pluginGate's does when its client cannot be made. */
let throwing: MgmPluginName | null = null;
const use = (entries: RegisteredSearch[]) => {
  snapshot = { views: [], actions: new Map(), nav: [], signals: [], status: [], search: entries, entities: new Map(), guis: [] };
};
const orgs = [
  { id: ORG_A, name: "A" },
  { id: ORG_B, name: "B" },
];
let organizations: { data: unknown; error?: { message: string } };
const ctx = () => contextFor(roles, async () => tableClient({ organizations }).client);
const run = (q: string | null, prefix: string | null = "@", org: string | null = null) => runSearch(ctx(), { q, prefix, org });
const logged = () => inspect([vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls], { depth: 10 });

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

describe("runSearch", () => {
  it("asks only the searches of the query's prefix, with the trimmed query, in the person's organization", async () => {
    const people = vi.fn(async () => [hit(1)]);
    const records = vi.fn(async () => [hit(2)]);
    use([search("community-management", people), search("billing", records, "#")]);
    expect(await run("  ki  ")).toEqual({ ok: true, value: [hit(1)] });
    expect(people).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }), "ki");
    expect(records).not.toHaveBeenCalled();
  });

  it.each<[string, string | null, string | null]>([
    ["no query", null, "@"],
    ["one character", " k ", "@"],
    ["65 characters", "k".repeat(65), "@"],
    ["a control character", "ki\u0000", "@"],
    ["a delete character", "ki\u007f", "@"],
    ["a tab inside the query", "k\ti", "@"],
    ["65 characters outside the basic plane", "\u{1F600}".repeat(65), "@"],
    ["no prefix", "ki", null],
    ["another prefix", "ki", "!"],
  ])("refuses %s with 400 before any search runs", async (_name, q, prefix) => {
    const find = vi.fn(async () => []);
    use([search("community-management", find)]);
    expect(await run(q, prefix)).toMatchObject({ ok: false, status: 400, code: "gui_bad_request" });
    expect(find).not.toHaveBeenCalled();
  });

  it("accepts 64 characters, counted as characters rather than UTF-16 units", async () => {
    use([search("community-management", async () => [hit(1)])]);
    expect(await run("é".repeat(64))).toMatchObject({ ok: true });
    expect(await run("\u{1F600}".repeat(64))).toMatchObject({ ok: true });
  });

  it(`merges searches in order, keeps a record once, and sends at most ${MAX_HITS}`, async () => {
    use([
      search("community-management", async () => Array.from({ length: 15 }, (_, i) => hit(i))),
      search("metering", async () => Array.from({ length: 15 }, (_, i) => hit(i + 6))),
    ]);
    const out = await run("si");
    expect(out.ok && out.value.map((h) => h.id)).toEqual(Array.from({ length: MAX_HITS }, (_, i) => mg(i)));
  });

  it("drops a hit whose href is not a released page and keeps the rest", async () => {
    use([search("community-management", async () => [hit(1, { href: `/microgrids/${mg(1)}/unreleased` }), hit(2), hit(3, { href: "/api/gui/view" })])]);
    expect(await run("si")).toEqual({ ok: true, value: [hit(2)] });
  });

  it.each<[string, unknown]>([
    ["a search that throws", new Error(CANARY)],
    ["a hit extra", [hit(1, { phone: CANARY })]],
    ["a hit of another kind than the search declares", [hit(1, { kind: "household", label: CANARY })]],
    ["a hit without an href", [{ kind: "microgrid", id: mg(1), label: CANARY }]],
    ["a label over its cap", [hit(1, { label: `${CANARY}${"x".repeat(300)}` })]],
    ["an id over its cap", [hit(1, { id: `${CANARY}${"x".repeat(200)}` })]],
    ["too many hits", Array.from({ length: 51 }, (_, i) => hit(i, { label: CANARY }))],
    ["something other than a list", { hits: [hit(1, { label: CANARY })] }],
  ])("leaves out %s without repeating its output, and keeps the other searches", async (_name, answer) => {
    const find = async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    };
    use([search("metering", find), search("community-management", async () => [hit(9)])]);
    const out = await run("si");
    expect(out).toEqual({ ok: true, value: [hit(9)] });
    expect(logged()).toContain(answer instanceof Error ? "search metering @: left out (threw)" : "search metering @");
    expect(logged()).not.toContain(CANARY);
  });

  it("leaves out a search that misses its budget, without holding the others", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    use([search("metering", () => new Promise(() => {})), search("community-management", async () => [hit(1)])]);
    const pending = run("si");
    await vi.advanceTimersByTimeAsync(SEARCH_BUDGET_MS);
    expect(await pending).toEqual({ ok: true, value: [hit(1)] });
    expect(logged()).toContain("search metering @: left out (late)");
  });

  it("skips the searches of a plugin whose state read throws, without repeating the error", async () => {
    throwing = "payments";
    const find = vi.fn(async () => [hit(2)]);
    use([search("payments", find), search("metering", async () => [hit(3)])]);
    const out = await run("si");
    expect(out).toEqual({ ok: true, value: [hit(3)] });
    expect(find).not.toHaveBeenCalled();
    expect(logged()).not.toContain(CANARY);
  });

  it("answers 503 without repeating the error when the organizations cannot be read", async () => {
    organizations = { data: null, error: { message: CANARY } };
    const out = await run("si");
    expect(out).toMatchObject({ ok: false, status: 503, code: "gui_unavailable" });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("skips the searches of a plugin that is off or whose state cannot be read", async () => {
    const off = vi.fn(async () => [hit(1)]);
    const unknown = vi.fn(async () => [hit(2)]);
    gates.set("billing", { ok: false, status: 409, code: "billing_disabled", message: "Billing is off" });
    gates.set("payments", { ok: false, status: 503, code: "payments_gate_unavailable", message: "?" });
    use([search("billing", off), search("payments", unknown), search("metering", async () => [hit(3)])]);
    expect(await run("si")).toEqual({ ok: true, value: [hit(3)] });
    expect(off).not.toHaveBeenCalled();
    expect(unknown).not.toHaveBeenCalled();
  });

  it("searches the organization asked for when the person can see it, otherwise their first", async () => {
    roles = [superAdmin()];
    const seen: string[] = [];
    use([search("metering", async (req) => (seen.push((req as { organizationId: string }).organizationId), []))]);
    for (const org of [ORG_B, "not-a-uuid", "x".repeat(200), null]) expect(await run("si", "@", org)).toMatchObject({ ok: true });
    expect(seen).toEqual([ORG_B, ORG_A, ORG_A, ORG_A]);
  });

  it("refuses with 403 when the person can see no organization", async () => {
    roles = [managerOf("e7100000-0000-4000-8000-0000000000ff")];
    expect(await run("si")).toMatchObject({ ok: false, status: 403, code: "gui_no_access" });
  });

  it("refuses a context hostContext did not issue", async () => {
    await expect(runSearch({ ...ctx() }, { q: "si", prefix: "@", org: null })).rejects.toThrow(/did not issue/);
  });
});
