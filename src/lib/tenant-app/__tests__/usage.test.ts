/**
 * The tenant app's month and day of use (RFC mgm#197 § 5): which meters
 * count on which day, what each day or hour shows, the cache and the
 * per-unit limit as the tenant sees them, and the unit's time zone.
 *
 * The capability is the real one; the repository answers the links a test
 * gives it, half-open as the database does; the usage source is backed by
 * the real synthetic provider and its generator (an adapter that builds the
 * DeviceConfig a provider takes), with `nowMs` read from the test's clock, so
 * a meter's figures are the generator's and today is partial as a real
 * meter's. Tests that need a particular figure use a hand-written source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureMeteringProvider } from "@/lib/metering/fixture-provider";
import { generateDeviceEnergySeries } from "@/lib/metering/fixture/meter-energy";
import { addDaysToDateKey, localHourStarts, startOfDayInZone } from "@/lib/timezone/day-key";
import { TenantAppCapability } from "../capability";
import type {
  TenantAppRepository,
  TenantAppScope,
  TenantMeter,
  TenantUsageDay,
  TenantUsageMonth,
  TenantUsageSeriesRequest,
  TenantUsageSeriesResult,
  TenantUsageSource,
} from "../types";
import { datesOfMonth } from "../usage-calendar";
import { _resetTenantUsageCacheForTests, USAGE_FRESH_MS, USAGE_KEEP_MS } from "../usage-throttle";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MICROGRID = "00000000-0000-4000-8000-0000000000c1";
const UNIT_A = "00000000-0000-4000-8000-0000000000b1";
const UNIT_B = "00000000-0000-4000-8000-0000000000b2";
const KAMPALA = "Africa/Kampala";

/** Meter ids whose generated days are known (METER_FIXTURE_SEED, MICROGRID, Kampala). */
const M = "meter-m"; // no unreported hours in November 2026
const P = "meter-p";
const D = "meter-d";

const clock = { now: 0 };

beforeEach(() => {
  _resetTenantUsageCacheForTests();
  clock.now = Date.parse("2026-11-18T09:00:00Z");
});

function unitScope(tenantId: string, timezone = KAMPALA): TenantAppScope {
  return {
    tenantId,
    organizationId: ORG,
    userId: `user-${tenantId}`,
    unit: {
      tenantId,
      displayName: `Tenant of ${tenantId.slice(-2)}`,
      unitLabel: null,
      microgridId: MICROGRID,
      microgridName: "Synthetic site",
      timezone,
      currency: "UGX",
      organizationId: ORG,
    },
  };
}

function link(
  deviceId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  role: TenantMeter["role"] = "primary_consumption_meter"
): TenantMeter {
  return { deviceId, name: deviceId, deviceType: "consumption_meter", role, effectiveFrom, effectiveTo };
}

/** Answers the links that cover any day of [from, to), as the database's half-open read does. */
function repositoryOf(links: TenantMeter[] | (() => TenantMeter[]) | Error) {
  const listMeterAssignments = vi.fn(async (_tenantId: string, from: string, to: string) => {
    if (links instanceof Error) throw links;
    const all = typeof links === "function" ? links() : links;
    return all.filter((l) => l.effectiveFrom < to && (l.effectiveTo === null || l.effectiveTo > from));
  });
  const repo: TenantAppRepository = {
    listMetersInForce: async () => {
      throw new Error("the usage views read assignments over a range");
    },
    listMeterAssignments,
  };
  return { repo, listMeterAssignments };
}

/** The synthetic provider behind the source port, with `nowMs` from the test clock. */
function syntheticSource() {
  const provider = new FixtureMeteringProvider([], {
    energySeries: (request) => generateDeviceEnergySeries(request, { nowMs: clock.now }),
  });
  const requests: TenantUsageSeriesRequest[] = [];
  const source: TenantUsageSource = {
    async readSeries(request) {
      requests.push(request);
      const series = await provider.getDeviceEnergySeries({
        microgridId: MICROGRID,
        devices: request.deviceIds.map((id) => ({ id, edgeOpenemsId: "SYNTHETIC-EDGE-TEST", componentId: "meter1" })),
        startDate: request.startDate,
        endDate: request.endDate,
        resolution: request.resolution,
        timezone: request.timezone,
        nowMs: request.nowMs,
      });
      return { ok: true, series: { ...series, synthetic: provider.synthetic === true } };
    },
  };
  return { source, requests };
}

