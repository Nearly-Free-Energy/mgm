/**
 * Every action declared repeat "safe" (src/lib/gui/surface.ts, ADR-006
 * decision 11), sent twice to its own route against a live database, as the
 * person it is offered to. The first send must write. The second, an
 * identical request, must leave every row the snapshot reads
 * (./repeat/harness.ts) as the first left it. Both are judged apart from
 * the columns the case lists in `ignore`, each of one row and with why. The
 * second may answer unlike the first. This is the evidence for each "safe"
 * declaration: where a case fails, the action is not "safe".
 *
 * The sends are one after the other, so this shows nothing about two copies
 * sent at once: those rest on each route's own locks. Outside state is held
 * still, the meters and the payment provider answering the same both times,
 * so "safe" here is safe against the same meter data and the same provider
 * answer.
 *
 * A billing, payments or Pesapal action that fails declares "unsafe" and goes
 * into REPEAT_KEY_PENDING (./repeat/exemptions.ts) with the issue that will
 * build its repeat key; its case leaves this test until it is "keyed".
 *
 * The first block needs no database: every "safe" action has a case in its
 * plugin's module and every case a "safe" action, nothing is "keyed" yet,
 * and each case's action has a route file exporting its method, the handler
 * the case is sent to (handlerFor), with the case filling its path segments.
 * Self-fixturing; the database block honours SKIP_RLS_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import type { TestUser } from "@/lib/supabase/__tests__/rls.helpers";

const session = vi.hoisted(() => ({ caller: null as TestUser | null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!session.caller) throw new Error("[repeat.db] no caller");
    return session.caller.client;
  },
}));
// Metering's routes refresh the pages they change, which needs the Next.js
// request this test does not run in; refreshing writes no row.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import type { MgmPluginName } from "@/lib/plugins/bundled";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import {
  assertEnvironmentReady,
  LOCAL_SUPABASE_URL,
  mintServiceRoleJwt,
  shouldSkip,
} from "@/lib/supabase/__tests__/rls.helpers";
import { BILLING_CASES } from "./repeat/billing";
import { absentIgnores, handlerFor, send, snapshot, without, type CaseModule, type Fixture } from "./repeat/harness";
import { METERING_CASES } from "./repeat/metering";
import { PAYMENTS_CASES } from "./repeat/payments";

/** One module per plugin with "safe" actions. A plugin's first "safe" action adds its module here. */
const MODULES: Partial<Record<MgmPluginName, CaseModule>> = {
  billing: BILLING_CASES,
  payments: PAYMENTS_CASES,
  metering: METERING_CASES,
};

const modules = Object.entries(MODULES) as [MgmPluginName, CaseModule][];
const allCases = modules.flatMap(([plugin, module]) =>
  Object.entries(module.cases).flatMap(([id, cases]) =>
    (cases ?? []).map((c) => ({ plugin, module, id, c, name: c.label ? `${id}: ${c.label}` : id })),
  ),
);

const registered = async () => [...(await getMgmRuntime()).mgmSurface.snapshot().actions.values()];

afterAll(() => resetMgmRuntimeForTests());

