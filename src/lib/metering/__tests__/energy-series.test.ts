import { describe, expect, it } from "vitest";
import { ENERGY_SERIES_MAX_DAYS, energySeriesAxis } from "../energy-series";
import { MeteringError } from "../errors";
import type { DeviceEnergySeriesRequest } from "../types";

const HOUR = 3_600_000;

function request(overrides: Partial<DeviceEnergySeriesRequest> = {}): DeviceEnergySeriesRequest {
  return {
    microgridId: "microgrid-1",
    devices: [],
    startDate: "2026-11-05",
    endDate: "2026-11-05",
    resolution: "hour",
    timezone: "Africa/Kampala",
    ...overrides,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("energySeriesAxis, per day", () => {
  it("has one bucket per local day, at local midnight in the zone", () => {
    const axis = energySeriesAxis(request({ resolution: "day", startDate: "2026-11-01", endDate: "2026-11-03" }));
    expect(axis.buckets.map(iso)).toEqual([
      "2026-10-31T21:00:00.000Z",
      "2026-11-01T21:00:00.000Z",
      "2026-11-02T21:00:00.000Z",
    ]);
  });

  it("starts a day at its first instant in a zone with daylight saving", () => {
    const axis = energySeriesAxis(request({
      resolution: "day",
      timezone: "America/New_York",
      startDate: "2026-10-31",
      endDate: "2026-11-02",
    }));
    expect(axis.buckets.map(iso)).toEqual([
      "2026-10-31T04:00:00.000Z",
      "2026-11-01T04:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
    ]);
  });
});

describe("energySeriesAxis, per hour", () => {
  it("has the 24 local hour starts of a Kampala day", () => {
    const axis = energySeriesAxis(request());
    expect(axis.buckets).toHaveLength(24);
    expect(iso(axis.buckets[0])).toBe("2026-11-04T21:00:00.000Z");
    expect(iso(axis.buckets[23])).toBe("2026-11-05T20:00:00.000Z");
  });

  it("concatenates the hours of each day in order", () => {
    const axis = energySeriesAxis(request({ startDate: "2026-11-05", endDate: "2026-11-06" }));
    expect(axis.buckets).toHaveLength(48);
    expect(axis.buckets.every((start, i) => start === axis.buckets[0] + i * HOUR)).toBe(true);
  });

  it("has the UTC hours of a UTC day", () => {
    const axis = energySeriesAxis(request({ timezone: "UTC" }));
    expect(iso(axis.buckets[0])).toBe("2026-11-05T00:00:00.000Z");
    expect(axis.buckets).toHaveLength(24);
  });

  it("has 25 hours on New York's fall-back day and 23 on its spring-forward day", () => {
    const fall = energySeriesAxis(request({ timezone: "America/New_York", startDate: "2026-11-01", endDate: "2026-11-01" }));
    expect(fall.buckets).toHaveLength(25);
    // The two 01:00 hours are distinct buckets.
    expect(fall.buckets[1]).toBe(Date.parse("2026-11-01T01:00:00-04:00"));
    expect(fall.buckets[2]).toBe(Date.parse("2026-11-01T01:00:00-05:00"));

    const spring = energySeriesAxis(request({ timezone: "America/New_York", startDate: "2026-03-08", endDate: "2026-03-08" }));
    expect(spring.buckets).toHaveLength(23);
    expect(spring.buckets[1]).toBe(Date.parse("2026-03-08T01:00:00-05:00"));
    expect(spring.buckets[2]).toBe(Date.parse("2026-03-08T03:00:00-04:00"));
  });
});

describe("energySeriesAxis refuses a request no provider should read", () => {
  it.each([
    ["a malformed start", { startDate: "2026-11-5" }],
    ["a date that does not exist", { startDate: "2026-02-30", endDate: "2026-03-01" }],
    ["a malformed end", { endDate: "tomorrow" }],
    ["an end before the start", { startDate: "2026-11-05", endDate: "2026-11-04" }],
    ["an unknown resolution", { resolution: "minute" as never }],
    ["an unknown zone", { timezone: "Mars/OlympusMons" }],
    ["an offset in place of a zone", { timezone: "UTC+3" }],
    ["more hours than a week", { startDate: "2026-11-01", endDate: "2026-11-08" }],
    ["more days than a month", { resolution: "day" as const, startDate: "2026-01-01", endDate: "2026-02-01" }],
  ])("with 400 METERING_INVALID_DATA for %s", (_label, overrides) => {
    const error = (() => {
      try {
        energySeriesAxis(request(overrides));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ code: "METERING_INVALID_DATA", statusCode: 400 });
  });

  it("accepts the longest range of each resolution", () => {
    expect(ENERGY_SERIES_MAX_DAYS).toEqual({ day: 31, hour: 7 });
    expect(energySeriesAxis(request({ startDate: "2026-11-01", endDate: "2026-11-07" })).buckets).toHaveLength(7 * 24);
    expect(
      energySeriesAxis(request({ resolution: "day", startDate: "2026-01-01", endDate: "2026-01-31" })).buckets
    ).toHaveLength(31);
  });
});