/** A source that answers `value(deviceId, bucket start)` for every bucket of the request. */
function fakeSource(value: (deviceId: string, start: number, date: string) => number | null) {
  const requests: TenantUsageSeriesRequest[] = [];
  const source: TenantUsageSource = {
    async readSeries(request) {
      requests.push(request);
      const buckets: { start: number; date: string }[] = [];
      for (let date = request.startDate; date <= request.endDate; date = addDaysToDateKey(date, 1)) {
        const starts =
          request.resolution === "day"
            ? [startOfDayInZone(date, request.timezone).getTime()]
            : localHourStarts(date, request.timezone);
        for (const start of starts) buckets.push({ start, date });
      }
      const kwh: Record<string, (number | null)[]> = {};
      for (const id of request.deviceIds) kwh[id] = buckets.map((b) => value(id, b.start, b.date));
      return { ok: true, series: { buckets: buckets.map((b) => b.start), kwh, synthetic: false } };
    },
  };
  return { source, requests };
}

function capabilityFor(
  tenantId: string,
  links: Parameters<typeof repositoryOf>[0],
  source: TenantUsageSource,
  options: { timezone?: string; active?: () => boolean } = {}
) {
  const { repo, listMeterAssignments } = repositoryOf(links);
  const capability = new TenantAppCapability(
    repo,
    unitScope(tenantId, options.timezone),
    options.active ?? (() => true),
    () => clock.now,
    source
  );
  return { capability, listMeterAssignments };
}

/** What the generator gives meter `id` for `date` (kWh), read at the test clock. */
function generatedDay(id: string, date: string, timezone = KAMPALA): number | null {
  return generateDeviceEnergySeries(
    { microgridId: MICROGRID, devices: [{ id, edgeOpenemsId: "SYNTHETIC-EDGE-TEST", componentId: "meter1" }], startDate: date, endDate: date, resolution: "day", timezone },
    { nowMs: clock.now }
  ).kwh[id][0];
}

function generatedHours(id: string, date: string, timezone = KAMPALA): (number | null)[] {
  return generateDeviceEnergySeries(
    { microgridId: MICROGRID, devices: [{ id, edgeOpenemsId: "SYNTHETIC-EDGE-TEST", componentId: "meter1" }], startDate: date, endDate: date, resolution: "hour", timezone },
    { nowMs: clock.now }
  ).kwh[id];
}

async function month(capability: TenantAppCapability, input?: { month?: string }): Promise<TenantUsageMonth> {
  const result = await capability.getUsageMonth(input);
  if (!result.ok) throw new Error(`getUsageMonth failed: ${result.code}`);
  return result.data;
}

async function day(capability: TenantAppCapability, input?: { date?: string }): Promise<TenantUsageDay> {
  const result = await capability.getUsageDay(input);
  if (!result.ok) throw new Error(`getUsageDay failed: ${result.code}`);
  return result.data;
}

const stateOf = (m: TenantUsageMonth, date: string) => m.days.find((d) => d.date === date)!;
const datesBetween = (from: string, to: string) => {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDaysToDateKey(date, 1)) dates.push(date);
  return dates;
};
const round = (kwh: number) => Math.round(kwh * 1000) / 1000;

