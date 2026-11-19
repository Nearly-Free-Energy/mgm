/**
 * usage-throttle.ts — the usage reads' short cache and per-unit limit (RFC
 * mgm#197 § 5, "Backend load and errors"): a tenant's page load reaches the
 * microgrid's metering backend with its stored credentials, so a refreshing
 * phone or a bot must not be able to hammer it.
 *
 * Per process, like the limiter: a cold function starts empty, which costs
 * one backend read, not correctness. Concurrent identical misses are not
 * coalesced; the limit bounds them.
 *
 * The limiter is this module's own (createRateLimiter), not the shared
 * `checkRateLimit` store: that store is capped and evicts its least recently
 * seen key, and the sign-in link, the pay link and bootstrap add one key per
 * client address with no session, so a flood from many addresses would
 * evict `tenant-usage:<id>` and reset that unit's count. Here the same
 * algorithm counts the same key in a store only tenant-usage keys reach, and
 * each is written only after composeTenantApp has authorized the unit, so it
 * holds at most one key per unit with tenant access in the process. If a key
 * that needs no session is ever put in this limiter, that isolation is gone.
 */
import "server-only";

import { createRateLimiter } from "@/lib/rate-limit/in-memory";

/** A read is served from memory, without asking the backend, for this long. */
export const USAGE_FRESH_MS = 60_000;
/** A read is kept this long only to answer a unit that is over its limit. */
export const USAGE_KEEP_MS = 15 * 60_000;
/** Uncached backend reads one unit may cause per window, in one process. */
export const USAGE_READS_PER_WINDOW = 6;
export const USAGE_WINDOW_MS = 60_000;
/** Entries kept at most; the oldest read goes first. */
export const USAGE_CACHE_MAX = 2_000;

const limiter = createRateLimiter({ maxKeys: 10_000 });

type CacheEntry = { value: unknown; readAt: number };

/** By `${tenantId}|${key}`, oldest read first: a new read of a key moves it to the end. */
const cache = new Map<string, CacheEntry>();

export type UsageReadOutcome<T> =
  /** `readAt` is when the backend was read, which a cache or stale hit puts before now. */
  | { from: "backend" | "cache" | "stale"; value: T; readAt: number }
  /** Over the limit, with no read kept. */
  | { from: "limited" }
  /** The read failed (or threw). */
  | { from: "failed" };

/**
 * One usage read for a unit, at most once per USAGE_FRESH_MS per key, and at
 * most USAGE_READS_PER_WINDOW uncached reads per unit per window through
 * this module's own limiter (`tenant-usage:${tenantId}`). Call only after
 * composeTenantApp has authorized the request: a hit answers without any
 * check of its own, and a revoked tenant, an ended session or a turned-off
 * tenant app gets no cached figure only because the composer refuses them
 * before this runs. A failed read is counted against the limit and never
 * cached.
 *
 * Order: a fresh entry → "cache"; over the limit → a kept entry (younger
 * than USAGE_KEEP_MS) as "stale", else "limited"; otherwise read → "backend"
 * (stored) or "failed".
 */
export async function readThrottled<T>(
  tenantId: string,
  key: string,
  nowMs: number,
  read: () => Promise<{ ok: true; value: T } | { ok: false }>
): Promise<UsageReadOutcome<T>> {
  const cacheKey = `${tenantId}|${key}`;
  let entry = cache.get(cacheKey);
  if (entry && nowMs - entry.readAt >= USAGE_KEEP_MS) {
    cache.delete(cacheKey);
    entry = undefined;
  }
  if (entry && nowMs - entry.readAt < USAGE_FRESH_MS) {
    return { from: "cache", value: entry.value as T, readAt: entry.readAt };
  }

  if (!limiter.check(`tenant-usage:${tenantId}`, USAGE_READS_PER_WINDOW, USAGE_WINDOW_MS, nowMs).ok) {
    if (entry) return { from: "stale", value: entry.value as T, readAt: entry.readAt };
    return { from: "limited" };
  }

  let result: { ok: true; value: T } | { ok: false };
  try {
    result = await read();
  } catch {
    result = { ok: false };
  }
  if (!result.ok) return { from: "failed" };

  cache.delete(cacheKey);
  cache.set(cacheKey, { value: result.value, readAt: nowMs });
  while (cache.size > USAGE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { from: "backend", value: result.value, readAt: nowMs };
}

/** Clears the cache and this module's limiter; for tests only. */
export function _resetTenantUsageCacheForTests(): void {
  cache.clear();
  limiter.reset();
}
