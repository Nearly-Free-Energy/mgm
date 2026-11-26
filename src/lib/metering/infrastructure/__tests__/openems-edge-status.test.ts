/**
 * The OpenEMS edge-status reader: one outcome per microgrid in order; at
 * most EDGE_STATUS_CONCURRENCY microgrids read at once in the process, even
 * across overlapping calls; microgrids never read, then those read longest
 * ago, go first, so successive calls rotate through them all; a read under
 * way at the deadline answers the next call from the cache; a microgrid's read
 * builds a client from its stored configuration through the person's own
 * client and asks getEdgesStatus with the read's signal; a failure is the
 * microgrid's outcome, logged with an MGM code and never the backend's text.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMicrogridEmsConfig = vi.fn();
const getEdgesStatus = vi.fn();
const queryHistoricSamples = vi.fn();
vi.mock("@/lib/openems/config", () => ({ getMicrogridEmsConfig: (...a: unknown[]) => getMicrogridEmsConfig(...a) }));
vi.mock("@/lib/openems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openems")>();
  return {
    ...actual,
    createOpenEmsClient: () => ({
      getEdgesStatus: (...a: unknown[]) => getEdgesStatus(...a),
      queryHistoricSamples: (...a: unknown[]) => queryHistoricSamples(...a),
    }),
  };
});

import { OpenEmsError } from "@/lib/openems";
import type { MeteringComposition } from "../../compose";
import { EDGE_STATUS_CONCURRENCY, EDGE_STATUS_FRESH_MS, _resetEdgeStatusCacheForTests, type EdgeStatusRead } from "../edge-status-cache";
import { createEdgeStatusReader, meterOutcome, openEmsEdgeStatusRead, readingOrder } from "../openems-edge-status";

const ORG = "e7f40000-0000-4000-8000-000000000001";
const supabase = { marker: "person's client" } as unknown as SupabaseClient;
const composition = { scope: { organizationId: ORG, userId: "u", roles: [] }, metering: {}, dispose: async () => {} } as unknown as MeteringComposition;
const later = () => Date.now() + 60_000;

beforeEach(() => {
  _resetEdgeStatusCacheForTests();
  getMicrogridEmsConfig.mockReset();
  getEdgesStatus.mockReset();
  queryHistoricSamples.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("openEmsEdgeStatusRead", () => {
  it("builds the client from the microgrid's stored configuration on the person's client, and passes the edges and the signal", async () => {
    getMicrogridEmsConfig.mockResolvedValue({ type: "direct_url", url: "https://ems.example.test/rest" });
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: true }]);
    const signal = new AbortController().signal;
    expect(await openEmsEdgeStatusRead(supabase, "mg1", ["edge0", "edge1"])(signal)).toEqual([{ edgeId: "edge0", online: true }]);
    expect(getMicrogridEmsConfig).toHaveBeenCalledWith(supabase, "mg1");
    expect(getEdgesStatus).toHaveBeenCalledWith(["edge0", "edge1"], { signal });
  });

  it("fails when the microgrid has no configuration now, or the signal ended while it was read", async () => {
    getMicrogridEmsConfig.mockResolvedValueOnce(null);
    await expect(openEmsEdgeStatusRead(supabase, "mg1", ["edge0"])(new AbortController().signal)).rejects.toThrow();
    getMicrogridEmsConfig.mockResolvedValueOnce({ type: "direct_url", url: "https://ems.example.test/rest" });
    const ended = new AbortController();
    ended.abort();
    await expect(openEmsEdgeStatusRead(supabase, "mg1", ["edge0"])(ended.signal)).rejects.toThrow();
    expect(getEdgesStatus).not.toHaveBeenCalled();
  });
});

describe("meterOutcome", () => {
  const status = { state: "read" as const, total: 2, offline: 1, online: ["edge0"], readAt: Date.parse("2026-11-25T09:00:00Z") };
  const meters = [
    { edgeId: "edge0", componentId: "meter0" },
    { edgeId: "edge0", componentId: "meter1" },
    { edgeId: "edge1", componentId: "meter2" },
  ];

  it("counts only the meters on online edges, and quiet ones among them", () => {
    expect(meterOutcome(meters, status, { state: "read", quiet: [meters[1], meters[2]], failedEdges: [], readAt: status.readAt })).toEqual({ state: "read", total: 2, quiet: 1, readAt: "2026-11-25T09:00:00.000Z" });
  });

  it("gives no outcome when no meter is on an online edge, and passes on failed and late", () => {
    expect(meterOutcome([meters[2]], status, { state: "read", quiet: [meters[2]], failedEdges: [], readAt: status.readAt })).toBeUndefined();
    expect(meterOutcome(meters, status, { state: "failed", readAt: status.readAt })).toEqual({ state: "failed", readAt: "2026-11-25T09:00:00.000Z" });
    expect(meterOutcome(meters, status, { state: "late" })).toEqual({ state: "late" });
  });

  it("fails only for a failed edge that is online; one the backend does not know is already offline", () => {
    const answer = (failedEdges: string[]) => ({ state: "read" as const, quiet: [], failedEdges, readAt: status.readAt });
    expect(meterOutcome(meters, status, answer(["edge1"]))).toEqual({ state: "read", total: 2, quiet: 0, readAt: "2026-11-25T09:00:00.000Z" });
    expect(meterOutcome(meters, status, answer(["edge0"]))).toEqual({ state: "failed", readAt: "2026-11-25T09:00:00.000Z" });
  });
});

describe("createEdgeStatusReader", () => {
  it("reads a microgrid's status and meters side by side, from one stored configuration", async () => {
    getMicrogridEmsConfig.mockResolvedValue({ type: "direct_url", url: "https://ems.example.test/rest" });
    let statusStarted = false;
    let meterStartedBeforeStatusAnswered = false;
    let answerStatus: (v: EdgeStatusRead) => void = () => {};
    getEdgesStatus.mockImplementation(() => {
      statusStarted = true;
      return new Promise<EdgeStatusRead>((resolve) => (answerStatus = resolve));
    });
    queryHistoricSamples.mockImplementation(async (_e: string, channels: string[]) => {
      meterStartedBeforeStatusAnswered = statusStarted;
      answerStatus([{ edgeId: "edge0", online: true }]);
      return { timestamps: [new Date().toISOString()], data: { [channels[0]]: [null] } };
    });
    const out = await createEdgeStatusReader(composition, supabase).getEdgeStatuses(
      [{ microgridId: "mg", edgeIds: ["edge0"], meters: [{ edgeId: "edge0", componentId: "meter0" }] }],
      later(),
    );
    expect(meterStartedBeforeStatusAnswered).toBe(true);
    expect(getMicrogridEmsConfig).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      { microgridId: "mg", state: "read", total: 1, offline: 0, readAt: expect.any(String), meters: { state: "read", total: 1, quiet: 1, readAt: expect.any(String) } },
    ]);
  });

  it("answers each microgrid in order: read, or failed without the backend's text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getMicrogridEmsConfig.mockImplementation(async (_c: unknown, id: string) => {
      if (id === "bad") throw new OpenEmsError("401 from keycloak canary-91c2", "OPENEMS_AUTH_FAILED", 401);
      return { type: "direct_url", url: "https://ems.example.test/rest" };
    });
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: false }, { edgeId: "edge1", online: true }]);
    const out = await createEdgeStatusReader(composition, supabase).getEdgeStatuses(
      [
        { microgridId: "good", edgeIds: ["edge0", "edge1"], meters: [] },
        { microgridId: "bad", edgeIds: ["edge0"], meters: [] },
      ],
      later(),
    );
    expect(out).toEqual([
      { microgridId: "good", state: "read", total: 2, offline: 1, readAt: expect.any(String) },
      { microgridId: "bad", state: "failed", readAt: expect.any(String) },
    ]);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain("OPENEMS_AUTH_FAILED");
    expect(logged).not.toContain("canary");
    expect(JSON.stringify(out)).not.toContain("canary");
  });

  it(`reads at most ${EDGE_STATUS_CONCURRENCY} microgrids at once in the process, across overlapping calls`, async () => {
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const read = vi.fn(() => async (): Promise<EdgeStatusRead> => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
      return [];
    });
    const sites = (prefix: string) => Array.from({ length: EDGE_STATUS_CONCURRENCY + 2 }, (_, i) => ({ microgridId: `${prefix}${i}`, edgeIds: ["edge0"], meters: [] }));
    const a = createEdgeStatusReader(composition, supabase, { read }).getEdgeStatuses(sites("a"), later());
    const b = createEdgeStatusReader(composition, supabase, { read }).getEdgeStatuses(sites("b"), later());
    let started = 0;
    while (started < 2 * (EDGE_STATUS_CONCURRENCY + 2)) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      expect(running).toBeLessThanOrEqual(EDGE_STATUS_CONCURRENCY);
      started += releases.length;
      releases.splice(0).forEach((release) => release());
    }
    const out = [...(await a), ...(await b)];
    expect(most).toBe(EDGE_STATUS_CONCURRENCY);
    expect(out.every((o) => o.state === "read")).toBe(true);
  });

  it("reads never-read microgrids first, then the stalest, and serves a read that outlived the deadline from the cache", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-25T09:00:00Z") });
    try {
      const asked: string[] = [];
      const read = vi.fn((_s: SupabaseClient, id: string) => async (): Promise<EdgeStatusRead> => {
        asked.push(id);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return [{ edgeId: "edge0", online: true }];
      });
      const n = EDGE_STATUS_CONCURRENCY;
      const sites = Array.from({ length: n * 3 }, (_, i) => ({ microgridId: `mg${String(i).padStart(2, "0")}`, edgeIds: ["edge0"], meters: [] }));
      const ids = (list: readonly { microgridId: string }[]) => list.map((s) => s.microgridId);
      const reader = createEdgeStatusReader(composition, supabase, { read });

      // A 1.5 s deadline: the first n reads answer at 1 s, the next n start then and are still under way at the deadline, the rest never start.
      const first = reader.getEdgeStatuses(sites, Date.now() + 1_500);
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await first).map((o) => o.state)).toEqual([...Array(n).fill("read"), ...Array(n * 2).fill("late")]);
      expect(asked).toEqual(ids(sites.slice(0, n * 2)));

      // Those still under way finish into the cache. The second call reads only the never-read sites, and serves the rest from the cache.
      await vi.advanceTimersByTimeAsync(1_000);
      asked.length = 0;
      const second = reader.getEdgeStatuses(sites, Date.now() + 1_500);
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await second).map((o) => o.state)).toEqual(Array(n * 3).fill("read"));
      expect(asked).toEqual(ids(sites.slice(n * 2)));

      // Once every answer is stale, the oldest go first, whatever order the sites come in.
      await vi.advanceTimersByTimeAsync(EDGE_STATUS_FRESH_MS);
      const reversed = [...sites].reverse();
      expect(readingOrder(reversed).map((i) => reversed[i].microgridId)).toEqual([
        ...ids(sites.slice(0, n)).reverse(),
        ...ids(sites.slice(n, n * 2)).reverse(),
        ...ids(sites.slice(n * 2)).reverse(),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers late, with no read, a microgrid asked about after the deadline", async () => {
    const backend = vi.fn(async (): Promise<EdgeStatusRead> => []);
    const out = await createEdgeStatusReader(composition, supabase, { read: () => backend }).getEdgeStatuses(
      [{ microgridId: "mg", edgeIds: ["edge0"], meters: [] }],
      Date.now() - 1,
    );
    expect(out).toEqual([{ microgridId: "mg", state: "late" }]);
    expect(backend).not.toHaveBeenCalled();
  });
});