describe("a meter moved from one unit to another mid-month (RFC mgm#197 § 5)", () => {
  // Meter M is unit A's from 1 October up to 15 November, and unit B's from 15 November.
  const linksA = [link(M, "2026-10-01", "2026-11-15")];
  const linksB = [link(M, "2026-11-15", null)];

  beforeEach(() => {
    // 12:00 on 25 November in Kampala.
    clock.now = Date.parse("2026-11-25T09:00:00Z");
  });

  it("shows each unit only its own days, and asks the source only for them", async () => {
    const a = syntheticSource();
    const b = syntheticSource();
    const monthA = await month(capabilityFor(UNIT_A, linksA, a.source).capability);
    const monthB = await month(capabilityFor(UNIT_B, linksB, b.source).capability);

    expect(monthA.month).toBe("2026-11");
    expect(monthA.days.map((d) => d.date)).toEqual(datesOfMonth("2026-11"));
    for (const date of datesBetween("2026-11-01", "2026-11-14")) {
      expect(stateOf(monthA, date)).toEqual({ date, state: "data", kwh: generatedDay(M, date) });
      expect(stateOf(monthB, date)).toEqual({ date, state: "no-meter", kwh: null });
    }
    for (const date of datesBetween("2026-11-15", "2026-11-24")) {
      expect(stateOf(monthA, date)).toEqual({ date, state: "no-meter", kwh: null });
      expect(stateOf(monthB, date)).toEqual({ date, state: "data", kwh: generatedDay(M, date) });
    }
    // Today: no meter for A; for B the sum so far.
    expect(stateOf(monthA, "2026-11-25")).toEqual({ date: "2026-11-25", state: "no-meter", kwh: null });
    const todayB = stateOf(monthB, "2026-11-25");
    expect(todayB).toEqual({ date: "2026-11-25", state: "partial", kwh: generatedDay(M, "2026-11-25") });
    expect(todayB.kwh).toBeGreaterThan(0);
    for (const date of datesBetween("2026-11-26", "2026-11-30")) {
      expect(stateOf(monthA, date).state).toBe("future");
      expect(stateOf(monthB, date).state).toBe("future");
    }
    // No day has a figure in both calendars.
    for (const date of datesOfMonth("2026-11")) {
      expect(stateOf(monthA, date).kwh !== null && stateOf(monthB, date).kwh !== null).toBe(false);
    }

    // Each read asks only for that unit's days, and nothing after today.
    expect(a.requests).toEqual([
      { deviceIds: [M], startDate: "2026-11-01", endDate: "2026-11-14", resolution: "day", timezone: KAMPALA, nowMs: clock.now },
    ]);
    expect(b.requests).toEqual([
      { deviceIds: [M], startDate: "2026-11-15", endDate: "2026-11-25", resolution: "day", timezone: KAMPALA, nowMs: clock.now },
    ]);

    expect(monthA.total).toEqual({
      kwh: round(datesBetween("2026-11-01", "2026-11-14").reduce((sum, date) => sum + generatedDay(M, date)!, 0)),
      withoutData: 0,
    });
    expect(monthB.read).toEqual({ readAt: clock.now, stale: false, synthetic: true, problem: null });
  });

  it("shows no data, without reading, for a day outside the unit's assignment", async () => {
    const a = syntheticSource();
    const b = syntheticSource();
    const dayA = await day(capabilityFor(UNIT_A, linksA, a.source).capability, { date: "2026-11-20" });
    const dayB = await day(capabilityFor(UNIT_B, linksB, b.source).capability, { date: "2026-11-10" });

    for (const shown of [dayA, dayB]) {
      expect(shown.meters).toBe(0);
      expect(shown.hours).toHaveLength(24);
      expect(shown.hours.every((h) => h.state === "no-meter" && h.kwh === null)).toBe(true);
      expect(shown.total).toEqual({ kwh: null, withoutData: 0 });
      expect(shown.read).toEqual({ readAt: null, stale: false, synthetic: false, problem: null });
    }
    expect(a.requests).toEqual([]);
    expect(b.requests).toEqual([]);
  });

  it("shows the hours of the first day of the new assignment", async () => {
    const b = syntheticSource();
    const shown = await day(capabilityFor(UNIT_B, linksB, b.source).capability, { date: "2026-11-15" });

    expect(b.requests).toEqual([
      { deviceIds: [M], startDate: "2026-11-15", endDate: "2026-11-15", resolution: "hour", timezone: KAMPALA, nowMs: clock.now },
    ]);
    const expected = generatedHours(M, "2026-11-15");
    expect(shown.hours.map((h) => h.start)).toEqual(localHourStarts("2026-11-15", KAMPALA));
    expect(shown.hours.map((h) => h.kwh)).toEqual(expected);
    expect(shown.hours.every((h) => h.state === "data")).toBe(true);
    expect(shown.total.kwh).toBe(generatedDay(M, "2026-11-15"));
    expect(shown.meters).toBe(1);
  });
});

