/**
 * The version test of SITE_DAY_CALC_VERSION (docs/investigation-evidence.md
 * §4 "Versions", §11 change 5): a digest of the calculated evidence over a
 * frozen corpus, pinned per version. A change to a figure's meaning or a
 * threshold moves the digest and fails here until the version is bumped
 * and the new version's digest added. An existing version's digest is
 * never edited: stored evidence cites it.
 *
 * The corpus is owned by this file. Its random generator and hash are
 * copied here, not imported, so a change elsewhere cannot move the digest;
 * its days are finished days in Africa/Kampala and UTC only, so neither
 * the clock nor a time-zone data update can move them. It has two parts:
 * - the builder part runs computeSiteDayDetail and buildSiteDaySnapshot on
 *   inputs this file supplies (sources, the meters asked for and the
 *   unreadable meters included);
 * - the capture part runs captureSiteDay with a stub repository and a stub
 *   provider, so the capability's own choices (the format check, which
 *   device of a type is read, the meters asked for) reach the digest too.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDaysToDateKey, startOfDayInZone } from "@/lib/timezone/day-key";
import type { DeviceConfig } from "@/lib/adapters/types";
import type { SiteSourceEvidence, UnreadableHouseMeter } from "../capability";
import { MeteringCapability } from "../capability";
import { MeteringRegistry } from "../registry";
import type { ManagedDevice, MeteringRepository } from "../repository";
import {
  SITE_DAY_PARAMS,
  buildSiteDaySnapshot,
  type SiteDayEvidence,
  type SiteDayZone,
} from "../site-day-evidence";
import {
  SITE_DAY_CALC_VERSION,
  computeSiteDayDetail,
  type SiteSourceAvailability,
} from "../site-operations";
import type { SiteSamples, SiteSamplesRequest } from "../types";

/**
 * The digest of the frozen corpus's calculated evidence, per calculation
 * version. Add the new version's digest when SITE_DAY_CALC_VERSION is
 * bumped; never edit an existing one.
 */
const CALC_DIGESTS: Readonly<Record<number, string>> = {
  1: "f91e5d6f067a105c637091d651404ef1b95262e5c0b3efc6bbb36ce995fadf38",
};

/** The thresholds of each version, so a changed threshold fails with a clearer message. */
const CALC_PARAMS: Readonly<Record<number, typeof SITE_DAY_PARAMS>> = {
  1: { gridMinV: 170, lowBatPct: 15, meterTolMin: 30, eveningStartH: 18, lagMin: 2 },
};

const FAILURE =
  "The site day's calculated figures changed for the frozen corpus. If intended, bump " +
  "SITE_DAY_CALC_VERSION (site-operations.ts) and add the new digest under the new version; never " +
  "edit an existing version's digest, which stored evidence cites.";

