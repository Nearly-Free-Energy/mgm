/**
 * Within one server render an organization's watchers run once, however
 * many callers ask (organizationSignals in ../signals.ts). React's cache()
 * memoizes only inside a server render, so this stands one in: a cache()
 * that memoizes by its arguments until the "render" ends. Outside a render
 * the real cache() memoizes nothing (signals.test.ts collects afresh each
 * call).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredSignal, SurfaceSnapshot } from "../surface-registry";

const render = vi.hoisted(() => ({ memo: new Map<string, unknown>() }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache:
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      const key = JSON.stringify(args);
      if (!render.memo.has(key)) render.memo.set(key, fn(...args));
      return render.memo.get(key) as R;
    },
}));
vi.mock("@/lib/runtime/gate", () => ({ checkGate: async () => ({ ok: true, organizationId: null }) }));
let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { organizationSignals } from "../signals";
import { ORG_A, ORG_B, contextFor, managerOf, tableClient } from "./host-fakes";

const load = vi.fn(async () => []);

beforeEach(() => {
  render.memo.clear();
  load.mockClear();
  snapshot = {
    views: [],
    actions: new Map(),
    nav: [],
    signals: [{ plugin: "billing", id: "billing.due", load } as unknown as RegisteredSignal],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
});

const ctx = () => contextFor([managerOf(ORG_A), managerOf(ORG_B)], async () => tableClient({}).client);

describe("organizationSignals within one server render", () => {
  it("runs each watcher once per organization for every caller in the render, each with its own context", async () => {
    const [a, b] = await Promise.all([organizationSignals(ctx(), ORG_A), organizationSignals(ctx(), ORG_A)]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledOnce();
    await organizationSignals(ctx(), ORG_B);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("collects again in the next render", async () => {
    await organizationSignals(ctx(), ORG_A);
    render.memo.clear();
    await organizationSignals(ctx(), ORG_A);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