describe("the sum across a unit's meters", () => {
  beforeEach(() => {
    clock.now = Date.parse("2026-11-18T09:00:00Z");
  });

  it("shows a day on which one meter had no value as no data, never the other meter's figure", async () => {
    const { source } = fakeSource((id, _start, date) => (id === "q" && date === "2026-10-07" ? null : id === "p" ? 1.5 : 0.25));
    const { capability } = capabilityFor(UNIT_A, [link("p", "2026-01-01", null), link("q", "2026-01-01", null)], source);
    const shown = await month(capability, { month: "2026-10" });

    expect(stateOf(shown, "2026-10-06")).toEqual({ date: "2026-10-06", state: "data", kwh: 1.75 });
    expect(stateOf(shown, "2026-10-07")).toEqual({ date: "2026-10-07", state: "no-data", kwh: null });
    // The other 30 days, with the one it leaves out.
    expect(shown.total).toEqual({ kwh: 52.5, withoutData: 1 });
  });

  it("blanks every day a meter whose whole series failed is in force, and leaves them out of the total", async () => {
    const { source } = fakeSource((id) => (id === "q" ? null : 1));
    const { capability } = capabilityFor(UNIT_A, [link("p", "2026-01-01", null), link("q", "2026-10-10", null)], source);
    const shown = await month(capability, { month: "2026-10" });

    for (const date of datesBetween("2026-10-01", "2026-10-09")) expect(stateOf(shown, date).state).toBe("data");
    for (const date of datesBetween("2026-10-10", "2026-10-31")) {
      expect(stateOf(shown, date)).toEqual({ date, state: "no-data", kwh: null });
    }
    expect(shown.total).toEqual({ kwh: 9, withoutData: 22 });
  });

  it("counts a device linked twice to one unit once", async () => {
    const { source, requests } = fakeSource(() => 2);
    const { capability } = capabilityFor(
      UNIT_A,
      [link("p", "2026-10-01", null), link("p", "2026-10-01", null, "secondary_meter")],
      source
    );
    const shown = await month(capability, { month: "2026-10" });

    expect(requests[0].deviceIds).toEqual(["p"]);
    expect(shown.days.every((d) => d.state === "data" && d.kwh === 2)).toBe(true);
    expect(shown.total).toEqual({ kwh: 62, withoutData: 0 });
  });

  it("counts a meter that is two units' primary for each, only on its own link's days, as billing bills each", async () => {
    clock.now = Date.parse("2026-12-05T09:00:00Z");
    // D is A's primary from 1 October, and B's from 10 November, when it
    // replaced B's meter P. (The repository returns primary links only:
    // usage.db.test.ts.)
    const monthA = await month(capabilityFor(UNIT_A, [link(D, "2026-10-01", null)], syntheticSource().source).capability, { month: "2026-11" });
    const monthB = await month(
      capabilityFor(UNIT_B, [link(P, "2026-10-01", "2026-11-10"), link(D, "2026-11-10", null)], syntheticSource().source).capability,
      { month: "2026-11" }
    );

    const expectBucket = (shown: TenantUsageMonth, date: string, kwh: number | null) =>
      expect(stateOf(shown, date)).toEqual({ date, state: kwh === null ? "no-data" : "data", kwh });
    for (const date of datesOfMonth("2026-11")) {
      expectBucket(monthA, date, generatedDay(D, date));
      expectBucket(monthB, date, date < "2026-11-10" ? generatedDay(P, date) : generatedDay(D, date));
    }
    // A day on which D did not report is no data for both units from the 10th.
    expect(generatedDay(D, "2026-11-19")).toBeNull();
    expect(stateOf(monthA, "2026-11-19").state).toBe("no-data");
    expect(stateOf(monthB, "2026-11-19").state).toBe("no-data");
  });
});

describe("states from the read time", () => {
  /** 2026-11-18 in Kampala (UTC+3), at local `hh:mm:ss`. */
  const kampala = (time: string) => Date.parse(`2026-11-18T${time}+03:00`);
  const hours = localHourStarts("2026-11-18", KAMPALA);

  it("keeps the hour that held the read partial when the read is served after it ended", async () => {
    clock.now = kampala("13:59:30");
    const { source, requests } = syntheticSource();
    const { capability } = capabilityFor(UNIT_A, [link(M, "2026-11-01", null)], source);
    const read = await day(capability);
    const figures = generatedHours(M, "2026-11-18");

    clock.now = kampala("14:00:10");
    const served = await day(capability);

    expect(requests).toHaveLength(1);
    expect(served.read).toEqual({ readAt: kampala("13:59:30"), stale: false, synthetic: true, problem: null });
    expect(served.hours[13]).toEqual({ start: hours[13], state: "partial", kwh: figures[13] });
    expect(figures[13]).toBeGreaterThan(0);
    expect(served.hours[14]).toEqual({ start: hours[14], state: "partial", kwh: null });
    expect(served.hours.slice(15).every((h) => h.state === "future")).toBe(true);
    expect(served.hours.slice(0, 13).map((h) => h.state)).toEqual(Array(13).fill("data"));
    expect(served.total).toEqual({
      kwh: round(figures.slice(0, 14).reduce((sum: number, v) => sum + v!, 0)),
      withoutData: 0,
    });
    // As first read: hour 13 partial, 14 not begun yet.
    expect(read.hours[13].state).toBe("partial");
    expect(read.hours[14].state).toBe("future");
  });

  it("serves a kept read to a unit over its limit with that read's time, the hour it held still partial", async () => {
    clock.now = kampala("14:50:00");
    const { source, requests } = syntheticSource();
    const { capability } = capabilityFor(UNIT_A, [link(M, "2026-11-01", null)], source);
    await day(capability);
    const figures = generatedHours(M, "2026-11-18");

    // Six uncached reads in the minute before 15:02 use up the unit's limit.
    clock.now = kampala("15:01:30");
    for (const date of datesBetween("2026-11-11", "2026-11-16")) await day(capability, { date });
    expect(requests).toHaveLength(7);

    clock.now = kampala("15:02:00");
    const served = await day(capability);
    expect(requests).toHaveLength(7);
    expect(served.read).toEqual({ readAt: kampala("14:50:00"), stale: true, synthetic: true, problem: null });
    expect(served.hours[14]).toEqual({ start: hours[14], state: "partial", kwh: figures[14] });
    expect(figures[14]).toBeGreaterThan(0);
    expect(served.hours[15]).toEqual({ start: hours[15], state: "partial", kwh: null });
    expect(served.hours.slice(16).every((h) => h.state === "future")).toBe(true);
    expect(served.total.withoutData).toBe(0);
  });

  it("still shows a past hour that ended before the read with no value as no data", async () => {
    clock.now = kampala("15:30:00");
    const { source } = fakeSource((_id, start) => (start === hours[9] ? null : 0.1));
    const shown = await day(capabilityFor(UNIT_A, [link("p", "2026-11-01", null)], source).capability);

    expect(shown.hours[9]).toEqual({ start: hours[9], state: "no-data", kwh: null });
    expect(shown.hours[15]).toEqual({ start: hours[15], state: "partial", kwh: 0.1 });
    expect(shown.total).toEqual({ kwh: 1.5, withoutData: 1 });
  });

  it("never counts today, with or without a figure, as missing", async () => {
    clock.now = kampala("15:30:00");
    const withFigure = fakeSource(() => 1);
    const without = fakeSource((_id, _start, date) => (date === "2026-11-18" ? null : 1));
    const shownWith = await month(capabilityFor(UNIT_A, [link("p", "2026-11-01", null)], withFigure.source).capability);
    const shownWithout = await month(capabilityFor(UNIT_B, [link("p", "2026-11-01", null)], without.source).capability);

    expect(stateOf(shownWith, "2026-11-18")).toEqual({ date: "2026-11-18", state: "partial", kwh: 1 });
    expect(shownWith.total).toEqual({ kwh: 18, withoutData: 0 });
    expect(stateOf(shownWithout, "2026-11-18")).toEqual({ date: "2026-11-18", state: "partial", kwh: null });
    expect(shownWithout.total).toEqual({ kwh: 17, withoutData: 0 });
    // Nothing after today is asked for.
    expect(withFigure.requests[0]).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-18" });
  });

  it("has no total when no bucket has a figure yet", async () => {
    clock.now = kampala("00:20:00");
    const { source } = fakeSource(() => null);
    const shown = await day(capabilityFor(UNIT_A, [link("p", "2026-11-01", null)], source).capability);

    expect(shown.hours[0]).toEqual({ start: hours[0], state: "partial", kwh: null });
    expect(shown.total).toEqual({ kwh: null, withoutData: 0 });
  });
});

