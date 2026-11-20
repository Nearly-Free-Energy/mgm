/**
 * in-memory.ts — Map-based per-instance rate limiter.
 *
 * `checkRateLimit` is the shared default limiter. Used by GET
 * /api/billing-line-items/[id]/pay (#202 / D16) to defend against scraping
 * of the public redirect endpoint (10 req/min/IP per Vercel instance), and
 * by the sign-in link, bootstrap and resend-invite routes.
 *
 * `createRateLimiter` gives a caller a limiter with its own store, so keys
 * another caller adds can never evict its keys. The default store is capped,
 * and the callers that need no session add one key per client address, so
 * a flood from many addresses evicts the least recently seen keys of every
 * caller that shares it. The tenant app's usage reads use their own
 * (src/lib/tenant-app/usage-throttle.ts).
 *
 * Scope caveat: this counter is per-Node-process, NOT cluster-wide. A
 * coordinated attacker spread across Vercel instances bypasses it. A future
 * ticket can swap in Upstash/Vercel KV when abuse signal appears; the call
 * sites only depend on the `checkRateLimit(...)` / `RateLimiter` contract.
 *
 * State: a `Map<key, number[]>` mapping key → array of recent hit timestamps
 * (ms epoch). Each call prunes timestamps older than `windowMs`. The data
 * structure is bounded by active-attacker count × `limit`; we additionally
 * cap the map size to prevent unbounded growth from per-IP bot fleets.
 */

const MAX_TRACKED_KEYS = 10_000;

type Entry = {
  // Recent hit timestamps (ms epoch), oldest first.
  hits: number[];
  // Last access time (for eviction once we hit the store's cap).
  lastSeen: number;
};

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until a fresh request would succeed; only set when `ok = false`. */
  retryAfter?: number;
}

export type RateLimiter = {
  /**
   * Apply a sliding-window rate limit to `key`.
   *
   *   - On allow: records the new hit, returns { ok: true }.
   *   - On deny:  does NOT record the hit (the hit is rejected, not throttled),
   *               returns { ok: false, retryAfter } where retryAfter is the
   *               number of whole seconds the client should wait.
   *
   * `nowMs` defaults to the clock; a caller that reads its own clock passes
   * it, so the window and the caller agree on the time.
   */
  check(key: string, limit: number, windowMs: number, nowMs?: number): RateLimitResult;
  /** For tests only. */
  reset(): void;
};

/**
 * A limiter with its own store, so another caller's keys can never evict its
 * keys. `maxKeys` caps the store; past it, the least recently seen key goes.
 */
export function createRateLimiter(options: { maxKeys?: number } = {}): RateLimiter {
  const maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS;
  const store: Map<string, Entry> = new Map();

  return {
    check(key, limit, windowMs, nowMs = Date.now()) {
      const now = nowMs;
      const cutoff = now - windowMs;

      let entry = store.get(key);
      if (!entry) {
        entry = { hits: [], lastSeen: now };
        store.set(key, entry);
      }

      // Prune anything older than the window. Hits are appended in order, so
      // we can stop on the first in-window timestamp.
      while (entry.hits.length > 0 && entry.hits[0] < cutoff) {
        entry.hits.shift();
      }

      if (entry.hits.length >= limit) {
        // Earliest in-window hit will leave the window at hits[0] + windowMs.
        const earliest = entry.hits[0]!;
        const retryAfterMs = earliest + windowMs - now;
        const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
        entry.lastSeen = now;
        return { ok: false, retryAfter };
      }

      entry.hits.push(now);
      entry.lastSeen = now;

      // Cap memory growth: if we're over the soft limit, evict the LRU entry.
      if (store.size > maxKeys) {
        let oldestKey: string | null = null;
        let oldestSeen = Infinity;
        for (const [k, v] of store) {
          if (v.lastSeen < oldestSeen) {
            oldestSeen = v.lastSeen;
            oldestKey = k;
          }
        }
        if (oldestKey) store.delete(oldestKey);
      }

      return { ok: true };
    },
    reset() {
      store.clear();
    },
  };
}

const DEFAULT_LIMITER = createRateLimiter({ maxKeys: MAX_TRACKED_KEYS });

/**
 * Apply a sliding-window rate limit to `key` in the shared default store.
 *
 *   - On allow: records the new hit, returns { ok: true }.
 *   - On deny:  does NOT record the hit (the hit is rejected, not throttled),
 *               returns { ok: false, retryAfter } where retryAfter is the
 *               number of whole seconds the client should wait.
 *
 * `limit` and `windowMs` are caller-supplied so the same helper serves
 * different routes if needed.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  return DEFAULT_LIMITER.check(key, limit, windowMs);
}

/**
 * Reset the default limiter — for tests only.
 */
export function _resetRateLimitStoreForTests(): void {
  DEFAULT_LIMITER.reset();
}
