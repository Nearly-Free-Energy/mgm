/**
 * The usage reads' cache and per-unit limit (RFC mgm#197 § 5): what is
 * served from memory, what is read, what is refused, and that no other
 * caller's keys can reset a unit's count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRateLimitStoreForTests, checkRateLimit } from "@/lib/rate-limit/in-memory";
import {
  _resetTenantUsageCacheForTests,
  readThrottled,
  USAGE_CACHE_MAX,
  USAGE_FRESH_MS,
  USAGE_KEEP_MS,
  USAGE_READS_PER_WINDOW,
  USAGE_WINDOW_MS,
} from "../usage-throttle";

const T0 = Date.parse("2026-11-18T09:00:00Z");

beforeEach(() => {
  _resetTenantUsageCacheForTests();
  _resetRateLimitStoreForTests();
});

/** A read that answers `value` (or fails), counting its calls. */
function reader<T>(value: T | "fail" | "throw") {
  const read = vi.fn(async () => {
    if (value === "throw") throw new Error("backend down");
    return value === "fail" ? ({ ok: false } as const) : ({ ok: true, value } as const);
  });
  return read;
}

describe("readThrottled", () => {
  it("pins the limits the RFC sets", () => {
    expect([USAGE_FRESH_MS, USAGE_KEEP_MS, USAGE_READS_PER_WINDOW, USAGE_WINDOW_MS]).toEqual([
      60_000,
      15 * 60_000,
      6,
      60_000,
    ]);
  });

  it("serves a read from memory for a minute, then reads again", async () => {
    const read = reader("figures");
    expect(await readThrottled("unit", "k", T0, read)).toEqual({ from: "backend", value: "figures", readAt: T0 });
    expect(await readThrottled("unit", "k", T0 + USAGE_FRESH_MS - 1, read)).toEqual({
      from: "cache",
      value: "figures",
      readAt: T0,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(await readThrottled("unit", "k", T0 + USAGE_FRESH_MS, read)).toEqual({
      from: "backend",
      value: "figures",
      readAt: T0 + USAGE_FRESH_MS,
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never caches a failed read, and counts it against the limit", async () => {
    for (const value of ["fail", "throw"] as const) {
      expect(await readThrottled("unit", value, T0, reader(value))).toEqual({ from: "failed" });
    }
    const read = reader("figures");
    expect(await readThrottled("unit", "fail", T0 + 1, read)).toMatchObject({ from: "backend" });
    // Three reads so far; three more are allowed.
    for (let i = 0; i < 3; i++) await readThrottled("unit", `other-${i}`, T0 + 2, reader("x"));
    expect(await readThrottled("unit", "last", T0 + 3, reader("x"))).toEqual({ from: "limited" });
  });

  it("keeps entries apart by unit and by key", async () => {
    await readThrottled("unit-a", "month|2026-11", T0, reader("a-nov"));
    await readThrottled("unit-a", "month|2026-10", T0, reader("a-oct"));
    await readThrottled("unit-b", "month|2026-11", T0, reader("b-nov"));
    const none = reader("unused");

    expect(await readThrottled("unit-a", "month|2026-11", T0 + 1, none)).toMatchObject({ value: "a-nov" });
    expect(await readThrottled("unit-a", "month|2026-10", T0 + 1, none)).toMatchObject({ value: "a-oct" });
    expect(await readThrottled("unit-b", "month|2026-11", T0 + 1, none)).toMatchObject({ value: "b-nov" });
    expect(none).not.toHaveBeenCalled();
  });

  it("refuses the seventh uncached read in a minute without reading, and reads again once the window passes", async () => {
    const read = reader("x");
    for (let i = 0; i < USAGE_READS_PER_WINDOW; i++) {
      expect(await readThrottled("unit", `k${i}`, T0 + i, read)).toMatchObject({ from: "backend" });
    }
    expect(await readThrottled("unit", "k6", T0 + 10_000, read)).toEqual({ from: "limited" });
    expect(read).toHaveBeenCalledTimes(USAGE_READS_PER_WINDOW);
    // Cache hits are not counted and still answer.
    expect(await readThrottled("unit", "k0", T0 + 20_000, read)).toMatchObject({ from: "cache" });
    // Refusals are not counted either: once the first read leaves the window,
    // one more read is allowed, however many were refused meanwhile.
    for (let i = 0; i < 5; i++) await readThrottled("unit", "k6", T0 + 30_000, read);
    expect(await readThrottled("unit", "k6", T0 + USAGE_WINDOW_MS + 1, read)).toMatchObject({ from: "backend" });
    expect(await readThrottled("unit", "k7", T0 + USAGE_WINDOW_MS + 1, read)).toEqual({ from: "limited" });
  });

  it("leaves another unit's reads alone when one is over its limit", async () => {
    for (let i = 0; i < USAGE_READS_PER_WINDOW; i++) await readThrottled("unit-a", `k${i}`, T0, reader("x"));
    expect(await readThrottled("unit-a", "k6", T0, reader("x"))).toEqual({ from: "limited" });
    expect(await readThrottled("unit-b", "k6", T0, reader("y"))).toEqual({ from: "backend", value: "y", readAt: T0 });
  });

  it("serves a kept read only when over the limit, with the read's own time, for up to 15 minutes", async () => {
    await readThrottled("unit", "today", T0, reader("early"));
    // Under the limit, a read older than a minute is read again, not kept.
    expect(await readThrottled("unit", "today", T0 + 2 * 60_000, reader("again"))).toMatchObject({
      from: "backend",
      value: "again",
    });

    const at = T0 + 10 * 60_000;
    for (let i = 0; i < USAGE_READS_PER_WINDOW; i++) await readThrottled("unit", `k${i}`, at, reader("x"));
    expect(await readThrottled("unit", "today", at + 1, reader("unused"))).toEqual({
      from: "stale",
      value: "again",
      readAt: T0 + 2 * 60_000,
    });

    // Older than 15 minutes, nothing is kept.
    const late = T0 + 2 * 60_000 + USAGE_KEEP_MS;
    for (let i = 0; i < USAGE_READS_PER_WINDOW; i++) await readThrottled("unit", `late${i}`, late, reader("x"));
    expect(await readThrottled("unit", "today", late, reader("unused"))).toEqual({ from: "limited" });
  });

  it("drops the oldest read once it holds USAGE_CACHE_MAX", async () => {
    // One read per unit, so no unit reaches its limit.
    for (let i = 0; i <= USAGE_CACHE_MAX; i++) await readThrottled(`unit-${i}`, "k", T0, reader(i));
    const read = reader("re-read");
    expect(await readThrottled("unit-1", "k", T0 + 1, read)).toMatchObject({ from: "cache", value: 1 });
    expect(await readThrottled(`unit-${USAGE_CACHE_MAX}`, "k", T0 + 1, read)).toMatchObject({ from: "cache" });
    expect(read).not.toHaveBeenCalled();
    expect(await readThrottled("unit-0", "k", T0 + 1, read)).toMatchObject({ from: "backend", value: "re-read" });
    // Storing it again dropped the next oldest.
    expect(await readThrottled("unit-1", "k", T0 + 2, read)).toMatchObject({ from: "backend" });
  });

  it("keeps a unit's count when other callers' keys fill the shared limiter", async () => {
    for (let i = 0; i < USAGE_READS_PER_WINDOW; i++) await readThrottled("unit", `k${i}`, Date.now(), reader("x"));
    // As a flood on the sign-in link would, from many addresses.
    for (let i = 0; i <= 10_000; i++) checkRateLimit(`sign-in-link:10.1.${i >> 8}.${i & 255}`, 10, 60_000);
    expect(await readThrottled("unit", "k6", Date.now(), reader("x"))).toEqual({ from: "limited" });
  });
});
