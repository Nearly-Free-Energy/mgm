import { describe, expect, it } from "vitest";
import {
  BOUNDARY_GAP_DAY,
  DEMO_PERIOD,
  SYNTHETIC_METERS,
  type SyntheticMeter,
} from "../dataset";
import {
  DAILY_KWH_RANGE,
  DEFAULT_SYNTHETIC_SEED,
  MAX_SYNTHETIC_DAYS,
  dailyUsageWh,
  daysInRange,
  periodUsage,
  readingMissing,
} from "../generator";

const byProfile = (profile: string) =>
  SYNTHETIC_METERS.find((meter) => meter.profile === profile) as SyntheticMeter;
const { startDate, endDate } = DEMO_PERIOD;
const SEED = DEFAULT_SYNTHETIC_SEED;

describe("synthetic generator", () => {
  it("is deterministic: same inputs give identical output", () => {
    const run = () =>
      SYNTHETIC_METERS.map((meter) => periodUsage(SEED, meter, startDate, endDate));
    expect(run()).toEqual(run());
    const meter = byProfile("typical");
    expect(dailyUsageWh(SEED, meter, "2026-09-05")).toBe(dailyUsageWh(SEED, meter, "2026-09-05"));
  });

  it("depends on the seed and on the meter", () => {
    const meter = byProfile("typical");
    const a = periodUsage(SEED, meter, startDate, endDate).usageKwh;
    const b = periodUsage("another-seed", meter, startDate, endDate).usageKwh;
    expect(a).not.toBe(b);
    const [m1, m2] = SYNTHETIC_METERS.filter((m) => m.profile === "typical");
    expect(periodUsage(SEED, m1, startDate, endDate).usageKwh).not.toBe(
      periodUsage(SEED, m2, startDate, endDate).usageKwh
    );
  });

  it("keeps each day within its profile band (weekend uplift included)", () => {
    for (const meter of SYNTHETIC_METERS.filter((m) => m.profile !== "no-data")) {
      const [min, max] = DAILY_KWH_RANGE[meter.profile];
      for (const day of daysInRange(startDate, endDate)) {
        const kwh = dailyUsageWh(SEED, meter, day) / 1000;
        expect(kwh).toBeGreaterThanOrEqual(min - 0.001);
        expect(kwh).toBeLessThanOrEqual(max * 1.15 + 0.001);
      }
    }
  });

  it("period usage is the sum of its days, at 3 decimal places", () => {
    const meter = byProfile("typical");
    const days = daysInRange(startDate, endDate);
    const expectedWh = days.reduce((sum, d) => sum + dailyUsageWh(SEED, meter, d), 0);
    const { usageKwh } = periodUsage(SEED, meter, startDate, endDate);
    expect(usageKwh).toBe(expectedWh / 1000);
    expect(Number.isInteger(usageKwh! * 1000)).toBe(true);
    expect(usageKwh!).toBeGreaterThan(0);
  });

  it("sub-periods add up to the whole (no hidden state between days)", () => {
    const meter = byProfile("high");
    const first = periodUsage(SEED, meter, "2026-09-01", "2026-09-15").usageKwh!;
    const second = periodUsage(SEED, meter, "2026-09-16", "2026-09-30").usageKwh!;
    const whole = periodUsage(SEED, meter, startDate, endDate).usageKwh!;
    expect(Math.round((first + second) * 1000)).toBe(Math.round(whole * 1000));
  });

  it("interior gap still bills: the register counts through missing days", () => {
    const meter = byProfile("interior-gap");
    const result = periodUsage(SEED, meter, startDate, endDate);
    expect(result.missingDays).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
    expect(result.usageKwh).not.toBeNull();
    expect(result.usageKwh!).toBeGreaterThan(0);
  });

  it("a missing boundary reading is null, never zero", () => {
    const meter = byProfile("boundary-gap");
    expect(readingMissing(meter, BOUNDARY_GAP_DAY)).toBe(true);
    expect(periodUsage(SEED, meter, startDate, endDate).usageKwh).toBeNull();
    // The same meter is fine for a window that avoids the missing day.
    expect(periodUsage(SEED, meter, startDate, "2026-09-29").usageKwh).not.toBeNull();
  });

  it("a meter that never reported is null for every window", () => {
    const meter = byProfile("no-data");
    expect(periodUsage(SEED, meter, startDate, endDate).usageKwh).toBeNull();
    expect(periodUsage(SEED, meter, "2026-09-05", "2026-09-05").usageKwh).toBeNull();
  });

  it("handles single-day, month-boundary and leap-day windows", () => {
    const meter = byProfile("typical");
    expect(daysInRange("2026-09-05", "2026-09-05")).toEqual(["2026-09-05"]);
    expect(periodUsage(SEED, meter, "2026-09-05", "2026-09-05").usageKwh).toBe(
      dailyUsageWh(SEED, meter, "2026-09-05") / 1000
    );
    expect(daysInRange("2028-02-28", "2028-03-01")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("rejects malformed, impossible, reversed and oversized windows", () => {
    const meter = byProfile("typical");
    for (const [from, to] of [
      ["2026-9-01", "2026-09-30"],
      ["2026-02-30", "2026-03-01"],
      ["2026-09-30", "2026-09-01"],
      ["2026-01-01", "2027-12-31"],
    ]) {
      expect(() => periodUsage(SEED, meter, from, to)).toThrowError(
        expect.objectContaining({ code: "METERING_INVALID_DATA", statusCode: 400 })
      );
    }
    expect(daysInRange("2026-01-01", "2026-12-31")).toHaveLength(365);
    expect(() => daysInRange("2024-01-01", "2024-12-31")).not.toThrow();
    expect(MAX_SYNTHETIC_DAYS).toBe(366);
  });
});