// ---------------------------------------------------------------------------
// Copied, not imported: a change to fixture/random.ts must not move the digest.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const MINUTE = 60_000;
const BIN_MS = 5 * MINUTE;
const ZONES = ["Africa/Kampala", "UTC"] as const;
const DATES = ["2026-01-15", "2026-03-29", "2026-06-15", "2026-09-04", "2026-10-25", "2026-11-10"];
const NOW = new Date("2026-11-25T00:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** What the digest covers: the thresholds and the items that are calculated or rest on an unavailable input. */
function calculatedView(s: SiteDayEvidence, withDevices: boolean) {
  const items = Object.entries(s.items).filter(([key, item]) => {
    const { c, reason } = item as { c: string; reason?: string };
    if (c === "calculated" || reason === "input_unavailable") return true;
    return withDevices && (key.startsWith("src_") || key.startsWith("m_"));
  });
  return { params: s.params, items: Object.fromEntries(items) };
}

// ---------------------------------------------------------------------------
// The builder part
// ---------------------------------------------------------------------------

type Available = { battery: boolean; grid: boolean; load: boolean; pv: boolean };

function sourcesFor(available: Available): SiteSourceEvidence {
  const of = (ok: boolean, n: number, component: string) =>
    ok ? { device: uuid(n), edge: "edge0", component } : { reason: "source_not_readable" as const };
  return {
    battery: of(available.battery, 1, "ess0"),
    grid_meter: of(available.grid, 2, "meter0"),
    inverter: of(available.load, 3, "inverter0"),
    pv_meter: of(available.pv, 4, "meter4"),
  };
}

/** The evidence document's §4 example, as a fixed first input. */
function exampleInput() {
  const dayStart = Date.parse("2026-11-09T21:00:00Z");
  const rows: [number, { v: number | null; soc: number | null; meters?: Record<string, number> }][] = [];
  rows.push([-1, { v: 231.4, soc: 14.8 }]);
  for (let p = 19; p <= 118; p++) rows.push([p, { v: 230, soc: 50 }]);
  rows.push([119, { v: 229.8, soc: 63 }]);
  for (let p = 129; p <= 226; p++) rows.push([p, { v: 231, soc: 60 }]);
  rows.push([227, { v: 0, soc: 58 }]);
  for (let p = 261; p <= 287; p++) rows.push([p, { v: 232, soc: 40 }]);
  const [d1, d2, d3] = [uuid(0xd1), uuid(0xd2), uuid(0xd3)];
  const meters: Record<number, Record<string, number>> = {
    214: { [d3]: 90412.5 },
    215: { [d1]: 48211, [d2]: 182340 },
    287: { [d1]: 48903.5, [d2]: 1200 },
  };
  const samples: SiteSamples = {
    timestamps: [], batterySocPct: [], batteryPowerW: [], gridPowerW: [], gridVoltageV: [], loadPowerW: [],
    pvPowerW: [], houseEnergyWh: { [d1]: [], [d2]: [], [d3]: [] },
  };
  for (const [pos, row] of rows) {
    samples.timestamps.push(dayStart + pos * BIN_MS);
    samples.batterySocPct.push(row.soc);
    samples.batteryPowerW.push(null);
    samples.gridPowerW.push(null);
    samples.gridVoltageV.push(row.v);
    samples.loadPowerW.push(300);
    samples.pvPowerW.push(null);
    for (const id of [d1, d2, d3]) samples.houseEnergyWh[id].push(meters[pos]?.[id] ?? null);
  }
  return builderSnapshot({
    date: "2026-11-10",
    zone: { tz: "Africa/Kampala", zone: "microgrid" },
    samples,
    available: { battery: true, grid: true, load: true, pv: false },
    meters: [d1, d2, d3],
    unreadable: [{ id: uuid(0xd4), reason: "tenant_meter_unreadable" }],
    nowMs: dayStart + 26 * 60 * MINUTE,
  });
}

function builderSnapshot(input: {
  date: string;
  zone: SiteDayZone;
  samples: SiteSamples;
  available: Available;
  meters: string[];
  unreadable: UnreadableHouseMeter[];
  nowMs: number;
}) {
  const sources: SiteSourceAvailability = {
    battery: input.available.battery,
    gridMeter: input.available.grid,
    load: input.available.load,
    pv: input.available.pv,
    houses: input.meters.length + input.unreadable.length > 0,
    houseMetersUnreadable: input.unreadable.length,
  };
  const { day, detail } = computeSiteDayDetail({
    date: input.date,
    timezone: input.zone.tz,
    samples: input.samples,
    sources,
    resolutionMinutes: 5,
    nowMs: input.nowMs,
    houseMeterIds: input.meters,
  });
  const houseMeters: DeviceConfig[] = input.meters.map((id, i) => ({ id, edgeOpenemsId: "edge0", componentId: `meter${i}` }));
  return buildSiteDaySnapshot({
    date: input.date,
    zone: input.zone,
    provider: "openems",
    day,
    detail,
    sources: sourcesFor(input.available),
    houseMeters,
    unreadableMeters: input.unreadable,
    unreadableTimestamps: input.samples.unreadableTimestamps ?? null,
  });
}

/** One random day: gaps, voltages either side of the threshold, SoC near the floor, meters that misbehave. */
function randomBuilderInput(seed: number) {
  const random = mulberry32(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const tz = pick(ZONES);
  const date = pick(DATES);
  const available: Available = {
    battery: random() < 0.8,
    grid: random() < 0.8,
    load: random() < 0.8,
    pv: random() < 0.5,
  };
  if (!available.battery && !available.grid) available.grid = true;
  const meters = Array.from({ length: Math.floor(random() * 4) }, (_, i) => uuid(seed * 16 + i));
  const held = meters.filter(() => random() < 0.85);
  const unreadable: UnreadableHouseMeter[] = [];
  for (let i = 0; i < Math.floor(random() * 3); i++) {
    unreadable.push({ id: uuid(seed * 16 + 8 + i), reason: random() < 0.5 ? "tenant_meter_unreadable" : "id_not_storable" });
  }
  const carryStart = startOfDayInZone(addDaysToDateKey(date, -1), tz).getTime();
  const dayStart = startOfDayInZone(date, tz).getTime();
  const dayEnd = startOfDayInZone(addDaysToDateKey(date, 1), tz).getTime();
  const samples: SiteSamples = {
    timestamps: [], batterySocPct: [], batteryPowerW: [], gridPowerW: [], gridVoltageV: [], loadPowerW: [],
    pvPowerW: [], houseEnergyWh: Object.fromEntries(held.map((id) => [id, []])),
  };
  const counters = held.map(() => 1000 + Math.floor(random() * 100_000));
  // A flat counter is counted at 0 kWh (evidence Q9), not left out as backwards.
  const steps = held.map(() => (random() < 0.3 ? 0 : 50));
  const gapChance = 0.02 + random() * 0.2;
  const maybe = (ok: boolean, chanceNull: number, draw: () => number) => (!ok || random() < chanceNull ? null : draw());
  let gapLeft = 0;
  // Some days have nothing before a first gap, so it is ruled out by no reading.
  const first = random() < 0.15 ? dayStart + Math.floor(1 + random() * 20) * BIN_MS : carryStart;
  for (let t = first; t < dayEnd; t += BIN_MS) {
    if (gapLeft > 0) {
      gapLeft--;
      continue;
    }
    if (random() < gapChance) {
      gapLeft = Math.floor(random() * 40);
      continue;
    }
    samples.timestamps.push(t);
    samples.batterySocPct.push(maybe(available.battery, 0.15, () => Math.round(random() * 400) / 10));
    samples.batteryPowerW.push(maybe(available.battery, 0.5, () => Math.round(random() * 2000 - 1000)));
    samples.gridPowerW.push(maybe(available.grid, 0.5, () => Math.round(random() * 3000 - 500)));
    samples.gridVoltageV.push(
      maybe(available.grid, 0.25, () => (random() < 0.3 ? Math.round(random() * 1690) / 10 : 170 + Math.round(random() * 700) / 10))
    );
    samples.loadPowerW.push(maybe(available.load, 0.5, () => Math.round(random() * 1500)));
    samples.pvPowerW.push(maybe(available.pv, 0.5, () => Math.round(random() * 3000)));
    held.forEach((id, i) => {
      if (random() < 0.02) counters[i] = Math.floor(random() * 1000);
      counters[i] += Math.round(random() * steps[i]);
      samples.houseEnergyWh[id].push(random() < 0.2 ? null : counters[i]);
    });
  }
  if (random() < 0.6) samples.unreadableTimestamps = Math.floor(random() * 20);
  // Finished, before 18:00, or before midnight within the lag.
  const end = random();
  const nowMs =
    end < 0.7
      ? dayEnd + 2 * MINUTE
      : end < 0.85
        ? dayStart + Math.floor(random() * 17 * 60) * MINUTE
        : dayEnd + Math.floor(random() * 2) * MINUTE;
  return builderSnapshot({
    date,
    zone: { tz, zone: tz === "UTC" && random() < 0.5 ? "fallback" : "microgrid" },
    samples,
    available,
    meters,
    unreadable,
    nowMs,
  });
}

/**
 * Fixed days the random ones may miss: a battery-less and a grid-less day
 * without a gap (rule Z stores no range item and the summary as computed),
 * a day whose grid meter gives no voltage at all (no known cut, so no
 * `cutMin`), and voltages exactly at GRID_PRESENT_MIN_V, carried in and
 * within the day, before a gap.
 */
function fixedBuilderInputs() {
  const date = "2026-11-10";
  const zone: SiteDayZone = { tz: "Africa/Kampala", zone: "microgrid" };
  const dayStart = startOfDayInZone(date, zone.tz).getTime();
  const nowMs = dayStart + 26 * 60 * MINUTE;
  type Bin = { v: number | null; soc: number | null } | null;
  const day = (available: Available, bin: (pos: number) => Bin) => {
    const samples: SiteSamples = {
      timestamps: [], batterySocPct: [], batteryPowerW: [], gridPowerW: [], gridVoltageV: [], loadPowerW: [],
      pvPowerW: [], houseEnergyWh: {},
    };
    for (let pos = -3; pos < 288; pos++) {
      const row = bin(pos);
      if (row === null) continue;
      samples.timestamps.push(dayStart + pos * BIN_MS);
      samples.batterySocPct.push(available.battery ? row.soc : null);
      samples.batteryPowerW.push(available.battery ? 100 : null);
      samples.gridPowerW.push(available.grid ? 250 : null);
      samples.gridVoltageV.push(available.grid ? row.v : null);
      samples.loadPowerW.push(available.load ? 300 : null);
      samples.pvPowerW.push(null);
    }
    return builderSnapshot({ date, zone, samples, available, meters: [], unreadable: [], nowMs });
  };
  const full = { battery: true, grid: true, load: true, pv: false };
  return [
    day({ ...full, battery: false }, () => ({ v: 230, soc: null })),
    day({ ...full, grid: false }, () => ({ v: null, soc: 60 })),
    day(full, () => ({ v: null, soc: 60 })),
    // Carried in at 170 V, then a gap at the start of the day; 170 V again before a gap at 150–169.
    day(full, (pos) =>
      pos >= 0 && pos < 12 ? null : pos >= 150 && pos < 170 ? null : { v: pos === -1 || pos === 149 ? 170 : 230, soc: 60 }
    ),
  ];
}

// ---------------------------------------------------------------------------
// The capture part
// ---------------------------------------------------------------------------

const ORG = uuid(0xa0);
const MICROGRID = uuid(0xa1);
const BAD_IDS = [" ess0", "ess/0", "e".repeat(65), ""];

/** Day `i`'s devices: a valid and an invalid device of most types, and tenant meters of every kind. */
function captureDevices(i: number): { devices: ManagedDevice[]; linked: string[] } {
  const device = (n: number, name: string, deviceType: string, componentId: string, edge = "edge0"): ManagedDevice => ({
    id: uuid(0x1000 + n),
    name,
    edgeId: "edge-1",
    deviceType,
    edgeOpenemsId: edge,
    componentId,
  });
  const bad = BAD_IDS[i % BAD_IDS.length];
  const devices: ManagedDevice[] = [
    // The invalid one sorts first, so only the format check passes it over.
    device(1, "A battery", "battery", bad),
    device(3, "A grid", "grid_meter", "meter0", i % 2 ? "edge 0" : ""),
    device(5, "Inverter", "inverter", "inverter0"),
    device(11, "Meter 1", "consumption_meter", "meter1"),
    device(12, "Meter 2", "consumption_meter", "meter2"),
    device(13, "Meter 3", "consumption_meter", "meter3", i % 3 ? "edge0" : "edge/0"),
    device(14, "Meter 4", "consumption_meter", i % 2 ? "meter 4" : ""),
  ];
  if (i % 5 !== 0) devices.push(device(2, "B battery", "battery", "ess1"));
  if (i % 5 === 0 || i % 7 !== 0) devices.push(device(4, "B grid", "grid_meter", "meter9"));
  if (i % 3 === 0) devices.push(device(6, "Solar", "pv_meter", "meter6"));
  // A second valid device of a type: the first by name is read, not added up.
  if (i % 3 === 1) devices.push(device(7, "C battery", "battery", "ess2"), device(8, "C grid", "grid_meter", "meter8"));
  return { devices, linked: [11, 12, 13, 14].map((n) => uuid(0x1000 + n)) };
}

/** Distinct samples per device: each series drawn from the device's own generator, seeded by day and device. */
function stubSamples(request: SiteSamplesRequest, omit: string | null): SiteSamples {
  const start = startOfDayInZone(request.startDate, request.timezone).getTime();
  const end = startOfDayInZone(addDaysToDateKey(request.endDate, 1), request.timezone).getTime();
  const of = (device: DeviceConfig | null) =>
    device ? mulberry32(fnv1a(`${request.endDate}|${device.id}`)) : null;
  const gaps = mulberry32(fnv1a(`${request.endDate}|gaps`));
  const [battery, grid, load, pv] = [of(request.sources.battery), of(request.sources.gridMeter), of(request.sources.load), of(request.sources.pv)];
  const meters = request.sources.houseMeters.filter((m) => m.id !== omit);
  const meterRandom = meters.map((m) => of(m)!);
  const counters = meterRandom.map((r) => 5000 + Math.floor(r() * 100_000));
  const samples: SiteSamples = {
    timestamps: [], batterySocPct: [], batteryPowerW: [], gridPowerW: [], gridVoltageV: [], loadPowerW: [],
    pvPowerW: [], houseEnergyWh: Object.fromEntries(meters.map((m) => [m.id, []])),
  };
  let soc = 30;
  let gapLeft = 0;
  for (let t = start; t < end; t += BIN_MS) {
    if (gapLeft > 0) {
      gapLeft--;
      continue;
    }
    if (gaps() < 0.03) {
      gapLeft = Math.floor(gaps() * 30);
      continue;
    }
    samples.timestamps.push(t);
    if (battery) soc = Math.max(5, Math.min(95, soc + (battery() - 0.52) * 4));
    samples.batterySocPct.push(battery ? Math.round(soc * 10) / 10 : null);
    samples.batteryPowerW.push(battery ? Math.round(battery() * 2000 - 1000) : null);
    samples.gridPowerW.push(grid ? Math.round(grid() * 3000 - 500) : null);
    samples.gridVoltageV.push(grid ? (grid() < 0.1 ? 0 : 200 + Math.round(grid() * 400) / 10) : null);
    samples.loadPowerW.push(load ? Math.round(load() * 1500) : null);
    samples.pvPowerW.push(pv ? Math.round(pv() * 3000) : null);
    meters.forEach((m, i) => {
      const r = meterRandom[i];
      if (r() < 0.01) counters[i] = Math.floor(r() * 1000);
      counters[i] += Math.round(r() * 40);
      samples.houseEnergyWh[m.id].push(r() < 0.1 ? null : counters[i]);
    });
  }
  return samples;
}

async function captureSnapshot(i: number): Promise<SiteDayEvidence> {
  const tz = ZONES[i % 2];
  const date = addDaysToDateKey("2026-09-01", i * 2);
  const { devices, linked } = captureDevices(i);
  const omit = i % 4 === 0 ? linked[1] : null;
  const unused = () => {
    throw new Error("Not used by a capture");
  };
  const repo: MeteringRepository = {
    getAuthenticatedUserId: async () => "user-1",
    getUserRoles: async () => [],
    isPluginEnabled: async () => true,
    getMicrogridOrganization: async () => ({ microgridId: MICROGRID, communityId: uuid(0xa2), orgId: ORG }),
    getTenantOrganization: unused,
    getDeviceOrganization: unused,
    getStoredConnection: unused,
    getMicrogridTimezone: async () => tz,
    getManagedDevices: async () => devices,
    getHouseMeterIds: async () => linked,
    getMicrogridEdges: unused,
    getKnownEdgeIds: unused,
    getAssignmentLinks: unused,
    insertMeterReading: unused,
    findMeterReadingAt: unused,
  };
  const registry = new MeteringRegistry();
  registry.register("synthetic", {
    synthetic: true,
    getReadings: async () => [],
    getSiteSamples: async (request) => stubSamples(request, omit),
  });
  const capability = new MeteringCapability(
    repo,
    { organizationId: ORG, userId: "user-1", roles: [] },
    registry,
    { testStored: unused, testCandidate: unused, discover: unused },
    () => true,
    async () => "synthetic"
  );
  const capture = await capability.captureSiteDay(
    { microgrid_id: MICROGRID, date },
    { date, tz, zone: "microgrid" }
  );
  if (capture.outcome !== "read") throw new Error(`Day ${i} was not read: ${JSON.stringify(capture).slice(0, 200)}`);
  return capture.snapshot;
}

const BUILDER_SEEDS = 300;
const CAPTURE_DAYS = 40;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("SITE_DAY_CALC_VERSION", () => {
  it("is the highest version with a digest, and none is missing", () => {
    const versions = Object.keys(CALC_DIGESTS).map(Number);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
    expect(SITE_DAY_CALC_VERSION).toBe(Math.max(...versions));
    expect(Object.keys(CALC_PARAMS).map(Number)).toEqual(versions);
  });

  it("keeps its version's thresholds", () => {
    expect(SITE_DAY_PARAMS, FAILURE).toEqual(CALC_PARAMS[SITE_DAY_CALC_VERSION]);
  });

  it("gives its version's digest over the frozen corpus", async () => {
    const views: unknown[] = [];
    const reached = new Set<string>();
    const note = (s: SiteDayEvidence) => {
      for (const [key, item] of Object.entries(s.items)) {
        const { c, reason } = item as { c: string; reason?: string };
        reached.add(`${key}:${c}${reason ? `:${reason}` : ""}`);
        if (key === "meter_outcomes") for (const v of Object.values(item)) reached.add(`outcome:${v}`);
        if (key === "no_data" && c === "calculated") {
          for (const r of (item as { ruledOut: { grid: unknown }[] }).ruledOut) if (r.grid === null) reached.add("no_data:null pointer");
        }
        if (key === "meter_window" && (item as { start: unknown }).start === null) reached.add("meter_window:null");
      }
    };
    const example = exampleInput();
    views.push(calculatedView(example, false));
    note(example);
    for (let seed = 1; seed <= BUILDER_SEEDS; seed++) {
      const s = randomBuilderInput(seed);
      views.push(calculatedView(s, false));
      note(s);
    }
    for (const s of fixedBuilderInputs()) {
      views.push(calculatedView(s, false));
      note(s);
    }
    for (let i = 0; i < CAPTURE_DAYS; i++) {
      const s = await captureSnapshot(i);
      views.push(calculatedView(s, true));
      note(s);
    }
    // What the corpus covers, so a change that empties a part of it shows.
    for (const covered of [
      "dark_cut:calculated", "dark_lowbat:calculated", "dark_after_lowbat:calculated", "no_data:calculated",
      "no_data:null pointer", "dark_lowbat:unavailable:input_unavailable", "dark_cut:unavailable:input_unavailable",
      "outcome:no_start", "outcome:no_end", "outcome:backwards", "meter_window:null",
      "src_battery:unavailable:id_not_storable", "src_grid:unavailable:source_not_readable",
      "m_id_not_storable:unavailable:id_not_storable", "m_unreadable:unavailable:tenant_meter_unreadable",
    ]) {
      expect(reached, covered).toContain(covered);
    }
    const digest = createHash("sha256").update(JSON.stringify(views)).digest("hex");
    expect(digest, FAILURE).toBe(CALC_DIGESTS[SITE_DAY_CALC_VERSION]);
  }, 240_000);

  // What the fixed days cover under version 1. A bump that changes one of
  // these figures on purpose changes this test with it.
  it("has fixed days that are what they say", () => {
    const [noBattery, noGrid, noVolts, atThreshold] = fixedBuilderInputs().map(
      (s) => s.items as Record<string, ({ c: string } & Record<string, unknown>) | undefined>
    );
    for (const items of [noBattery, noGrid]) {
      for (const key of ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"]) expect(items[key], key).toBeUndefined();
      expect(items.summary?.knownMin).toBe(1440);
    }
    expect(noVolts.summary?.cutMin).toBeNull();
    expect(atThreshold.dark_cut).toBeUndefined();
    expect(atThreshold.no_data).toMatchObject({ c: "calculated", ranges: [[0, 60], [750, 850]] });
  });
});
