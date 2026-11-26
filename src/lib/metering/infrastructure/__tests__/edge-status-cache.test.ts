/**
 * The edge-status cache: a fresh answer is served without a read for five
 * minutes, a failure for one; a changed set of edges reads again; concurrent
 * callers share one read; a read times out at its own limit even when it
 * ignores its signal; at most EDGE_STATUS_CONCURRENCY reads run at once in
 * the process, and one still waiting for a slot at its caller's deadline
 * never starts; a read under way at the deadline answers "late" and keeps
 * its answer for the next caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDGE_STATUS_CACHE_MAX,
  EDGE_STATUS_CONCURRENCY,
  EDGE_STATUS_FAILURE_MS,
  EDGE_STATUS_FRESH_MS,
  EDGE_STATUS_READ_TIMEOUT_MS,
  _resetEdgeStatusCacheForTests,
  cachedEdgeStatus,
  cachedMeterActivity,
  fingerprintOf,
  lastReadAt,
  meterFingerprintOf,
  onlineOf,
  summarize,
  type EdgeStatusRead,
} from "../edge-status-cache";

const MG = "e7f30000-0000-4000-8000-0000000000a1";
const EDGES = ["edge0", "edge1"];
const now = () => Date.now();
/** Plenty of time: a read may always start. */
const roomy = () => ({ deadlineMs: Date.now() + 60_000, now });

const answering = (statuses: EdgeStatusRead) => vi.fn(async () => statuses);
const ONE_OFF: EdgeStatusRead = [
  { edgeId: "edge0", online: true },
  { edgeId: "edge1", online: false },
];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-25T09:00:00Z") });
  _resetEdgeStatusCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("summarize and fingerprintOf", () => {
  it("counts each edge asked about once, and one the answer leaves out or marks offline as offline", () => {
    expect(summarize(["edge0", "edge1", "edge2", "edge0", ""], [{ edgeId: "edge0", online: true }, { edgeId: "edge1", online: false }])).toEqual({ total: 3, offline: 2 });
    expect(summarize(["edge0"], [{ edgeId: "other", online: true }])).toEqual({ total: 1, offline: 1 });
  });

  it("names the same edges the same whatever their order or repeats", () => {
    expect(fingerprintOf(["b", "a", "a"])).toBe(fingerprintOf(["a", "b"]));
    expect(fingerprintOf(["a"])).not.toBe(fingerprintOf(["a", "b"]));
  });

  it("lists the online edges asked about once each, and names the same meters the same", () => {
    expect(onlineOf(["edge1", "edge0", "edge0", "edge9", ""], [{ edgeId: "edge0", online: true }, { edgeId: "edge1", online: false }, { edgeId: "edge9", online: true }])).toEqual(["edge0", "edge9"]);
    const m = (edgeId: string, componentId: string) => ({ edgeId, componentId });
    expect(meterFingerprintOf([m("e1", "meter0"), m("e0", "meter0"), m("e0", "meter0")])).toBe(meterFingerprintOf([m("e0", "meter0"), m("e1", "meter0")]));
    expect(meterFingerprintOf([m("e0", "meter0")])).not.toBe(meterFingerprintOf([m("e0", "meter1")]));
  });
});

describe("cachedMeterActivity", () => {
  const METERS = [{ edgeId: "edge0", componentId: "meter0" }];

  it("keeps its answer apart from the status answer, keyed by the meters asked about", async () => {
    const meterRead = vi.fn(async () => ({ quiet: METERS, failedEdges: [] }));
    const statusRead = answering(ONE_OFF);
    expect(await cachedMeterActivity(MG, METERS, meterRead, roomy())).toEqual({ state: "read", quiet: METERS, failedEdges: [], readAt: Date.now() });
    await cachedEdgeStatus(MG, EDGES, statusRead, roomy());
    expect(await cachedMeterActivity(MG, METERS, meterRead, roomy())).toMatchObject({ state: "read" });
    expect(meterRead).toHaveBeenCalledTimes(1);
    expect(statusRead).toHaveBeenCalledTimes(1);
    await cachedMeterActivity(MG, [...METERS, { edgeId: "edge0", componentId: "meter1" }], meterRead, roomy());
    expect(meterRead).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(EDGE_STATUS_FRESH_MS);
    await cachedMeterActivity(MG, [...METERS, { edgeId: "edge0", componentId: "meter1" }], meterRead, roomy());
    expect(meterRead).toHaveBeenCalledTimes(3);
  });

  it("keeps an answer with a failed edge for one minute only, so the edge is asked again soon", async () => {
    const meterRead = vi.fn(async () => ({ quiet: [], failedEdges: ["edge0"] }));
    expect(await cachedMeterActivity(MG, METERS, meterRead, roomy())).toMatchObject({ state: "read", failedEdges: ["edge0"] });
    vi.advanceTimersByTime(EDGE_STATUS_FAILURE_MS - 1);
    await cachedMeterActivity(MG, METERS, meterRead, roomy());
    expect(meterRead).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await cachedMeterActivity(MG, METERS, meterRead, roomy());
    expect(meterRead).toHaveBeenCalledTimes(2);
  });

  it(`shares the process's ${EDGE_STATUS_CONCURRENCY} slots with the status reads`, async () => {
    const releases: (() => void)[] = [];
    const hold = <T>(value: T) => vi.fn(() => new Promise<T>((resolve) => releases.push(() => resolve(value))));
    const statusReads = Array.from({ length: EDGE_STATUS_CONCURRENCY }, (_, i) => cachedEdgeStatus(`mg${i}`, EDGES, hold<EdgeStatusRead>([]), roomy()));
    const meterRead = hold({ quiet: [], failedEdges: [] });
    const waiting = cachedMeterActivity(MG, METERS, meterRead, roomy());
    await vi.advanceTimersByTimeAsync(0);
    expect(meterRead).not.toHaveBeenCalled();
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(meterRead).toHaveBeenCalledTimes(1);
    releases.splice(0).forEach((release) => release());
    await Promise.all([...statusReads, waiting]);
  });
});

