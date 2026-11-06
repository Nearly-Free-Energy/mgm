// day-key.test.ts — tz-aware calendar-day keys (#359, anchor #353).

import { describe, it, expect } from "vitest";
import {
  dayKeyInZone,
  addDaysToDateKey,
  isCalendarDateKey,
  startOfDayInZone,
} from "../day-key";

describe("dayKeyInZone", () => {
  it("names the UTC day for the literal 'UTC' zone", () => {
    expect(dayKeyInZone(new Date("2026-03-09T21:00:00Z"), "UTC")).toBe(
      "2026-03-09",
    );
  });

  it("names the NEXT day east of UTC when the instant is past local midnight", () => {
    // 21:00Z is 00:00 in Kampala (UTC+3) — already 2026-03-10 there.
    expect(
      dayKeyInZone(new Date("2026-03-09T21:00:00Z"), "Africa/Kampala"),
    ).toBe("2026-03-10");
  });

  it("names the PREVIOUS day west of UTC before local midnight", () => {
    // 03:00Z on the 10th is 22:00/23:00 on the 9th in New York.
    expect(
      dayKeyInZone(new Date("2026-03-10T03:00:00Z"), "America/New_York"),
    ).toBe("2026-03-09");
  });

  it("accepts an epoch-ms number", () => {
    expect(dayKeyInZone(Date.UTC(2026, 2, 9, 21, 0, 0), "Africa/Kampala")).toBe(
      "2026-03-10",
    );
  });

  it("resolves DST from the IANA name (no fixed-offset math)", () => {
    // Europe/Berlin: UTC+1 in January, UTC+2 in July.
    expect(dayKeyInZone(new Date("2026-01-15T23:30:00Z"), "Europe/Berlin")).toBe(
      "2026-01-16",
    );
    expect(dayKeyInZone(new Date("2026-07-15T21:30:00Z"), "Europe/Berlin")).toBe(
      "2026-07-15",
    );
  });

  it("throws on an unknown zone id (callers own validation)", () => {
    expect(() => dayKeyInZone(new Date(), "Mars/OlympusMons")).toThrow(
      RangeError,
    );
  });
});

describe("addDaysToDateKey", () => {
  it("adds days across a month boundary", () => {
    expect(addDaysToDateKey("2026-03-30", 3)).toBe("2026-04-02");
  });

  it("subtracts days across a year boundary", () => {
    expect(addDaysToDateKey("2026-01-02", -3)).toBe("2025-12-30");
  });

  it("handles leap-year February", () => {
    expect(addDaysToDateKey("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("is pure calendar arithmetic — a 30-day axis is contiguous", () => {
    const dates: string[] = [];
    for (let i = 0; i < 30; i++) dates.push(addDaysToDateKey("2026-02-15", i));
    expect(dates[0]).toBe("2026-02-15");
    expect(dates[29]).toBe("2026-03-16");
    expect(new Set(dates).size).toBe(30);
  });
});

describe("startOfDayInZone", () => {
  it("is local midnight east of UTC", () => {
    // Midnight in Kampala (UTC+3) is 21:00 the previous day in UTC.
    expect(startOfDayInZone("2026-03-10", "Africa/Kampala").toISOString()).toBe(
      "2026-03-09T21:00:00.000Z",
    );
  });

  it("is UTC midnight for the literal 'UTC' zone", () => {
    expect(startOfDayInZone("2026-03-10", "UTC").toISOString()).toBe(
      "2026-03-10T00:00:00.000Z",
    );
  });

  it("follows daylight saving time west of UTC", () => {
    // New York is on EDT (UTC-4) in July.
    expect(startOfDayInZone("2026-07-01", "America/New_York").toISOString()).toBe(
      "2026-07-01T04:00:00.000Z",
    );
  });

  it("is the first instant of a day whose DST change skips midnight", () => {
    // Havana moves its clocks from 00:00 to 01:00 in March, so local midnight
    // does not exist that day. Checked as a property, not a fixed instant, so
    // a tz-data update cannot break it.
    for (const day of ["2026-03-08", "2026-03-09"]) {
      const start = startOfDayInZone(day, "America/Havana");
      expect(dayKeyInZone(start, "America/Havana")).toBe(day);
      expect(dayKeyInZone(start.getTime() - 1, "America/Havana") < day).toBe(true);
    }
  });

  it("throws on a malformed date key or an unknown zone id", () => {
    expect(() => startOfDayInZone("2026-13-45", "UTC")).toThrow(RangeError);
    expect(() => startOfDayInZone("2026-03-10", "Mars/OlympusMons")).toThrow(RangeError);
  });
});

describe("isCalendarDateKey", () => {
  it.each(["2026-01-01", "2026-11-06", "2026-12-31", "1999-06-30", "0100-03-01"])(
    "accepts the real day %s",
    (value) => {
      expect(isCalendarDateKey(value)).toBe(true);
    },
  );

  it.each(["2024-02-29", "2000-02-29", "2028-02-29"])(
    "accepts the leap day %s",
    (value) => {
      expect(isCalendarDateKey(value)).toBe(true);
    },
  );

  it.each([
    ["2026-02-29", "not a leap year"],
    ["1900-02-29", "century not divisible by 400"],
    ["2026-02-30", "February never has 30 days"],
    ["2026-04-31", "April has 30 days"],
    ["2026-01-32", "no month has 32 days"],
    ["2026-01-00", "day 00"],
    ["2026-13-01", "month 13"],
    ["2026-00-10", "month 00"],
  ])("rejects %s (%s)", (value) => {
    expect(isCalendarDateKey(value)).toBe(false);
  });

  it.each([
    "",
    "2026-1-05",
    "2026-01-5",
    "26-01-05",
    "20260105",
    "2026/01/05",
    "2026-01-05T00:00:00Z",
    " 2026-01-05",
    "2026-01-05 ",
    "2026-01-05\n",
    "+2026-01-05",
    "2026-0a-05",
    "１２３４-01-05",
  ])("rejects the wrong shape %j", (value) => {
    expect(isCalendarDateKey(value)).toBe(false);
  });
});
