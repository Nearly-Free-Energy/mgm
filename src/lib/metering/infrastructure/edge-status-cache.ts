/**
 * The edge-status reads' caches, timeout, shared in-flight reads and
 * process-wide bound on reads at once (../edge-status.ts): one cache for
 * each microgrid's gateway status, one for its meters' recent history
 * (./meter-activity.ts), under the same rules and drawing on one pool of
 * slots. The `metering.edge-status` watcher runs on every load of the
 * signals, which each open interface polls every five minutes and on focus,
 * for every staff member of the organization, so the backend must be asked
 * about a microgrid far less often than that.
 *
 * Per process, like the tenant app's usage cache (../../tenant-app/usage-throttle.ts):
 * each instance starts empty and keeps its own entries, which costs a
 * backend read per instance, not correctness. Entries are keyed by
 * microgrid id and remember which edges (or meters) they asked about, so a
 * microgrid whose edges or meters changed is read again. Every caller has already read the
 * microgrid through its own row-level security in the same request (the
 * watcher's read, filtered to its organization) and composed the metering
 * capability, so an entry is only ever served to someone who may see that
 * microgrid; what is kept is counts, a time, and which of the edge and
 * component ids the caller passed in were online or quiet, never a
 * credential, a client or anything the backend said.
 *
 * A read that has started runs to its own timeout and its answer is kept,
 * even when the caller that started it stopped waiting at its deadline: the
 * next load finds it. A read waiting for a free slot when its caller's
 * deadline passes never starts and leaves nothing behind.
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
 * How long a failed or timed-out read is kept, and a read that answered only
 * in part (a meter read with a failed edge): long enough that a backend
 * that is down is not asked again on every poll, short enough that a fix
 * (a saved credential, a restarted backend) shows within a minute.
 */
export const EDGE_STATUS_FAILURE_MS = 60_000;
/**
 * How long one read may take. The watcher's budget is 3 s
 * (EDGE_STATUS_BUDGET_MS in ../surface/edge-status-signals.ts); the session
 * check, the composition and the microgrid read take some hundreds of
 * milliseconds before it, so a read that starts promptly answers within the
 * budget, and one that does not still answers into the cache. A backend
 * that has not answered a status question in 2 s is reported as not read,
 * which is what a person would want to know.
 */
export const EDGE_STATUS_READ_TIMEOUT_MS = 2_000;
/**
 * Backend reads under way at once in one process, status and meter reads
 * together, across every caller and organization, reads that outlived
 * their caller's deadline included, so polls that overlap never pile reads
 * up. Four: most microgrids share one OpenEMS backend, which four small
 * requests at a time do not strain. Even if every read took its full 2 s
 * timeout, four slots allow about 600 reads per five-minute cache period,
 * both reads of 300 microgrids; the largest organization the watcher reads
 * (500, EDGE_STATUS_MICROGRID_BOUND in ../surface/edge-status-signals.ts)
 * would then take two periods to go round, the stalest first, and answers
 * in tenths of a second allow far more.
 */
export const EDGE_STATUS_CONCURRENCY = 4;
/** Entries kept at most; the oldest read goes first. */
export const EDGE_STATUS_CACHE_MAX = 1_000;

/** What a status read found: each edge asked about, online or not, as the backend answered. */
export type EdgeStatusRead = readonly { edgeId: string; online: boolean }[];
/**
 * A status answer: counts of the edges asked about, and which of them were
 * online, kept so the meter answer can be counted over online edges only
 * (./openems-edge-status.ts). The ids are MGM's own `edges.openems_edge_id`
 * values the caller passed in, never one the backend named.
 */
export type EdgeStatusAnswer = Answer<{ total: number; offline: number; online: readonly string[] }>;

/** A meter as MGM stores it: its edge's OpenEMS id and its component id. */
export type MeterRef = { edgeId: string; componentId: string };
/**
 * What a meter read found (./meter-activity.ts): the meters asked about
 * with no recent reading, and the edges whose meters could not be read.
 */
export type MeterActivityRead = { quiet: readonly MeterRef[]; failedEdges: readonly string[] };
export type MeterActivityAnswer = Answer<MeterActivityRead>;

type Settled<A> = ({ state: "read"; readAt: number } & A) | { state: "failed"; readAt: number };
type Answer<A> = Settled<A> | { state: "late" };

// ── The process-wide bound ──────────────────────────────────────────────────