describe("cachedEdgeStatus", () => {
  it("reads, then serves the answer from the cache until it is five minutes old", async () => {
    const read = answering(ONE_OFF);
    const first = await cachedEdgeStatus(MG, EDGES, read, roomy());
    expect(first).toEqual({ state: "read", total: 2, offline: 1, online: ["edge0"], readAt: Date.now() });
    vi.advanceTimersByTime(EDGE_STATUS_FRESH_MS - 1);
    expect(await cachedEdgeStatus(MG, EDGES, read, roomy())).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    const again = await cachedEdgeStatus(MG, EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ state: "read", readAt: Date.now() });
  });

  it("keeps a failure for one minute only, without what the read threw", async () => {
    const read = vi.fn(async (): Promise<EdgeStatusRead> => {
      throw new Error("401 from keycloak canary-5e1d");
    });
    const failed = await cachedEdgeStatus(MG, EDGES, read, roomy());
    expect(failed).toEqual({ state: "failed", readAt: Date.now() });
    expect(JSON.stringify(failed)).not.toContain("canary");
    vi.advanceTimersByTime(EDGE_STATUS_FAILURE_MS - 1);
    await cachedEdgeStatus(MG, EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    read.mockResolvedValueOnce(ONE_OFF);
    expect(await cachedEdgeStatus(MG, EDGES, read, roomy())).toMatchObject({ state: "read", offline: 1 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads again when the microgrid's edges changed, and keeps one entry per microgrid", async () => {
    const read = answering(ONE_OFF);
    await cachedEdgeStatus(MG, EDGES, read, roomy());
    await cachedEdgeStatus(MG, [...EDGES, "edge2"], read, roomy());
    expect(read).toHaveBeenCalledTimes(2);
    // The second read replaced the first: the first set is read again.
    await cachedEdgeStatus(MG, EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(3);
    // Another microgrid has its own entry.
    await cachedEdgeStatus("other", EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("shares one read under way between concurrent callers", async () => {
    let finish: (v: EdgeStatusRead) => void = () => {};
    const read = vi.fn(() => new Promise<EdgeStatusRead>((resolve) => (finish = resolve)));
    const a = cachedEdgeStatus(MG, EDGES, read, roomy());
    const b = cachedEdgeStatus(MG, [...EDGES].reverse(), read, roomy());
    finish(ONE_OFF);
    const [x, y] = await Promise.all([a, b]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(x).toEqual(y);
    expect(x).toMatchObject({ state: "read", offline: 1 });
  });

  it("times out a read at its own limit, aborting its signal, even when it ignores it, and keeps that as a failure", async () => {
    let signal: AbortSignal | undefined;
    const read = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<EdgeStatusRead>(() => {});
    });
    const pending = cachedEdgeStatus(MG, EDGES, read, roomy());
    await vi.advanceTimersByTimeAsync(EDGE_STATUS_READ_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ state: "failed", readAt: Date.now() });
    expect(signal?.aborted).toBe(true);
    await cachedEdgeStatus(MG, EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("starts no read once the deadline has passed, and remembers nothing for it", async () => {
    const read = answering(ONE_OFF);
    expect(await cachedEdgeStatus(MG, EDGES, read, { deadlineMs: Date.now(), now })).toEqual({ state: "late" });
    expect(read).not.toHaveBeenCalled();
    expect(lastReadAt(MG, EDGES)).toBeNull();
    expect(await cachedEdgeStatus(MG, EDGES, read, { deadlineMs: Date.now() + 1, now })).toMatchObject({ state: "read" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers late when its own read outlives the deadline, and serves that read's answer to the next caller", async () => {
    const read = vi.fn(() => new Promise<EdgeStatusRead>((resolve) => setTimeout(() => resolve(ONE_OFF), 1_500)));
    const pending = cachedEdgeStatus(MG, EDGES, read, { deadlineMs: Date.now() + 500, now });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ state: "late" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lastReadAt(MG, EDGES)).toBe(Date.now());
    expect(await cachedEdgeStatus(MG, EDGES, read, { deadlineMs: Date.now(), now })).toMatchObject({ state: "read", offline: 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it(`runs at most ${EDGE_STATUS_CONCURRENCY} reads at once, starts the next in order as one ends, and drops one still waiting at its deadline`, async () => {
    const finishes: (() => void)[] = [];
    const started: string[] = [];
    const reading = (id: string) => () =>
      new Promise<EdgeStatusRead>((resolve) => {
        started.push(id);
        finishes.push(() => resolve(ONE_OFF));
      });
    const ids = Array.from({ length: EDGE_STATUS_CONCURRENCY + 2 }, (_, i) => `mg-${i}`);
    const answers = ids.map((id, i) =>
      // The last waits only 100 ms for a slot.
      cachedEdgeStatus(id, EDGES, reading(id), i === ids.length - 1 ? { deadlineMs: Date.now() + 100, now } : roomy()),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(ids.slice(0, EDGE_STATUS_CONCURRENCY));
    await vi.advanceTimersByTimeAsync(100);
    expect(await answers[ids.length - 1]).toEqual({ state: "late" });
    finishes[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(ids.slice(0, EDGE_STATUS_CONCURRENCY + 1));
    finishes.slice(1).forEach((finish) => finish());
    await vi.advanceTimersByTimeAsync(0);
    expect(started).not.toContain(ids[ids.length - 1]);
    expect((await Promise.all(answers.slice(0, -1))).map((a) => a.state)).toEqual(Array(EDGE_STATUS_CONCURRENCY + 1).fill("read"));
    // Every slot is free again.
    const more = Array.from({ length: EDGE_STATUS_CONCURRENCY }, (_, i) => cachedEdgeStatus(`again-${i}`, EDGES, reading(`again-${i}`), roomy()));
    await vi.advanceTimersByTimeAsync(0);
    expect(started.filter((id) => id.startsWith("again-"))).toHaveLength(EDGE_STATUS_CONCURRENCY);
    finishes.splice(0).forEach((finish) => finish());
    await Promise.all(more);
  });

  it("tells when a microgrid's kept answer for these edges was read, fresh or not", async () => {
    expect(lastReadAt(MG, EDGES)).toBeNull();
    await cachedEdgeStatus(MG, EDGES, answering(ONE_OFF), roomy());
    const readAt = Date.now();
    vi.advanceTimersByTime(EDGE_STATUS_FRESH_MS * 2);
    expect(lastReadAt(MG, [...EDGES].reverse())).toBe(readAt);
    expect(lastReadAt(MG, ["edge0"])).toBeNull();
  });

  it("serves a fresh answer past the deadline, since it needs no read", async () => {
    const read = answering(ONE_OFF);
    await cachedEdgeStatus(MG, EDGES, read, roomy());
    expect(await cachedEdgeStatus(MG, EDGES, read, { deadlineMs: Date.now() - 1, now })).toMatchObject({ state: "read", offline: 1 });
  });

  it("stops waiting for another caller's read at its own deadline, and finds that read's answer later", async () => {
    let finish: (v: EdgeStatusRead) => void = () => {};
    const read = vi.fn(() => new Promise<EdgeStatusRead>((resolve) => (finish = resolve)));
    const first = cachedEdgeStatus(MG, EDGES, read, roomy());
    const second = cachedEdgeStatus(MG, EDGES, read, { deadlineMs: Date.now() + 500, now });
    await vi.advanceTimersByTimeAsync(500);
    expect(await second).toEqual({ state: "late" });
    finish(ONE_OFF);
    expect(await first).toMatchObject({ state: "read", offline: 1 });
    expect(await cachedEdgeStatus(MG, EDGES, read, roomy())).toMatchObject({ state: "read", offline: 1 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it(`keeps at most ${EDGE_STATUS_CACHE_MAX} entries, dropping the oldest read`, async () => {
    const read = answering(ONE_OFF);
    for (let i = 0; i <= EDGE_STATUS_CACHE_MAX; i++) await cachedEdgeStatus(`mg-${i}`, EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(EDGE_STATUS_CACHE_MAX + 1);
    await cachedEdgeStatus(`mg-${EDGE_STATUS_CACHE_MAX}`, EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(EDGE_STATUS_CACHE_MAX + 1);
    await cachedEdgeStatus("mg-0", EDGES, read, roomy());
    expect(read).toHaveBeenCalledTimes(EDGE_STATUS_CACHE_MAX + 2);
  });
});
