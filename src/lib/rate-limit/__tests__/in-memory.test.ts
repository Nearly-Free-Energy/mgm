/**
 * in-memory.test.ts — sliding-window rate limiter unit tests (#202 / D16).
 *
 * Covers the AC8 enumeration:
 *   - 11th call within 60s window → 429
 *   - 11th call after 60s window → 200 (TTL pruning works)
 *   - Two distinct IP keys do not interfere with each other's counters
 *   - A limiter from createRateLimiter keeps its own store
 *
 * Time control via vitest's fake timers so we don't actually sleep 60s.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  checkRateLimit,
  createRateLimiter,
  _resetRateLimitStoreForTests,
} from "../in-memory";

const LIMIT = 10;
const WINDOW_MS = 60_000;

describe("checkRateLimit", () => {
  beforeEach(() => {
    _resetRateLimitStoreForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first 10 calls in a 60s window", () => {
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects the 11th call within the 60s window with retryAfter set", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    const r = checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(r.retryAfter).toBeLessThanOrEqual(60);
  });

  it("allows an 11th call after the 60s window expires (TTL pruning works)", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    // Immediately blocked.
    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS).ok).toBe(false);

    // Advance past the window. The earliest hit was at t=0, so by t=61s it's
    // outside the 60s window.
    vi.advanceTimersByTime(WINDOW_MS + 1_000);

    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS).ok).toBe(true);
  });

  it("does not interfere across distinct keys", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS).ok).toBe(false);
    // Different IP — fresh budget.
    expect(checkRateLimit("5.6.7.8", LIMIT, WINDOW_MS).ok).toBe(true);
  });

  it("does not lengthen the wait when refused requests keep arriving, as Try again sends them", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    vi.advanceTimersByTime(30_000);
    // As many refusals as the limit, so the next allowed request would be
    // refused if any of them had been counted.
    for (let i = 0; i < LIMIT; i++) {
      expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS)).toEqual({ ok: false, retryAfter: 30 });
    }
    vi.advanceTimersByTime(29_000);
    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS)).toEqual({ ok: false, retryAfter: 1 });
    // The wait the first refusal gave has passed, despite the refusals since.
    vi.advanceTimersByTime(1_001);
    expect(checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS)).toEqual({ ok: true });
  });

  it.each([
    [500, 60],
    [59_999, 1],
    [WINDOW_MS, 1],
  ])("gives a whole number of seconds, at least 1, when refusing %i ms after the first hit", (elapsedMs, seconds) => {
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    }
    vi.advanceTimersByTime(elapsedMs);
    const r = checkRateLimit("1.2.3.4", LIMIT, WINDOW_MS);
    expect(r).toEqual({ ok: false, retryAfter: seconds });
    expect(Number.isInteger(r.retryAfter)).toBe(true);
  });
});

describe("createRateLimiter", () => {
  beforeEach(() => {
    _resetRateLimitStoreForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps its own keys: two limiters, and the default one, do not share a count", () => {
    const first = createRateLimiter();
    const second = createRateLimiter();
    for (let i = 0; i < 2; i++) expect(first.check("unit", 2, WINDOW_MS).ok).toBe(true);
    expect(first.check("unit", 2, WINDOW_MS).ok).toBe(false);
    expect(second.check("unit", 2, WINDOW_MS).ok).toBe(true);
    expect(checkRateLimit("unit", 2, WINDOW_MS).ok).toBe(true);
  });

  it("evicts none of its keys when the default store fills up", () => {
    const own = createRateLimiter();
    for (let i = 0; i < 2; i++) own.check("tenant-usage:unit", 2, WINDOW_MS);
    // As a flood on a route that needs no session would, from many addresses.
    for (let i = 0; i <= 10_000; i++) checkRateLimit(`sign-in-link:10.0.${i >> 8}.${i & 255}`, 10, WINDOW_MS);
    expect(own.check("tenant-usage:unit", 2, WINDOW_MS).ok).toBe(false);
  });

  it("evicts its own least recently seen key past maxKeys", () => {
    const own = createRateLimiter({ maxKeys: 2 });
    own.check("a", 1, WINDOW_MS);
    vi.advanceTimersByTime(1);
    own.check("b", 1, WINDOW_MS);
    vi.advanceTimersByTime(1);
    own.check("c", 1, WINDOW_MS);
    // "a" was evicted, so it has a fresh budget; "b" was not.
    expect(own.check("a", 1, WINDOW_MS).ok).toBe(true);
    expect(own.check("c", 1, WINDOW_MS).ok).toBe(false);
  });

  it("reads the time it is given, when given one", () => {
    const own = createRateLimiter();
    const t0 = Date.parse("2030-01-01T00:00:00Z");
    expect(own.check("k", 1, WINDOW_MS, t0).ok).toBe(true);
    expect(own.check("k", 1, WINDOW_MS, t0 + WINDOW_MS - 1)).toEqual({ ok: false, retryAfter: 1 });
    expect(own.check("k", 1, WINDOW_MS, t0 + WINDOW_MS + 1).ok).toBe(true);
  });

  it("forgets every key on reset", () => {
    const own = createRateLimiter();
    own.check("k", 1, WINDOW_MS);
    own.reset();
    expect(own.check("k", 1, WINDOW_MS).ok).toBe(true);
  });
});