type Waiter = { grant(release: () => void): void };
let active = 0;
const waiters: Waiter[] = [];
/** Bumped by the test reset, so a read from before it releases nothing after it. */
let generation = 0;

function releaser(): () => void {
  const mine = generation;
  let done = false;
  return () => {
    if (done || mine !== generation) return;
    done = true;
    const next = waiters.shift();
    if (next) next.grant(releaser());
    else active--;
  };
}

/**
 * A slot for one read, or null if `deadlineMs` has passed: at once while one
 * is free (so the read starts in the same turn), otherwise a promise of one
 * in the order asked, or of null if the deadline passes first. The caller
 * calls the release once.
 */
function acquire(deadlineMs: number, now: () => number): (() => void) | null | Promise<(() => void) | null> {
  if (deadlineMs <= now()) return null;
  if (active < EDGE_STATUS_CONCURRENCY) {
    active++;
    return releaser();
  }
  return new Promise((resolve) => {
    const waiter: Waiter = {
      grant(release) {
        clearTimeout(timer);
        resolve(release);
      },
    };
    const timer = setTimeout(() => {
      const at = waiters.indexOf(waiter);
      if (at >= 0) waiters.splice(at, 1);
      resolve(null);
    }, deadlineMs - now());
    waiters.push(waiter);
  });
}

// ── Answers ─────────────────────────────────────────────────────────────────

/** The edges asked about, as one string: unique, non-empty and sorted. */
export function fingerprintOf(edgeIds: readonly string[]): string {
  return JSON.stringify([...new Set(edgeIds.filter((id) => id !== ""))].sort());
}

/** The meters asked about, as one string: unique and sorted, whatever their order. */
export function meterFingerprintOf(meters: readonly MeterRef[]): string {
  return JSON.stringify([...new Set(meters.map((m) => JSON.stringify([m.edgeId, m.componentId])))].sort());
}

/** Counts of the edges asked about, an edge the answer leaves out counting as offline. */
export function summarize(edgeIds: readonly string[], statuses: EdgeStatusRead): { total: number; offline: number } {
  const asked = [...new Set(edgeIds.filter((id) => id !== ""))];
  const online = new Set(statuses.filter((s) => s.online === true).map((s) => s.edgeId));
  return { total: asked.length, offline: asked.filter((id) => !online.has(id)).length };
}

/** The edges asked about that the answer says are online, each once, in the order asked. */
export function onlineOf(edgeIds: readonly string[], statuses: EdgeStatusRead): string[] {
  const online = new Set(statuses.filter((s) => s.online === true).map((s) => s.edgeId));
  return [...new Set(edgeIds.filter((id) => id !== "" && online.has(id)))];
}