describe("the read's failures and limits as the tenant sees them", () => {
  it.each([
    ["unavailable", "unavailable"],
    ["metering-off", "not-offered"],
    ["unsupported", "not-offered"],
  ] as const)(
    "shows every past day with a meter as no data when the source answers %s, as problem %s",
    async (reason, problem) => {
      const source: TenantUsageSource = { readSeries: async () => ({ ok: false, reason }) };
      const shown = await month(capabilityFor(UNIT_A, [link("p", "2026-11-10", null)], source).capability);

      expect(shown.read).toEqual({ readAt: null, stale: false, synthetic: false, problem });
      for (const date of datesBetween("2026-11-01", "2026-11-09")) expect(stateOf(shown, date).state).toBe("no-meter");
      for (const date of datesBetween("2026-11-10", "2026-11-18")) {
        expect(stateOf(shown, date)).toEqual({ date, state: "no-data", kwh: null });
      }
      expect(shown.total).toEqual({ kwh: null, withoutData: 9 });
    }
  );

  it.each([["metering-off"], ["unsupported"]] as const)(
    "counts a %s answer against the limit and never caches it, as any failed read",
    async (reason) => {
      let answer: TenantUsageSeriesResult = { ok: false, reason };
      const readSeries = vi.fn(async () => answer);
      const { capability } = capabilityFor(UNIT_A, [link("p", "2026-11-01", null)], { readSeries });

      for (let i = 0; i < 6; i++) {
        expect((await day(capability, { date: "2026-11-17" })).read.problem).toBe("not-offered");
      }
      answer = { ok: true, series: { buckets: [], kwh: { p: [] }, synthetic: false } };
      expect((await day(capability, { date: "2026-11-17" })).read.problem).toBe("limited");
      expect(readSeries).toHaveBeenCalledTimes(6);
    }
  );

  it("shows an hour the source returned twice as no data, never either figure, and leaves it out of the total", async () => {
    const hours = localHourStarts("2026-11-17", KAMPALA);
    const source: TenantUsageSource = {
      async readSeries(): Promise<TenantUsageSeriesResult> {
        // 05:00 comes back twice, with two figures.
        const buckets = [...hours.slice(0, 6), hours[5], ...hours.slice(6)];
        const p = buckets.map((_, i) => (i === 6 ? 9 : 0.5));
        return { ok: true, series: { buckets, kwh: { p }, synthetic: false } };
      },
    };
    const shown = await day(capabilityFor(UNIT_A, [link("p", "2026-11-01", null)], source).capability, { date: "2026-11-17" });

    expect(shown.hours[5]).toEqual({ start: hours[5], state: "no-data", kwh: null });
    expect(shown.hours[4]).toEqual({ start: hours[4], state: "data", kwh: 0.5 });
    expect(shown.hours[6]).toEqual({ start: hours[6], state: "data", kwh: 0.5 });
    expect(shown.total).toEqual({ kwh: 11.5, withoutData: 1 });
  });

  it("shows no data when the source throws", async () => {
    const source: TenantUsageSource = {
      readSeries: async () => {
        throw new Error("connect ECONNREFUSED https://openems.example.test");
      },
    };
    const shown = await day(capabilityFor(UNIT_A, [link("p", "2026-11-01", null)], source).capability, { date: "2026-11-17" });

    expect(shown.read.problem).toBe("unavailable");
    expect(shown.hours.every((h) => h.state === "no-data" && h.kwh === null)).toBe(true);
    expect(shown.total).toEqual({ kwh: null, withoutData: 24 });
  });

  it("shows a source that returns fewer buckets as no data, never a figure on another day", async () => {
    const source: TenantUsageSource = {
      async readSeries(request): Promise<TenantUsageSeriesResult> {
        // Only the 2nd and 3rd of the month, at their own midnights.
        const buckets = ["2026-11-02", "2026-11-03"].map((date) => startOfDayInZone(date, request.timezone).getTime());
        return { ok: true, series: { buckets, kwh: { p: [2, 3] }, synthetic: false } };
      },
    };
    const shown = await month(capabilityFor(UNIT_A, [link("p", "2026-11-01", null)], source).capability, { month: "2026-11" });

    expect(stateOf(shown, "2026-11-01")).toEqual({ date: "2026-11-01", state: "no-data", kwh: null });
    expect(stateOf(shown, "2026-11-02")).toEqual({ date: "2026-11-02", state: "data", kwh: 2 });
    expect(stateOf(shown, "2026-11-03")).toEqual({ date: "2026-11-03", state: "data", kwh: 3 });
    expect(stateOf(shown, "2026-11-04").state).toBe("no-data");
  });

  it("reads six months a minute, refuses the seventh, serves a recent read from memory and reads again after the window", async () => {
    const { source, requests } = syntheticSource();
    const { capability } = capabilityFor(UNIT_A, [link(M, "2026-01-01", null)], source);
    const months = ["2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06"];

    for (const m of months) await month(capability, { month: m });
    expect(requests).toHaveLength(6);

    clock.now += 10_000;
    const limited = await month(capability, { month: "2026-05" });
    expect(requests).toHaveLength(6);
    expect(limited.read).toEqual({ readAt: null, stale: false, synthetic: false, problem: "limited" });
    expect(limited.days.every((d) => d.state === "no-data" && d.kwh === null)).toBe(true);
    expect(limited.total).toEqual({ kwh: null, withoutData: 31 });

    // A month read 30 s ago comes from memory, with no read and no count.
    clock.now += 20_000;
    const cached = await month(capability, { month: "2026-10" });
    expect(requests).toHaveLength(6);
    expect(cached.read).toMatchObject({ stale: false, problem: null, readAt: clock.now - 30_000 });
    expect(stateOf(cached, "2026-10-01").kwh).toBe(generatedDay(M, "2026-10-01"));

    // After the window, reads resume.
    clock.now += 31_000;
    const resumed = await month(capability, { month: "2026-05" });
    expect(requests).toHaveLength(7);
    expect(resumed.read.problem).toBeNull();
  });

  it("serves a kept month to a unit over its limit, marked stale with its own read time", async () => {
    const { source, requests } = syntheticSource();
    const { capability } = capabilityFor(UNIT_A, [link(M, "2026-01-01", null)], source);
    const readAt = clock.now;
    const first = await month(capability, { month: "2026-10" });

    clock.now += 5 * 60_000;
    for (const m of ["2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04"]) await month(capability, { month: m });
    const kept = await month(capability, { month: "2026-10" });

    expect(requests).toHaveLength(7);
    expect(kept.read).toEqual({ readAt, stale: true, synthetic: true, problem: null });
    expect(kept.days).toEqual(first.days);
    expect(kept.total).toEqual(first.total);
  });

  it("serves the last read, marked stale with its own read time, when a later read fails, until it is no longer kept", async () => {
    const { source: synthetic } = syntheticSource();
    let failing = false;
    const readSeries = vi.fn(
      async (request: TenantUsageSeriesRequest): Promise<TenantUsageSeriesResult> =>
        failing ? { ok: false, reason: "unavailable" } : synthetic.readSeries(request)
    );
    const { capability } = capabilityFor(UNIT_A, [link(M, "2026-01-01", null)], { readSeries });
    const readAt = clock.now;
    const first = await month(capability, { month: "2026-10" });

    // Past the fresh minute, the backend is asked again and fails (decided on mgm#210).
    failing = true;
    clock.now += USAGE_FRESH_MS;
    const kept = await month(capability, { month: "2026-10" });
    expect(kept.read).toEqual({ readAt, stale: true, synthetic: true, problem: null });
    expect(kept.days).toEqual(first.days);
    expect(kept.total).toEqual(first.total);

    // Once the read is no longer kept, the failure shows.
    clock.now = readAt + USAGE_KEEP_MS;
    const gone = await month(capability, { month: "2026-10" });
    expect(gone.read).toEqual({ readAt: null, stale: false, synthetic: false, problem: "unavailable" });
    expect(readSeries).toHaveBeenCalledTimes(3);
  });

  it.each([["metering-off"], ["unsupported"]] as const)(
    "serves no kept read once the source answers %s: another try reads the same",
    async (reason) => {
      const { source: synthetic } = syntheticSource();
      let answer: "figures" | typeof reason = "figures";
      const readSeries = vi.fn(
        async (request: TenantUsageSeriesRequest): Promise<TenantUsageSeriesResult> =>
          answer === "figures" ? synthetic.readSeries(request) : { ok: false, reason: answer }
      );
      const { capability } = capabilityFor(UNIT_A, [link(M, "2026-01-01", null)], { readSeries });
      await month(capability, { month: "2026-10" });

      answer = reason;
      clock.now += USAGE_FRESH_MS;
      const shown = await month(capability, { month: "2026-10" });
      expect(shown.read).toEqual({ readAt: null, stale: false, synthetic: false, problem: "not-offered" });
      expect(shown.days.every((d) => d.kwh === null)).toBe(true);
    }
  );

  it("reads again at once when a meter is linked or moved, whatever the cache holds", async () => {
    let links = [link("p", "2026-11-01", null)];
    const { source, requests } = fakeSource((id) => (id === "p" ? 1 : 2));
    const { capability } = capabilityFor(UNIT_A, () => links, source);
    await month(capability);
    links = [link("p", "2026-11-01", "2026-11-10"), link("q", "2026-11-10", null)];
    const moved = await month(capability);

    expect(requests).toHaveLength(2);
    expect(stateOf(moved, "2026-11-09").kwh).toBe(1);
    expect(stateOf(moved, "2026-11-10").kwh).toBe(2);
    // The unit's own reads are cached per view: a second load inside a minute reads nothing.
    clock.now += USAGE_FRESH_MS - 1;
    await month(capability);
    expect(requests).toHaveLength(2);
  });

  it("keeps one unit's limit and cache from another's", async () => {
    const { source, requests } = syntheticSource();
    const a = capabilityFor(UNIT_A, [link(M, "2026-01-01", null)], source).capability;
    const b = capabilityFor(UNIT_B, [link(M, "2026-01-01", null)], source).capability;
    for (const m of ["2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06"]) await month(a, { month: m });
    expect((await month(a, { month: "2026-05" })).read.problem).toBe("limited");

    const other = await month(b, { month: "2026-11" });
    expect(other.read.problem).toBeNull();
    expect(requests).toHaveLength(7);
  });
});