describe("the twice-sent cases", () => {
  it("cover every safe action in its own plugin's module, and only safe actions", async () => {
    const actions = await registered();
    const safe = actions.filter((a) => a.def.repeat === "safe").map((a) => a.def.id);
    expect([...new Set(allCases.map((r) => r.id))].sort(), "Each safe action needs a case: add one to its plugin's module").toEqual(safe.sort());
    const plugins = new Map(actions.map((a) => [a.def.id as string, a.plugin]));
    expect(allCases.filter((r) => plugins.get(r.id) !== r.plugin).map((r) => `${r.id} is in ${r.plugin}'s module`)).toEqual([]);
  });

  it("find no keyed action, as no route takes a repeat key yet", async () => {
    // RFC #259 § 3 asks for a keyed action to be sent twice with its key.
    // Where a key's record is kept is still open on #259, so a "keyed"
    // declaration waits for a route that takes one and a case that sends it.
    expect((await registered()).filter((a) => a.def.repeat === "keyed").map((a) => a.def.id)).toEqual([]);
  });

  it("send each case to its action's own route, with the action's path segments", async () => {
    const actions = new Map((await registered()).map((a) => [a.def.id as string, a.def]));
    const problems = await Promise.all(
      allCases.map(async ({ id, c, name }) => {
        const def = actions.get(id);
        if (!def) return [`${name}: no such action`];
        const out: string[] = [];
        const handler = await handlerFor(def).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        if (typeof handler === "string") out.push(`${name}: no route file for ${def.path}: ${handler}`);
        else if (!handler) out.push(`${name}: src/app${def.path}/route.ts exports no ${def.method}`);
        const segments = Object.keys(def.bind.path ?? {}).sort();
        if (JSON.stringify(Object.keys(c.params).sort()) !== JSON.stringify(segments)) {
          out.push(`${name}: params ${Object.keys(c.params).join(", ")} are not bind.path's ${segments.join(", ")}`);
        }
        return out;
      }),
    );
    expect(problems.flat()).toEqual([]);
  });

  it("drop an ignored column from the row it names only, and refuse one no row has", () => {
    const s = {
      payment_attempts: [
        { id: "a", status: "confirmation_pending", updated_at: "t1" },
        { id: "b", status: "needs_reconciliation", updated_at: "t1" },
      ],
    };
    const ignore = { column: "payment_attempts.updated_at", row: { id: "a" }, reason: "fixture" };
    expect(without(s, [ignore])).toEqual({
      payment_attempts: [
        { id: "a", status: "confirmation_pending" },
        { id: "b", status: "needs_reconciliation", updated_at: "t1" },
      ],
    });
    expect(absentIgnores(s, [ignore])).toEqual([]);
    expect(absentIgnores(s, [{ ...ignore, row: { id: "c" } }])).toEqual(['payment_attempts.updated_at of {"id":"c"}']);
    expect(absentIgnores(s, [{ ...ignore, column: "payment_attempts.paid_at" }])).toEqual(['payment_attempts.paid_at of {"id":"a"}']);
    // A row is named by its table's whole primary key and nothing else.
    expect(absentIgnores(s, [{ ...ignore, row: { status: "confirmation_pending" } }])).toHaveLength(1);
    expect(absentIgnores(s, [{ ...ignore, row: { id: "a", status: "confirmation_pending" } }])).toHaveLength(1);
  });
});

describe.skipIf(shouldSkip())("each safe action sent twice (live database)", () => {
  const fixtures = new Map<MgmPluginName, Fixture>();
  let fetchSpy: MockInstance<typeof fetch> | null = null;

  beforeAll(async () => {
    await assertEnvironmentReady();
    // The payments routes look the attempt up, and Payments builds its
    // repository, with a service-role client (src/lib/supabase/service.ts):
    // SUPABASE_SERVICE_ROLE_KEY and the server URL, where
    // SUPABASE_INTERNAL_URL wins over MGM_PUBLIC_SUPABASE_URL. If that file
    // reads other names, revisit.
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
    vi.stubEnv("SUPABASE_INTERNAL_URL", "");
    fetchSpy = vi.spyOn(globalThis, "fetch");
    const runtime = await getMgmRuntime();
    for (const [plugin, module] of modules) {
      await module.cleanup(runtime);
      fixtures.set(plugin, await module.seed(runtime));
    }
  }, 180_000);

  afterAll(async () => {
    session.caller = null;
    const runtime = await getMgmRuntime();
    for (const [, module] of modules) await module.cleanup(runtime);
    fetchSpy?.mockRestore();
    vi.unstubAllEnvs();
  }, 180_000);

  it.each(allCases.map((r) => [r.name, r] as const))("%s", async (_name, { plugin, id, c }) => {
    const def = (await getMgmRuntime()).mgmSurface.snapshot().actions.get(id as `${string}.${string}`)?.def;
    if (!def) throw new Error(`[repeat.db] no action ${id}`);
    const fixture = fixtures.get(plugin);
    const caller = fixture?.users[c.as];
    const handler = await handlerFor(def);
    if (!fixture || !caller || !handler) throw new Error(`[repeat.db] ${id}: no fixture, ${c.as} or handler`);
    session.caller = caller;

    const body = await c.body(caller);
    const parsed = def.input.safeParse(body);
    expect(parsed.error?.issues ?? [], "the body must be one the action's input accepts").toEqual([]);

    const before = await snapshot(fixture.orgId);
    const first = await send(handler, def, c.params, body);
    expect(first.status, first.text).toBe(c.first);
    const once = await snapshot(fixture.orgId);
    // Compared as the second send is, so a first send that moved only an
    // ignored column does not count as having written.
    expect(without(once, c.ignore), "the first send must write, or the case shows nothing").not.toEqual(without(before, c.ignore));

    const second = await send(handler, def, c.params, body);
    expect(second.status, second.text).toBe(c.second);
    const twice = await snapshot(fixture.orgId);
    expect(absentIgnores(twice, c.ignore), "each ignored column must be one of a row the snapshot reads").toEqual([]);
    expect(without(twice, c.ignore), "the second send changed a row").toEqual(without(once, c.ignore));
  }, 60_000);

  it("called nothing but the local Supabase", () => {
    const urls = (fetchSpy?.mock.calls ?? []).map(([input]) => String(input instanceof Request ? input.url : input));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.startsWith(LOCAL_SUPABASE_URL))).toEqual([]);
  });
});