/** Resolves to "late" at `deadlineMs`, at once when it has passed. */
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
async function readOnce<A extends object>(read: (signal: AbortSignal) => Promise<A>, now: () => number): Promise<Settled<A>> {
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
    return { ...result, state: "read", readAt: now() };
  } catch {
    return { state: "failed", readAt: now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One kind of read's answers, by microgrid id, oldest read first (a new read
 * of a microgrid moves it to the end), each remembering what it asked about
 * as a fingerprint; and the reads under way, which concurrent callers share.
 * An answer `partial` says is incomplete is kept only as long as a failure.
 * Every kind draws on the one pool of slots above.
 */
function createReadCache<A extends object>(partial: (answer: A) => boolean = () => false) {
  type Entry = { fingerprint: string; answer: Settled<A> };
  const keepFor = (answer: Settled<A>) => (answer.state === "read" && !partial(answer) ? EDGE_STATUS_FRESH_MS : EDGE_STATUS_FAILURE_MS);
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Settled<A>>>();

  function freshEntry(microgridId: string, fingerprint: string, nowMs: number): Settled<A> | null {
    const entry = cache.get(microgridId);
    return entry && entry.fingerprint === fingerprint && nowMs - entry.answer.readAt < keepFor(entry.answer) ? entry.answer : null;
  }

  function store(microgridId: string, entry: Entry) {
    cache.delete(microgridId);
    cache.set(microgridId, entry);
    while (cache.size > EDGE_STATUS_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /** Starts a read holding a slot: kept in flight until it settles, then stored, and the slot released. */
  function start(microgridId: string, fingerprint: string, key: string, read: (signal: AbortSignal) => Promise<A>, now: () => number, release: () => void) {
    const pending = readOnce(read, now).then((answer) => {
      store(microgridId, { fingerprint, answer });
      return answer;
    });
    inFlight.set(key, pending);
    void pending.finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
      release();
    });
    return pending;
  }

  return {
    /** When the kept answer for this fingerprint was read, fresh or not, or null when none is kept. */
    lastReadAt(microgridId: string, fingerprint: string): number | null {
      const entry = cache.get(microgridId);
      return entry && entry.fingerprint === fingerprint ? entry.answer.readAt : null;
    },

    /**
     * From the cache while the entry is fresh for this fingerprint; else from
     * the read already under way for it, if any; else from a new read, once
     * one of the process's EDGE_STATUS_CONCURRENCY slots is free. Past
     * `deadlineMs` the answer is "late": a read still waiting for a slot is
     * dropped, and one under way goes on and keeps its answer for the next
     * caller.
     */
    async get(
      microgridId: string,
      fingerprint: string,
      read: (signal: AbortSignal) => Promise<A>,
      o: { deadlineMs: number; now?: () => number },
    ): Promise<Answer<A>> {
      const now = o.now ?? Date.now;
      const fresh = freshEntry(microgridId, fingerprint, now());
      if (fresh) return fresh;

      const key = `${microgridId} ${fingerprint}`;
      let pending = inFlight.get(key);
      if (!pending) {
        const slot = acquire(o.deadlineMs, now);
        const release = slot instanceof Promise ? await slot : slot;
        if (!release) return { state: "late" };
        // After a wait, another caller may have read it, or started to, meanwhile.
        const meanwhile = slot instanceof Promise ? freshEntry(microgridId, fingerprint, now()) : null;
        if (meanwhile) {
          release();
          return meanwhile;
        }
        pending = inFlight.get(key);
        if (pending) release();
        else pending = start(microgridId, fingerprint, key, read, now, release);
      }
      const late = lateAt(o.deadlineMs, now);
      try {
        return await Promise.race([pending, late.promise]).then((r) => (r === "late" ? { state: "late" as const } : r));
      } finally {
        late.cancel();
      }
    },

    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}

const statusCache = createReadCache<{ total: number; offline: number; online: readonly string[] }>();
/** A meter read with a failed edge is kept as briefly as a failure, so the edge is asked again soon. */
const meterCache = createReadCache<MeterActivityRead>((answer) => answer.failedEdges.length > 0);

/**
 * When the microgrid's kept status answer for these edges was read, fresh or
 * not, or null when none is kept for them. The reader reads microgrids with
 * none first, then the stalest, so successive loads rotate through them all.
 */
export function lastReadAt(microgridId: string, edgeIds: readonly string[]): number | null {
  return statusCache.lastReadAt(microgridId, fingerprintOf(edgeIds));
}

/** A microgrid's edge status, through the cache (createReadCache's `get`). */
export function cachedEdgeStatus(
  microgridId: string,
  edgeIds: readonly string[],
  read: (signal: AbortSignal) => Promise<EdgeStatusRead>,
  o: { deadlineMs: number; now?: () => number },
): Promise<EdgeStatusAnswer> {
  return statusCache.get(
    microgridId,
    fingerprintOf(edgeIds),
    async (signal) => {
      const statuses = await read(signal);
      return { ...summarize(edgeIds, statuses), online: onlineOf(edgeIds, statuses) };
    },
    o,
  );
}

/**
 * Which of a microgrid's meters have no recent reading, through the cache,
 * keyed by the meters asked about, so a meter added or removed reads again.
 * Asked about every meter of the microgrid, online edge or not, so it runs
 * beside the status read rather than after it; the reader counts only the
 * meters of edges the status answer says are online.
 */
export function cachedMeterActivity(
  microgridId: string,
  meters: readonly MeterRef[],
  read: (signal: AbortSignal) => Promise<MeterActivityRead>,
  o: { deadlineMs: number; now?: () => number },
): Promise<MeterActivityAnswer> {
  return meterCache.get(microgridId, meterFingerprintOf(meters), read, o);
}

/** Empties the caches, forgets reads under way and frees every slot; for tests only. */
export function _resetEdgeStatusCacheForTests(): void {
  statusCache.clear();
  meterCache.clear();
  generation++;
  active = 0;
  waiters.splice(0);
}
