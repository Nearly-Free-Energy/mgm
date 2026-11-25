/**
 * The edge-status read's cache, timeout and shared in-flight reads
 * (../edge-status.ts). The `metering.edge-status` watcher runs on every load
 * of the signals, which each open interface polls every five minutes and on
 * focus, for every staff member of the organization, so the backend must be
 * asked about a microgrid far less often than that.
 *
 * Per process, like the tenant app's usage cache (../../tenant-app/usage-throttle.ts):
 * each instance starts empty and keeps its own entries, which costs a
 * backend read per instance, not correctness. Entries are keyed by
 * microgrid id and remember which edges they asked about, so a microgrid
 * whose edges changed is read again. Every caller has already read the
 * microgrid through its own row-level security in the same request (the
 * watcher's read, filtered to its organization) and composed the metering
 * capability, so an entry is only ever served to someone who may see that
 * microgrid; what is kept is two counts and a time, never a credential, a
 * client or anything the backend said.
 *
 * Nothing here knows OpenEMS: the read is passed in
 * (./openems-edge-status.ts builds it), so these rules are tested alone.
 */
import "server-only";

/**
 * How long an answer is served without asking again. Decided on #230 as
 * 5 to 10 minutes: a gateway that drops off shows within about this long
 * (plus the interface's own five-minute poll), which is soon enough for a
 * site that is visited, not monitored, and keeps the backend's load at one
 * read per microgrid per instance per period, however many people look.
 */
export const EDGE_STATUS_FRESH_MS = 5 * 60_000;
/**
 * How long a failed or timed-out read is kept: long enough that a backend
 * that is down is not asked again on every poll, short enough that a fix
 * (a saved credential, a restarted backend) shows within a minute.
 */
export const EDGE_STATUS_FAILURE_MS = 60_000;
/**
 * How long one read may take. The watcher's budget is 3 s
 * (EDGE_STATUS_BUDGET_MS in ../surface/edge-status-signals.ts); the session
 * check, the composition and the microgrid read take some hundreds of
 * milliseconds before it, so a read that started in time still finishes
 * within the budget. A backend that has not answered a status question in
 * 2 s is reported as not read, which is what a person would want to know.
 */
export const EDGE_STATUS_READ_TIMEOUT_MS = 2_000;
/** Entries kept at most; the oldest read goes first. */
export const EDGE_STATUS_CACHE_MAX = 1_000;

/** What a read found: each edge asked about, online or not, as the backend answered. */
export type EdgeStatusRead = readonly { edgeId: string; online: boolean }[];
export type EdgeStatusAnswer =
  | { state: "read"; total: number; offline: number; readAt: number }
  | { state: "failed"; readAt: number }
  | { state: "late" };

type Settled = Exclude<EdgeStatusAnswer, { state: "late" }>;
type Entry = { fingerprint: string; answer: Settled };

/** By microgrid id, oldest read first: a new read of a microgrid moves it to the end. */
const cache = new Map<string, Entry>();
/** By microgrid id and fingerprint: the read under way, which concurrent callers share. */
const inFlight = new Map<string, Promise<Settled>>();

/** The edges asked about, as one string: unique, non-empty and sorted. */
export function fingerprintOf(edgeIds: readonly string[]): string {
  return JSON.stringify([...new Set(edgeIds.filter((id) => id !== ""))].sort());
}

/** Counts of the edges asked about, an edge the answer leaves out counting as offline. */
export function summarize(edgeIds: readonly string[], statuses: EdgeStatusRead): { total: number; offline: number } {
  const asked = [...new Set(edgeIds.filter((id) => id !== ""))];
  const online = new Set(statuses.filter((s) => s.online === true).map((s) => s.edgeId));
  return { total: asked.length, offline: asked.filter((id) => !online.has(id)).length };
}

const keepFor = (answer: Settled) => (answer.state === "read" ? EDGE_STATUS_FRESH_MS : EDGE_STATUS_FAILURE_MS);

function store(microgridId: string, entry: Entry) {
  cache.delete(microgridId);
  cache.set(microgridId, entry);
  while (cache.size > EDGE_STATUS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Resolves to "late" at `deadlineMs`, or never when it is not in the future. */
function lateAt(deadlineMs: number, now: () => number): { promise: Promise<"late">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(0, deadlineMs - now()));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * One read with its own timeout: the signal passed to `read` aborts after
 * EDGE_STATUS_READ_TIMEOUT_MS, and the answer is "failed" then even if
 * `read` ignores the signal (a token or decrypt step before the request).
 * Whatever `read` throws is a failure; what it threw is not kept or passed on.
 */
async function readOnce(
  edgeIds: readonly string[],
  read: (signal: AbortSignal) => Promise<EdgeStatusRead>,
  now: () => number,
): Promise<Settled> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, EDGE_STATUS_READ_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([read(controller.signal), timedOut]);
    if (result === "timeout") return { state: "failed", readAt: now() };
    return { state: "read", ...summarize(edgeIds, result), readAt: now() };
  } catch {
    return { state: "failed", readAt: now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A microgrid's edge status, from the cache while its entry is fresh for
 * these edges; else from the read already under way for them, if any;
 * else from a new read, started only when it could time out by
 * `deadlineMs`. Waiting for someone else's read stops at `deadlineMs`.
 * Either way past the deadline the answer is "late", which is not kept.
 */
export async function cachedEdgeStatus(
  microgridId: string,
  edgeIds: readonly string[],
  read: (signal: AbortSignal) => Promise<EdgeStatusRead>,
  o: { deadlineMs: number; now?: () => number },
): Promise<EdgeStatusAnswer> {
  const now = o.now ?? Date.now;
  const fingerprint = fingerprintOf(edgeIds);
  const entry = cache.get(microgridId);
  if (entry && entry.fingerprint === fingerprint && now() - entry.answer.readAt < keepFor(entry.answer)) return entry.answer;

  const key = `${microgridId} ${fingerprint}`;
  let pending = inFlight.get(key);
  if (!pending) {
    if (o.deadlineMs - now() < EDGE_STATUS_READ_TIMEOUT_MS) return { state: "late" };
    pending = readOnce(edgeIds, read, now).then((answer) => {
      store(microgridId, { fingerprint, answer });
      return answer;
    });
    const started = pending;
    inFlight.set(key, started);
    void started.finally(() => {
      if (inFlight.get(key) === started) inFlight.delete(key);
    });
  }
  const late = lateAt(o.deadlineMs, now);
  try {
    return await Promise.race([pending, late.promise]).then((r) => (r === "late" ? { state: "late" as const } : r));
  } finally {
    late.cancel();
  }
}

/** Empties the cache and forgets reads under way; for tests only. */
export function _resetEdgeStatusCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
