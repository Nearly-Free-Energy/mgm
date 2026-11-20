import { describe, expect, it } from "vitest";
import { addDaysToDateKey, localHourStarts } from "@/lib/timezone/day-key";
import { MeteringError } from "../../errors";
import type { DeviceEnergySeriesRequest } from "../../types";
import {
  METER_FIXTURE_SEED,
  generateDeviceEnergySeries,
  syntheticMeterDay,
} from "../meter-energy";

const MICROGRID = "microgrid-synthetic";
const EDGE = "SYNTHETIC-EDGE-001";
const KAMPALA = "Africa/Kampala";
const meter = (id: string) => ({ id, edgeOpenemsId: EDGE, componentId: `meter-${id}` });

function request(overrides: Partial<DeviceEnergySeriesRequest> = {}): DeviceEnergySeriesRequest {
  return {
    microgridId: MICROGRID,
    devices: [meter("a")],
    startDate: "2026-11-02",
    endDate: "2026-11-04",
    resolution: "day",
    timezone: KAMPALA,
    ...overrides,
  };
}

const DATES = Array.from({ length: 365 }, (_, i) => addDaysToDateKey("2026-01-01", i));
const dayOf = (deviceId: string, date: string, timezone = KAMPALA) =>
  syntheticMeterDay(METER_FIXTURE_SEED, MICROGRID, deviceId, date, timezone);
const hasGap = (deviceId: string, date: string) => dayOf(deviceId, date).wh.includes(null);
const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** The first days of 2026 on which meter "a" did, and did not, report every hour. */
const GAP_DAY = DATES.find((date) => hasGap("a", date))!;
/** A day whose unreported block starts after its first hour. */
const LATE_GAP_DAY = DATES.find((date) => dayOf("a", date).wh.indexOf(null) > 0)!;
const WHOLE_DAYS = DATES.filter((date) => !hasGap("a", date));

describe("syntheticMeterDay", () => {
  it("gives the same hours for the same inputs, and others for another meter, day, microgrid or seed", () => {
    const day = dayOf("a", "2026-11-03");
    expect(dayOf("a", "2026-11-03")).toEqual(day);
    expect(dayOf("b", "2026-11-03").wh).not.toEqual(day.wh);
    expect(dayOf("a", "2026-11-04").wh).not.toEqual(day.wh);
    expect(syntheticMeterDay(METER_FIXTURE_SEED, "other", "a", "2026-11-03", KAMPALA).wh).not.toEqual(day.wh);
    expect(syntheticMeterDay("other-seed", MICROGRID, "a", "2026-11-03", KAMPALA).wh).not.toEqual(day.wh);
  });

  it("lays its hours on the local hours of the day", () => {
    expect(dayOf("a", "2026-11-03").starts).toEqual(localHourStarts("2026-11-03", KAMPALA));
    expect(dayOf("a", "2026-11-01", "America/New_York").wh).toHaveLength(25);
    expect(dayOf("a", "2026-03-08", "America/New_York").wh).toHaveLength(23);
  });

  it("counts whole Wh, between 0.6 and 4 kWh in a day that reported every hour", () => {
    for (const date of WHOLE_DAYS.slice(0, 60)) {
      const { wh } = dayOf("a", date);
      expect(wh.every((value) => Number.isInteger(value) && (value as number) >= 0)).toBe(true);
      // Each hour is rounded on its own, so the day may be off by a Wh per hour.
      expect(sum(wh)).toBeGreaterThanOrEqual(600 - 24);
      expect(sum(wh)).toBeLessThanOrEqual(4_000 + 24);
    }
  });

  it("uses more in the evening than in the small hours", () => {
    const evening = WHOLE_DAYS.slice(0, 30).map((date) => sum(dayOf("a", date).wh.slice(18, 22)));
    const night = WHOLE_DAYS.slice(0, 30).map((date) => sum(dayOf("a", date).wh.slice(1, 5)));
    expect(sum(evening)).toBeGreaterThan(2 * sum(night));
  });

  it("now and then leaves a block of three hours unreported, on about one day in fourteen", () => {
    const { wh } = dayOf("a", GAP_DAY);
    const missing = wh.flatMap((value, i) => (value === null ? [i] : []));
    expect(missing).toHaveLength(3);
    expect(missing[2] - missing[0]).toBe(2);

    const gapDays = ["a", "b", "c", "d"].flatMap((id) => DATES.filter((date) => hasGap(id, date)));
    expect(gapDays.length / (4 * DATES.length)).toBeGreaterThan(0.03);
    expect(gapDays.length / (4 * DATES.length)).toBeLessThan(0.12);
  });
});