describe("the unit's time zone", () => {
  it("builds today and the default month in the unit's zone", async () => {
    clock.now = Date.parse("2026-11-30T21:30:00Z"); // 00:30 on 1 December in Kampala
    const { source } = fakeSource(() => 1);
    const { capability, listMeterAssignments } = capabilityFor(UNIT_A, [link("p", "2026-01-01", null)], source);
    const shown = await month(capability);

    expect(shown).toMatchObject({ month: "2026-12", today: "2026-12-01", previousMonth: "2026-11", nextMonth: null });
    expect(listMeterAssignments).toHaveBeenCalledWith(UNIT_A, "2026-12-01", "2027-01-01");
    expect(stateOf(shown, "2026-12-01").state).toBe("partial");
  });

  it("builds today west of UTC as the day before UTC's", async () => {
    clock.now = Date.parse("2026-11-01T06:30:00Z"); // 23:30 on 31 October in Los Angeles
    const { source, requests } = fakeSource(() => 1);
    const shown = await month(
      capabilityFor(UNIT_A, [link("p", "2026-01-01", null)], source, { timezone: "America/Los_Angeles" }).capability
    );

    expect(shown).toMatchObject({ month: "2026-10", today: "2026-10-31", timezone: "America/Los_Angeles" });
    expect(requests[0]).toMatchObject({ endDate: "2026-10-31", timezone: "America/Los_Angeles" });
  });

  it("gives a 25-hour day 25 hours, each with its own figure", async () => {
    clock.now = Date.parse("2026-11-03T15:00:00Z");
    const { source, requests } = syntheticSource();
    const shown = await day(
      capabilityFor(UNIT_A, [link(M, "2026-01-01", null)], source, { timezone: "America/New_York" }).capability,
      { date: "2026-11-01" }
    );

    expect(requests[0]).toMatchObject({ resolution: "hour", timezone: "America/New_York" });
    expect(shown.hours).toHaveLength(25);
    expect(shown.hours.map((h) => h.start)).toEqual(localHourStarts("2026-11-01", "America/New_York"));
    expect(shown.hours.map((h) => h.kwh)).toEqual(generatedHours(M, "2026-11-01", "America/New_York"));
  });

  it("gives a 23-hour day 23 hours", async () => {
    clock.now = Date.parse("2026-03-10T15:00:00Z");
    const { source } = fakeSource(() => 0.05);
    const shown = await day(
      capabilityFor(UNIT_A, [link("p", "2026-01-01", null)], source, { timezone: "America/New_York" }).capability,
      { date: "2026-03-08" }
    );

    expect(shown.hours).toHaveLength(23);
    expect(shown.total).toEqual({ kwh: 1.15, withoutData: 0 });
  });

  it("reads a stored zone that is not an IANA id as UTC, on both sides", async () => {
    clock.now = Date.parse("2026-11-18T22:30:00Z");
    const { source, requests } = fakeSource(() => 1);
    const shown = await day(capabilityFor(UNIT_A, [link("p", "2026-01-01", null)], source, { timezone: "Kampala" }).capability);

    expect(shown).toMatchObject({ timezone: "UTC", date: "2026-11-18", today: "2026-11-18" });
    expect(requests[0].timezone).toBe("UTC");
    expect(shown.hours[0].start).toBe(Date.parse("2026-11-18T00:00:00Z"));
  });
});

