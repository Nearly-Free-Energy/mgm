/**
 * getDefaultDates: the previous calendar month in the microgrid's zone, which
 * the periods view's create action and the legacy periods list both start
 * their form with.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultDates } from "../default-dates";

describe("getDefaultDates — previous calendar month", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("names the microgrid's previous month in Africa/Kampala (UTC+3)", () => {
    // 00:30 on 1 November in Kampala is still 31 October in UTC.
    const now = new Date("2026-11-01T00:30:00+03:00");
    expect(getDefaultDates(now, "Africa/Kampala")).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
    });
  });

  it("names the microgrid's previous month in America/New_York (UTC-4)", () => {
    // 22:00 on 31 October in New York is already 1 November in UTC.
    const now = new Date("2026-10-31T22:00:00-04:00");
    expect(getDefaultDates(now, "America/New_York")).toEqual({
      start: "2026-09-01",
      end: "2026-09-30",
    });
  });

  it("rolls January back to December of the previous year in both zones", () => {
    const kampala = new Date("2026-01-01T00:30:00+03:00");
    expect(getDefaultDates(kampala, "Africa/Kampala")).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
    const newYork = new Date("2026-01-15T12:00:00-05:00");
    expect(getDefaultDates(newYork, "America/New_York")).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
    // 02:00 UTC on 1 January is still 31 December in New York.
    const newYorkEve = new Date("2026-01-01T02:00:00Z");
    expect(getDefaultDates(newYorkEve, "America/New_York")).toEqual({
      start: "2025-11-01",
      end: "2025-11-30",
    });
  });

  it("ends a leap-year February on the 29th", () => {
    const now = new Date("2028-03-10T12:00:00+03:00");
    expect(getDefaultDates(now, "Africa/Kampala")).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
  });

  it("uses the browser's local calendar when no timezone is given", () => {
    process.env.TZ = "Africa/Kampala";
    expect(getDefaultDates(new Date("2026-11-15T09:00:00+03:00"))).toEqual({
      start: "2026-10-01",
      end: "2026-10-31",
    });
    process.env.TZ = "America/New_York";
    expect(getDefaultDates(new Date("2026-01-15T09:00:00-05:00"))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  it("falls back to the local calendar when the timezone id is unknown", () => {
    process.env.TZ = "Africa/Kampala";
    expect(
      getDefaultDates(new Date("2026-11-15T09:00:00+03:00"), "Not/A_Zone"),
    ).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });
});