describe("generateDeviceEnergySeries", () => {
  it("gives the same series for the same inputs", () => {
    expect(generateDeviceEnergySeries(request())).toEqual(generateDeviceEnergySeries(request()));
  });

  it("gives a meter the same figures whatever range and other meters are asked for", () => {
    const alone = generateDeviceEnergySeries(request({ startDate: "2026-11-03", endDate: "2026-11-03" }));
    const wide = generateDeviceEnergySeries(request({
      devices: [meter("b"), meter("a"), meter("c")],
      startDate: "2026-10-20",
      endDate: "2026-11-10",
    }));
    const index = wide.buckets.indexOf(alone.buckets[0]);
    expect(index).toBeGreaterThan(0);
    expect(wide.kwh.a[index]).toBe(alone.kwh.a[0]);

    const hours = generateDeviceEnergySeries(request({ resolution: "hour", startDate: "2026-11-03", endDate: "2026-11-03" }));
    const wideHours = generateDeviceEnergySeries(request({
      resolution: "hour",
      devices: [meter("c"), meter("a")],
      startDate: "2026-11-01",
      endDate: "2026-11-05",
    }));
    const from = wideHours.buckets.indexOf(hours.buckets[0]);
    expect(wideHours.kwh.a.slice(from, from + 24)).toEqual(hours.kwh.a);
  });

  it("has the axis of the request: local midnights per day, local hour starts per hour", () => {
    const days = generateDeviceEnergySeries(request());
    expect(days.buckets.map((ms) => new Date(ms).toISOString())).toEqual([
      "2026-11-01T21:00:00.000Z",
      "2026-11-02T21:00:00.000Z",
      "2026-11-03T21:00:00.000Z",
    ]);
    const hours = generateDeviceEnergySeries(request({ resolution: "hour" }));
    expect(hours.buckets).toEqual(
      ["2026-11-02", "2026-11-03", "2026-11-04"].flatMap((date) => localHourStarts(date, KAMPALA))
    );
    expect(hours.kwh.a).toHaveLength(72);
  });

  it("makes each day's hours sum to its day exactly, in Wh", () => {
    const dates = [WHOLE_DAYS[0], WHOLE_DAYS[1]];
    for (const date of dates) {
      const day = generateDeviceEnergySeries(request({ startDate: date, endDate: date }));
      const hours = generateDeviceEnergySeries(request({ resolution: "hour", startDate: date, endDate: date }));
      const hourWh = hours.kwh.a.map((kwh) => Math.round((kwh as number) * 1000));
      expect(Math.round((day.kwh.a[0] as number) * 1000)).toBe(sum(hourWh));
      expect(sum(dayOf("a", date).wh)).toBe(sum(hourWh));
    }
  });

  it("has no lead gap: the first hours of any range carry values on a day that reported", () => {
    for (const date of WHOLE_DAYS.slice(0, 20)) {
      const { kwh } = generateDeviceEnergySeries(request({ resolution: "hour", startDate: date, endDate: date }));
      expect(kwh.a[0]).not.toBeNull();
      expect(kwh.a[1]).not.toBeNull();
    }
  });

  it("gives null for the hours a day did not report, and for that day as a whole", () => {
    const hours = generateDeviceEnergySeries(request({ resolution: "hour", startDate: GAP_DAY, endDate: GAP_DAY }));
    expect(hours.kwh.a.filter((value) => value === null)).toHaveLength(3);
    const day = generateDeviceEnergySeries(request({ startDate: GAP_DAY, endDate: GAP_DAY }));
    expect(day.kwh.a).toEqual([null]);
  });

  it("gives 25 hours on a fall-back day and 23 on a spring-forward day", () => {
    const zone = { timezone: "America/New_York", resolution: "hour" as const };
    expect(generateDeviceEnergySeries(request({ ...zone, startDate: "2026-11-01", endDate: "2026-11-01" })).kwh.a)
      .toHaveLength(25);
    expect(generateDeviceEnergySeries(request({ ...zone, startDate: "2026-03-08", endDate: "2026-03-08" })).kwh.a)
      .toHaveLength(23);
  });

  describe("with nowMs", () => {
    const date = WHOLE_DAYS.find((day) => day > "2026-06-01")!;
    const hourStarts = localHourStarts(date, KAMPALA);
    // Half past 14:00 local time.
    const nowMs = hourStarts[14] + 30 * 60_000;
    const whole = dayOf("a", date).wh as number[];

    it("leaves the hours from now on null and counts the hour holding now only up to now", () => {
      const { kwh } = generateDeviceEnergySeries(
        request({ resolution: "hour", startDate: date, endDate: addDaysToDateKey(date, 1) }),
        { nowMs }
      );
      const wh = kwh.a.map((value) => (value === null ? null : Math.round(value * 1000)));
      expect(wh.slice(0, 14)).toEqual(whole.slice(0, 14));
      expect(wh[14]).toBe(Math.round(whole[14] / 2));
      expect(wh.slice(15).every((value) => value === null)).toBe(true);
    });

    it("makes today's day the sum so far and tomorrow null", () => {
      const { kwh } = generateDeviceEnergySeries(
        request({ startDate: addDaysToDateKey(date, -1), endDate: addDaysToDateKey(date, 1) }),
        { nowMs }
      );
      const yesterday = sum(dayOf("a", addDaysToDateKey(date, -1)).wh);
      expect(kwh.a[0] === null ? null : Math.round(kwh.a[0] * 1000)).toBe(
        hasGap("a", addDaysToDateKey(date, -1)) ? null : yesterday
      );
      expect(Math.round((kwh.a[1] as number) * 1000)).toBe(sum(whole.slice(0, 14)) + Math.round(whole[14] / 2));
      expect(kwh.a[2]).toBeNull();
    });

    it("does not count a block not yet reached as missing", () => {
      // A gap day read before its gap began reads as a partial day, not as no data.
      const { wh, starts } = dayOf("a", LATE_GAP_DAY);
      const firstMissing = wh.indexOf(null);
      expect(firstMissing).toBeGreaterThan(0);
      const { kwh } = generateDeviceEnergySeries(
        request({ startDate: LATE_GAP_DAY, endDate: LATE_GAP_DAY }),
        { nowMs: starts[firstMissing] }
      );
      expect(Math.round((kwh.a[0] as number) * 1000)).toBe(sum(wh.slice(0, firstMissing)));
      // Read once the block has begun, the day has no figure.
      const later = generateDeviceEnergySeries(
        request({ startDate: LATE_GAP_DAY, endDate: LATE_GAP_DAY }),
        { nowMs: starts[firstMissing] + 1 }
      );
      expect(later.kwh.a).toEqual([null]);
    });
  });

  it.each([
    ["an end before the start", { startDate: "2026-11-04", endDate: "2026-11-02" }],
    ["a month of hours", { resolution: "hour" as const, startDate: "2026-11-01", endDate: "2026-11-30" }],
  ])("refuses %s with 400, as the providers do", (_label, overrides) => {
    let error: unknown;
    try {
      generateDeviceEnergySeries(request(overrides));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ code: "METERING_INVALID_DATA", statusCode: 400 });
  });
});
