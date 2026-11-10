// requested-day.test.ts — which day a day view shows for its ?date=, in the
// microgrid's zone, at day boundaries and across DST changes.

import { describe, expect, it } from "vitest";
import { resolveRequestedDay } from "../requested-day";

const KAMPALA = "Africa/Kampala";
// 22:30 UTC on 6 Nov is 01:30 on 7 Nov in Kampala (UTC+3).
const NOW = new Date("2026-11-06T22:30:00Z");
const resolve = (requested: string | readonly string[] | null | undefined, stored: string | null = KAMPALA, now: Date | number = NOW) =>
  resolveRequestedDay({ requested, stored, now });

describe("resolveRequestedDay", () => {
  it("defaults to yesterday in the microgrid's zone, not in UTC", () => {
    expect(resolve(undefined)).toEqual({ timezone: KAMPALA, today: "2026-11-07", date: "2026-11-06" });
    expect(resolve(null).date).toBe("2026-11-06");
    expect(resolve([]).date).toBe("2026-11-06");
  });

  it("shows a past day, and today itself, as asked", () => {
    expect(resolve("2026-10-15").date).toBe("2026-10-15");
    expect(resolve(["2026-10-15"]).date).toBe("2026-10-15");
    expect(resolve("2026-11-07").date).toBe("2026-11-07");
  });

  it.each([
    ["a future day", "2026-11-08"],
    ["a day far ahead", "2030-01-01"],
    ["a word", "yesterday"],
    ["a date with a time", "2026-11-01T00:00"],
    ["a short year", "26-11-01"],
    ["an empty string", ""],
    ["month 13", "2025-13-01"],
    ["30 February", "2026-02-30"],
  ])("falls back to yesterday for %s", (_label, requested) => {
    expect(resolve(requested).date).toBe("2026-11-06");
  });

  it("falls back to yesterday when ?date= is repeated, even with the same day twice", () => {
    expect(resolve(["2026-10-01", "2026-10-02"]).date).toBe("2026-11-06");
    expect(resolve(["2026-10-01", "2026-10-01"]).date).toBe("2026-11-06");
  });

  it("reads in UTC when the stored zone is missing or not supported", () => {
    for (const stored of ["Mars/Olympus", "UTC+3", "", null]) {
      expect(resolve(undefined, stored)).toEqual({ timezone: "UTC", today: "2026-11-06", date: "2026-11-05" });
    }
  });

  it("turns the day at local midnight, not UTC midnight", () => {
    expect(resolve(undefined, KAMPALA, Date.parse("2026-11-06T20:59:59Z")).today).toBe("2026-11-06");
    expect(resolve(undefined, KAMPALA, Date.parse("2026-11-06T21:00:00Z")).today).toBe("2026-11-07");
    // UTC+14 and UTC-11: the same instant is two different days.
    const instant = Date.parse("2026-11-06T10:30:00Z");
    expect(resolve(undefined, "Pacific/Kiritimati", instant).today).toBe("2026-11-07");
    expect(resolve(undefined, "Pacific/Pago_Pago", instant).today).toBe("2026-11-05");
    // Today in Kiritimati is a future day in Pago Pago.
    expect(resolve("2026-11-07", "Pacific/Pago_Pago", instant).date).toBe("2026-11-04");
  });

  it("turns the day at local midnight across DST changes", () => {
    const ny = "America/New_York";
    // Spring forward on 8 March 2026: midnight is still EST (UTC-5).
    expect(resolve(undefined, ny, Date.parse("2026-03-08T04:59:59Z")).today).toBe("2026-03-07");
    expect(resolve(undefined, ny, Date.parse("2026-03-08T05:00:00Z")).today).toBe("2026-03-08");
    // The next midnight is EDT (UTC-4).
    expect(resolve(undefined, ny, Date.parse("2026-03-09T03:59:59Z")).today).toBe("2026-03-08");
    expect(resolve(undefined, ny, Date.parse("2026-03-09T04:00:00Z"))).toEqual({
      timezone: ny,
      today: "2026-03-09",
      date: "2026-03-08",
    });
    // Fall back on 25 October 2026 in London: that day's midnight is BST, the next GMT.
    const london = "Europe/London";
    expect(resolve(undefined, london, Date.parse("2026-10-24T23:00:00Z")).today).toBe("2026-10-25");
    expect(resolve(undefined, london, Date.parse("2026-10-25T23:59:59Z")).today).toBe("2026-10-25");
    expect(resolve("2026-10-25", london, Date.parse("2026-10-25T23:59:59Z")).date).toBe("2026-10-25");
    expect(resolve(undefined, london, Date.parse("2026-10-26T00:00:00Z")).today).toBe("2026-10-26");
  });
});