describe("which month and day are shown", () => {
  const months = () => {
    const { source } = fakeSource(() => 1);
    return capabilityFor(UNIT_A, [link("p", "2026-01-01", null)], source).capability;
  };

  it.each([
    [undefined, "2026-11"],
    ["", "2026-11"],
    ["2026-1", "2026-11"],
    ["2026-13", "2026-11"],
    ["2026-00", "2026-11"],
    ["1999-12", "2026-11"],
    ["2026-12", "2026-11"],
    ["2026-11-01", "2026-11"],
    ["2000-01", "2000-01"],
    ["2026-10", "2026-10"],
  ])("month %s reads as %s", async (requested, shown) => {
    expect((await month(months(), { month: requested })).month).toBe(shown);
  });

  it("names the months either side, with no next month for the current one", async () => {
    expect(await month(months(), { month: "2026-10" })).toMatchObject({ previousMonth: "2026-09", nextMonth: "2026-11" });
    expect(await month(months())).toMatchObject({ previousMonth: "2026-10", nextMonth: null });
    expect(await month(months(), { month: "2026-01" })).toMatchObject({ previousMonth: "2025-12", nextMonth: "2026-02" });
  });

  it.each([
    [undefined, "2026-11-18"],
    ["2026-11-19", "2026-11-18"],
    ["2026-02-30", "2026-11-18"],
    ["1999-12-31", "2026-11-18"],
    ["2026-11-1", "2026-11-18"],
    ["2000-01-01", "2000-01-01"],
    ["2026-11-17", "2026-11-17"],
  ])("date %s reads as %s", async (requested, shown) => {
    expect((await day(months(), { date: requested })).date).toBe(shown);
  });

  it("names the days either side, with no next day for today", async () => {
    expect(await day(months(), { date: "2026-11-01" })).toMatchObject({ previousDate: "2026-10-31", nextDate: "2026-11-02" });
    expect(await day(months())).toMatchObject({ previousDate: "2026-11-17", nextDate: null });
  });

  it("names the unit in the views, never its microgrid or meters", async () => {
    const shown = await month(months());
    expect(shown.tenant).toEqual({ id: UNIT_A, displayName: "Tenant of b1", unitLabel: null });
    expect(JSON.stringify(shown)).not.toContain(MICROGRID);
  });
});

describe("the calls' own failures", () => {
  it("answers 503 when the unit's meters cannot be read, and reads no usage", async () => {
    const { source, requests } = fakeSource(() => 1);
    const { capability } = capabilityFor(UNIT_A, new Error("statement timeout"), source);

    for (const result of [await capability.getUsageMonth(), await capability.getUsageDay()]) {
      expect(result).toEqual({
        ok: false,
        status: 503,
        code: "tenant_app_unavailable",
        message: "Could not read the unit's meters. Retry the request.",
      });
    }
    expect(requests).toEqual([]);
  });

  it("refuses once its composition is disposed, without reading", async () => {
    const { source, requests } = fakeSource(() => 1);
    const { capability, listMeterAssignments } = capabilityFor(UNIT_A, [link("p", "2026-01-01", null)], source, {
      active: () => false,
    });

    for (const result of [await capability.getUsageMonth(), await capability.getUsageDay()]) {
      expect(result).toMatchObject({ ok: false, status: 500, code: "tenant_app_composition_disposed" });
    }
    expect(listMeterAssignments).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
