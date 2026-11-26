/**
 * Invariants of the site-day evidence snapshot over generated days, seeded
 * random days and refused reads, and the closed-schema allowlist
 * (docs/investigation-evidence.md §4 "Closed schema"): every key path a
 * snapshot holds is on SITE_DAY_EVIDENCE_PATHS, every string leaf is of
 * its path's class, and the corpus reaches every path on the list, so the
 * list cannot go stale.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { DeviceConfig } from "@/lib/adapters/types";
import { addDaysToDateKey, isCalendarDateKey, startOfDayInZone } from "@/lib/timezone/day-key";
import { OPENEMS_ID_PATTERN } from "@/lib/validation/stored-id";
import { validateTimezone } from "@/lib/validation/timezone";
import type { SiteSourceEvidence, UnreadableHouseMeter } from "../capability";
import { caseDeviceId, caseMicrogridId } from "../fixture/case-ids";
import { mulberry32 } from "../fixture/random";
import { generateSiteSamples } from "../fixture/site-samples";
import {
  SITE_DAY_EVIDENCE_SCHEMA,
  SITE_DAY_POINTER_RE,
  SITE_DAY_PROVIDERS,
  SITE_DAY_REFUSAL_CODES,
  SITE_DAY_REFUSAL_REASONS,
  SITE_DAY_UNITS,
  buildRefusedSiteDaySnapshot,
  buildSiteDaySnapshot,
  resolveEvidencePointer,
  siteDayEvidenceSchema,
  siteDayRefusal,
  type SiteDayEvidence,
  type SiteDayEvidenceRead,
  type SiteDaySnapshotInput,
  type SourceKey,
} from "../site-day-evidence";
import {
  computeSiteDayDetail,
  type SiteDayDetail,
  type SiteDayOperations,
  type SiteSourceAvailability,
} from "../site-operations";
import type { SiteSamples, SiteSources } from "../types";
import { DEVICES, type Available, sourceEvidence } from "./site-day-evidence.helpers";

const MINUTE = 60_000;
const BIN_MINUTES = 5;
const BIN_MS = BIN_MINUTES * MINUTE;
/** These build over a thousand snapshots; the default five seconds is too little on a loaded runner. */
const LONG = 240_000;

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

const SOURCES = ["src_battery", "src_grid", "src_load", "src_pv"] as const;
const sourcePaths = SOURCES.flatMap((src) =>
  ["", ".c", ".k", ".type", ".device", ".edge", ".component", ".reason"].map((p) => `items.${src}${p}`)
);
const darkPaths = (key: string, withV: boolean) =>
  [
    "", ".c", ".k", ".cause", ".ranges", ".ranges[]", ".ranges[][]", ".min",
    ".decidedBy", ".decidedBy[]", ".decidedBy[].ptr", ...(withV ? [".decidedBy[].v"] : []),
    ".reason", ".in", ".in[]",
  ].map((p) => `items.${key}${p}`);
const metersPaths = (key: string) => ["", ".c", ".k", ".reason", ".devices", ".devices[]"].map((p) => `items.${key}${p}`);

/**
 * Every key path a `site-day-evidence/1` snapshot may hold: an index is
 * `[]`, a device-id key `<device>`. Evidence §4's key table, written out;
 * a new path is a new schema version, with that table.
 */
const SITE_DAY_EVIDENCE_PATHS: ReadonlySet<string> = new Set([
  "schema",
  "window", "window.date", "window.tz", "window.zone", "window.t0", "window.res", "window.bins",
  "window.caveat", "window.caveat[]",
  "units", "units.soc", "units.w", "units.v", "units.meter", "units.energy", "units.pct", "units.pos", "units.range",
  "by", "by.calc", "by.provider",
  "params", "params.gridMinV", "params.lowBatPct", "params.meterTolMin", "params.eveningStartH", "params.lagMin",
  "items",
  ...sourcePaths,
  "items.carry_in", "items.carry_in.c", "items.carry_in.k",
  "items.carry_in.gridV", "items.carry_in.gridV[]", "items.carry_in.soc", "items.carry_in.soc[]",
  "items.series", "items.series.c", "items.series.k",
  "items.series.soc", "items.series.soc[]", "items.series.batW", "items.series.batW[]",
  "items.series.gridW", "items.series.gridW[]", "items.series.gridV", "items.series.gridV[]",
  "items.series.loadW", "items.series.loadW[]", "items.series.pvW", "items.series.pvW[]",
  "items.timestamps", "items.timestamps.c", "items.timestamps.k", "items.timestamps.dropped", "items.timestamps.reason",
  ...darkPaths("dark_cut", true),
  ...darkPaths("dark_lowbat", true),
  ...darkPaths("dark_after_lowbat", false),
  "items.no_data", "items.no_data.c", "items.no_data.k", "items.no_data.ranges", "items.no_data.ranges[]",
  "items.no_data.ranges[][]", "items.no_data.min", "items.no_data.ruledOut", "items.no_data.ruledOut[]",
  "items.no_data.ruledOut[].grid", "items.no_data.ruledOut[].grid.ptr", "items.no_data.ruledOut[].grid.v",
  "items.no_data.ruledOut[].soc", "items.no_data.ruledOut[].soc.ptr", "items.no_data.ruledOut[].soc.v",
  "items.no_data.reason", "items.no_data.in", "items.no_data.in[]",
  "items.meter_window", "items.meter_window.c", "items.meter_window.k",
  "items.meter_window.start", "items.meter_window.start[]", "items.meter_window.end", "items.meter_window.end[]",
  "items.meter_readings", "items.meter_readings.c", "items.meter_readings.k",
  "items.meter_readings.<device>", "items.meter_readings.<device>.component",
  "items.meter_readings.<device>.start", "items.meter_readings.<device>.start[]",
  "items.meter_readings.<device>.end", "items.meter_readings.<device>.end[]",
  "items.meter_outcomes", "items.meter_outcomes.c", "items.meter_outcomes.k", "items.meter_outcomes.<device>",
  ...metersPaths("m_unreadable"),
  ...metersPaths("m_id_not_storable"),
  "items.summary", "items.summary.c", "items.summary.k", "items.summary.darkMin", "items.summary.darkInferredMin",
  "items.summary.noDataMin", "items.summary.knownMin", "items.summary.lightsOnPct", "items.summary.cutMin",
  "items.summary.tenantMetersEveningKwh", "items.summary.metersLeftOut",
  "items.read", "items.read.c", "items.read.k", "items.read.reason", "items.read.from", "items.read.from.status",
  "items.read.from.code",
]);

/** The closed codes a string leaf outside the id, date, zone and pointer paths may hold. */
const CODES: ReadonlySet<string> = new Set([
  SITE_DAY_EVIDENCE_SCHEMA,
  "microgrid", "fallback", "zone_fallback",
  ...Object.values(SITE_DAY_UNITS),
  ...SITE_DAY_PROVIDERS,
  "fact", "calculated", "unavailable",
  "source", "carry_in", "series", "timestamps", "dark", "no_data", "meter_window", "meter_readings",
  "meter_outcomes", "meters", "summary", "read",
  "battery", "grid_meter", "inverter", "pv_meter",
  "known_cut", "low_battery", "after_low_battery",
  "source_not_readable", "id_not_storable", "tenant_meter_unreadable", "not_reported", "input_unavailable",
  ...SITE_DAY_REFUSAL_REASONS,
  ...SITE_DAY_REFUSAL_CODES,
  ...SOURCES,
  "no_start", "no_end", "backwards",
]);

const guid = z.guid();
const isDeviceId = (s: string) => guid.safeParse(s).success;
const DEVICE_PATHS = new Set(SOURCES.map((s) => `items.${s}.device`).concat([
  "items.m_unreadable.devices[]",
  "items.m_id_not_storable.devices[]",
]));
const OPENEMS_PATHS = new Set(
  SOURCES.flatMap((s) => [`items.${s}.edge`, `items.${s}.component`]).concat("items.meter_readings.<device>.component")
);

function stringClassOk(path: string, value: string): boolean {
  if (DEVICE_PATHS.has(path)) return isDeviceId(value);
  if (OPENEMS_PATHS.has(path)) return OPENEMS_ID_PATTERN.test(value);
  if (path === "window.date") return isCalendarDateKey(value);
  if (path === "window.tz") return !validateTimezone(value);
  if (path.endsWith(".ptr")) return SITE_DAY_POINTER_RE.test(value);
  return CODES.has(value);
}

/** Every key path in a snapshot, normalised, and every string leaf's class checked. */
function pathsOf(snapshot: SiteDayEvidence, reached: Set<string>): string[] {
  const bad: string[] = [];
  const walk = (value: unknown, path: string, parent: string) => {
    if (path) reached.add(path);
    if (path && !SITE_DAY_EVIDENCE_PATHS.has(path)) bad.push(`path ${path}`);
    if (typeof value === "string" && !stringClassOk(path, value)) bad.push(`string at ${path}`);
    if (Array.isArray(value)) {
      value.forEach((v) => walk(v, `${path}[]`, path));
    } else if (value !== null && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        let segment = key;
        if ((path === "items.meter_readings" || path === "items.meter_outcomes") && key !== "c" && key !== "k") {
          if (!isDeviceId(key)) bad.push(`device key at ${path}`);
          segment = "<device>";
        }
        walk(v, path ? `${path}.${segment}` : segment, path);
      }
    }
    void parent;
  };
  walk(snapshot, "", "");
  return bad;
}

// ---------------------------------------------------------------------------
// Invariants of one snapshot
// ---------------------------------------------------------------------------

const RANGE_KEYS = ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"] as const;
type RangeKey = (typeof RANGE_KEYS)[number];
/** Evidence §4's key table, restated: what each range item rests on. */
const RESTS_ON: Record<RangeKey, SourceKey[]> = {
  dark_cut: ["src_grid"],
  dark_lowbat: ["src_battery", "src_grid"],
  dark_after_lowbat: ["src_battery", "src_grid"],
  no_data: ["src_battery", "src_grid"],
};
/** Evidence §4's summary table, restated. */
const FIGURE_RESTS_ON: Record<string, RangeKey[]> = {
  darkMin: ["dark_cut", "dark_lowbat", "dark_after_lowbat"],
  darkInferredMin: ["dark_lowbat"],
  noDataMin: ["no_data"],
  knownMin: ["no_data"],
  lightsOnPct: ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"],
  cutMin: ["dark_cut", "dark_lowbat", "dark_after_lowbat"],
  tenantMetersEveningKwh: [],
  metersLeftOut: [],
};
const FIGURE_OF: Record<string, keyof SiteDayOperations> = {
  darkMin: "darkMinutes",
  darkInferredMin: "darkInferredMinutes",
  noDataMin: "noDataMinutes",
  knownMin: "knownMinutes",
  lightsOnPct: "lightsOnPct",
  cutMin: "cutMinutes",
  tenantMetersEveningKwh: "housesEveningKwh",
  metersLeftOut: "housesEveningMetersMissing",
};
const SERIES_SOURCE: Record<string, SourceKey> = {
  soc: "src_battery",
  batW: "src_battery",
  gridW: "src_grid",
  gridV: "src_grid",
  loadW: "src_load",
  pvW: "src_pv",
};

/**
 * The value with -0 read as 0. JSON prints -0 as 0 (and jsonb stores it as
 * 0), and a provider's rounded power can be -0; nothing else may change in
 * a round trip.
 */
function withoutNegativeZero<T>(value: T): T {
  if (Object.is(value, -0)) return 0 as T;
  if (Array.isArray(value)) return value.map(withoutNegativeZero) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNegativeZero(v)])) as T;
  }
  return value;
}

function expectReadInvariants(input: SiteDaySnapshotInput, s: SiteDayEvidenceRead) {
  const { day, detail } = input;
  expect(siteDayEvidenceSchema.safeParse(s).success).toBe(true);
  expect(JSON.parse(JSON.stringify(s))).toEqual(withoutNegativeZero(s));

  const fact = (key: SourceKey) => s.items[key].c === "fact";
  // Pointers resolve to their value, or to a range.
  for (const key of ["dark_cut", "dark_lowbat"] as const) {
    const item = s.items[key];
    if (item?.c === "calculated") {
      for (const p of item.decidedBy) expect(resolveEvidencePointer(s, p.ptr)).toBe(p.v);
    }
  }
  const after = s.items.dark_after_lowbat;
  if (after?.c === "calculated") {
    for (const p of after.decidedBy) {
      const range = resolveEvidencePointer(s, p.ptr);
      expect(Array.isArray(range)).toBe(true);
    }
  }
  const noData = s.items.no_data;
  if (noData?.c === "calculated") {
    for (const { grid, soc } of noData.ruledOut) {
      for (const p of [grid, soc]) if (p) expect(resolveEvidencePointer(s, p.ptr)).toBe(p.v);
    }
  }

  // Range items present exactly as rule Z says, aligned with their ranges.
  const gap = RANGE_KEYS.some((key) => detail[key].ranges.length > 0);
  const unavailableItems = new Set<RangeKey>();
  for (const key of RANGE_KEYS) {
    const missing = RESTS_ON[key].filter((src) => !fact(src));
    const item = s.items[key];
    if (missing.length > 0) {
      if (gap) {
        expect(item, key).toMatchObject({ c: "unavailable", reason: "input_unavailable", in: missing });
        unavailableItems.add(key);
      } else {
        expect(item, key).toBeUndefined();
      }
    } else if (detail[key].ranges.length > 0) {
      expect(item?.c, key).toBe("calculated");
      if (item?.c === "calculated") {
        expect(item.ranges).toEqual(detail[key].ranges);
        expect(item.min).toBe(detail[key].min);
        const aligned = "ruledOut" in item ? item.ruledOut : item.decidedBy;
        expect(aligned).toHaveLength(item.ranges.length);
      }
    } else {
      expect(item, key).toBeUndefined();
    }
  }

  // Summary: as computed, or null exactly as rule Z says.
  for (const [figure, restsOn] of Object.entries(FIGURE_RESTS_ON)) {
    const stored = (s.items.summary as Record<string, unknown>)[figure];
    if (restsOn.some((key) => unavailableItems.has(key))) expect(stored, figure).toBeNull();
    else expect(stored, figure).toBe(day[FIGURE_OF[figure]]);
  }

  // Window.
  expect(s.window.res).toBe(5);
  expect(s.window.t0).toBe(day.dayStartMs);
  expect(s.window.bins).toBe(day.soc.length);
  if (day.readUntilMs === day.dayEndMs) expect(s.window.t0 + s.window.bins * s.window.res * MINUTE).toBe(day.dayEndMs);

  // Series: bins values, or null exactly when the source is unavailable.
  for (const [name, source] of Object.entries(SERIES_SOURCE)) {
    const values = (s.items.series as Record<string, unknown>)[name];
    if (fact(source)) {
      expect(values, name).toEqual(detail.series[name as keyof SiteDayDetail["series"]]);
      expect(values).toHaveLength(s.window.bins);
    } else {
      expect(values, name).toBeNull();
    }
  }

  // The m_* items: exactly the unreadable meters, by reason, on every read.
  const listed = (reason: UnreadableHouseMeter["reason"]) =>
    input.unreadableMeters.filter((m) => m.reason === reason).map((m) => m.id).sort();
  expect(s.items.m_unreadable?.devices ?? []).toEqual(listed("tenant_meter_unreadable"));
  expect(s.items.m_id_not_storable?.devices ?? []).toEqual(listed("id_not_storable"));

  // Meters: when searched, the meters asked for with their components.
  const readings = Object.entries(s.items.meter_readings).filter(([k]) => k !== "c" && k !== "k");
  const outcomes = Object.keys(s.items.meter_outcomes).filter((k) => k !== "c" && k !== "k");
  if (s.items.meter_window.start !== null && day.sources.houses) {
    expect(readings.map(([id]) => id).sort()).toEqual(input.houseMeters.map((m) => m.id).sort());
    const component = new Map(input.houseMeters.map((m) => [m.id, m.componentId]));
    for (const [id, reading] of readings) expect((reading as { component: string }).component).toBe(component.get(id));
    for (const id of outcomes) expect(readings.map(([r]) => r)).toContain(id);
    expect(s.items.summary.metersLeftOut).toBe(
      outcomes.length + listed("tenant_meter_unreadable").length + listed("id_not_storable").length
    );
  } else {
    expect(readings).toEqual([]);
    expect(outcomes).toEqual([]);
    expect(s.items.summary.metersLeftOut).toBe(0);
  }
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const config = (id: string, componentId: string): DeviceConfig => ({
  id,
  edgeOpenemsId: "SYNTHETIC-EDGE-CASE-01",
  componentId,
});
const FIXTURE_METERS = ["11", "12", "13"].map((dd) => config(caseDeviceId("01", dd), `meter${dd.slice(-1)}`));
const FIXTURE_UNREADABLE: UnreadableHouseMeter[] = [
  { id: caseDeviceId("01", "14"), reason: "tenant_meter_unreadable" },
  { id: caseDeviceId("01", "15"), reason: "id_not_storable" },
];

function siteSources(available: Available, houseMeters: DeviceConfig[]): SiteSources {
  return {
    battery: available.battery ? config(DEVICES.battery, "ess0") : null,
    gridMeter: available.grid ? config(DEVICES.grid_meter, "meter0") : null,
    load: available.load ? config(DEVICES.inverter, "inverter0") : null,
    pv: available.pv ? config(DEVICES.pv_meter, "meter4") : null,
    houseMeters,
    houseMetersUnreadable: 0,
  };
}

function availability(available: Available, meters: number, unreadable: number): SiteSourceAvailability {
  return {
    battery: available.battery,
    gridMeter: available.grid,
    load: available.load,
    pv: available.pv,
    houses: meters + unreadable > 0,
    houseMetersUnreadable: unreadable,
  };
}

function snapshotInput(options: {
  date: string;
  timezone: string;
  zone: "microgrid" | "fallback";
  samples: SiteSamples;
  available: Available;
  houseMeters: DeviceConfig[];
  unreadable: UnreadableHouseMeter[];
  nowMs: number;
  provider: string;
  sources?: SiteSourceEvidence;
}): SiteDaySnapshotInput {
  const { day, detail } = computeSiteDayDetail({
    date: options.date,
    timezone: options.timezone,
    samples: options.samples,
    sources: availability(options.available, options.houseMeters.length, options.unreadable.length),
    resolutionMinutes: BIN_MINUTES,
    nowMs: options.nowMs,
    houseMeterIds: options.houseMeters.map((m) => m.id),
  });
  return {
    date: options.date,
    zone: { tz: options.timezone, zone: options.zone },
    provider: options.provider,
    day,
    detail,
    sources: options.sources ?? sourceEvidence(options.available),
    houseMeters: options.houseMeters,
    unreadableMeters: options.unreadable,
    unreadableTimestamps: options.samples.unreadableTimestamps ?? null,
  };
}

const VARIANTS: Available[] = [
  { battery: true, grid: true, load: true, pv: true },
  { battery: false, grid: true, load: true, pv: true },
  { battery: true, grid: false, load: true, pv: false },
];

function fixtureInput(date: string, available: Available, timezone = "Africa/Kampala"): SiteDaySnapshotInput {
  const microgridId = caseMicrogridId("01");
  const samples = generateSiteSamples({
    microgridId,
    sources: siteSources(available, FIXTURE_METERS),
    startDate: addDaysToDateKey(date, -1),
    endDate: date,
    timezone,
    resolutionMinutes: BIN_MINUTES,
  });
  return snapshotInput({
    date,
    timezone,
    zone: "microgrid",
    samples,
    available,
    houseMeters: FIXTURE_METERS,
    unreadable: date.endsWith("1") ? FIXTURE_UNREADABLE : [],
    nowMs: startOfDayInZone(addDaysToDateKey(date, 2), timezone).getTime(),
    provider: "synthetic",
  });
}

const RANDOM_ZONES = ["Africa/Kampala", "Europe/London", "America/New_York", "UTC"];
const RANDOM_DATES = ["2026-03-08", "2026-03-29", "2026-06-15", "2026-10-25", "2026-11-01", "2026-11-10"];
const meterId = (seed: number, i: number) =>
  `00000000-0000-4000-8000-${(seed * 16 + i).toString(16).padStart(12, "0")}`;

/**
 * Random samples in 5-minute bins (the only resolution `@1` defines): runs
 * of empty bins, bins with two samples, voltages either side of the
 * threshold, SoC around the floor, random source availability, tenant
 * meters that go silent, backwards or missing from the samples, unreadable
 * meters of both reasons, and reads that end before the day.
 */
function randomInput(seed: number): SiteDaySnapshotInput {
  const random = mulberry32(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const timezone = pick(RANDOM_ZONES);
  const date = pick(RANDOM_DATES);
  const fallback = timezone === "UTC" && random() < 0.5;
  const available: Available = {
    battery: random() < 0.8,
    grid: random() < 0.8,
    load: random() < 0.8,
    pv: random() < 0.5,
  };
  if (!available.battery && !available.grid) available[random() < 0.5 ? "battery" : "grid"] = true;
  const meterCount = Math.floor(random() * 4);
  const houseMeters = Array.from({ length: meterCount }, (_, i) => config(meterId(seed, i), `meter${i}`));
  const held = houseMeters.filter(() => random() < 0.85).map((m) => m.id);
  const unreadable: UnreadableHouseMeter[] = [];
  for (let i = 0; i < Math.floor(random() * 3); i++) {
    unreadable.push({
      id: meterId(seed, 8 + i),
      reason: random() < 0.5 ? "tenant_meter_unreadable" : "id_not_storable",
    });
  }

  const carryStartMs = startOfDayInZone(addDaysToDateKey(date, -1), timezone).getTime();
  const dayStartMs = startOfDayInZone(date, timezone).getTime();
  const dayEndMs = startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime();
  const gapChance = 0.02 + random() * 0.2;
  const out: SiteSamples = {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: Object.fromEntries(held.map((id) => [id, []])),
  };
  const counters = held.map(() => 1000 + Math.floor(random() * 100_000));
  const value = (ok: boolean, chanceNull: number, draw: () => number) =>
    !ok || random() < chanceNull ? null : draw();
  let gapLeft = 0;
  for (let t = carryStartMs; t < dayEndMs + BIN_MS; t += BIN_MS) {
    if (gapLeft > 0) {
      gapLeft--;
      continue;
    }
    if (random() < gapChance) {
      gapLeft = Math.floor(random() * 40);
      continue;
    }
    const samplesInBin = random() < 0.15 ? 2 : 1;
    for (let k = 0; k < samplesInBin; k++) {
      out.timestamps.push(t + k * Math.floor(BIN_MS / 3));
      const allNull = random() < 0.03;
      out.batterySocPct.push(allNull ? null : value(available.battery, 0.15, () => Math.round(random() * 400) / 10));
      out.batteryPowerW.push(allNull ? null : value(available.battery, 0.5, () => random() * 2000 - 1000));
      out.gridPowerW.push(allNull ? null : value(available.grid, 0.5, () => random() * 3000 - 500));
      out.gridVoltageV.push(
        allNull
          ? null
          : value(available.grid, 0.25, () => (random() < 0.3 ? Math.round(random() * 1690) / 10 : 170 + random() * 70))
      );
      out.loadPowerW.push(allNull ? null : value(available.load, 0.5, () => Math.round(random() * 1500)));
      out.pvPowerW.push(allNull ? null : value(available.pv, 0.5, () => random() * 3000));
      held.forEach((id, i) => {
        if (random() < 0.02) counters[i] = Math.floor(random() * 1000);
        counters[i] += random() * 50;
        out.houseEnergyWh[id].push(allNull || random() < 0.2 ? null : counters[i]);
      });
    }
  }
  if (random() < 0.7) out.unreadableTimestamps = Math.floor(random() * 3) * Math.floor(random() * 20);
  const finished = random() < 0.7;
  return snapshotInput({
    date,
    timezone,
    zone: fallback ? "fallback" : "microgrid",
    samples: out,
    available,
    houseMeters,
    unreadable,
    nowMs: finished ? dayEndMs + 2 * MINUTE : dayStartMs + Math.floor(random() * (dayEndMs - dayStartMs)),
    provider: pick(SITE_DAY_PROVIDERS),
  });
}

/** A representative capability code for each §6 reason; an unknown code for `unknown_refusal`. */
const CODE_FOR: Record<string, [number, string]> = {
  provider_unauthorized: [503, "METERING_UNAUTHORIZED"],
  mixed_edges: [409, "METERING_CONFIGURATION"],
  provider_not_configured: [503, "METERING_CONFIGURATION"],
  provider_unsupported: [503, "metering_site_samples_unsupported"],
  provider_unavailable: [503, "METERING_UNAVAILABLE"],
  provider_unreadable_timestamps: [503, "METERING_UNREADABLE_TIMESTAMPS"],
  provider_invalid_data: [503, "METERING_INVALID_DATA"],
  no_site_devices: [404, "metering_no_site_devices"],
  site_devices_unavailable: [503, "metering_site_devices_unavailable"],
  metering_disabled: [409, "metering_disabled"],
  gate_unavailable: [503, "metering_gate_unavailable"],
  zone_unavailable: [503, "metering_timezone_unavailable"],
  request_invalid: [422, "metering_invalid_date"],
  calculation_failed: [500, "metering_site_day_failed"],
  internal_error: [500, "metering_composition_disposed"],
  unknown_refusal: [418, "METERING_TEAPOT"],
};

function refusedSnapshots(): SiteDayEvidence[] {
  const out: SiteDayEvidence[] = [];
  SITE_DAY_REFUSAL_REASONS.forEach((reason, i) => {
    const [status, code] = CODE_FOR[reason];
    const refusal = siteDayRefusal(status, code);
    if (refusal.kind !== "evidence") throw new Error(`${reason} is not evidence`);
    expect(refusal.reason).toBe(reason);
    for (const withSources of [false, true]) {
      out.push(
        buildRefusedSiteDaySnapshot({
          date: "2026-09-01",
          zone: i % 2 ? { tz: "UTC", zone: "fallback" } : { tz: "Africa/Kampala", zone: "microgrid" },
          provider: withSources ? SITE_DAY_PROVIDERS[i % 2] : null,
          sources: withSources ? sourceEvidence(VARIANTS[i % 3], { battery: "id_not_storable" }) : null,
          refusal,
        })
      );
    }
  });
  return out;
}

const DATES_2026 = Array.from({ length: 365 }, (_, i) => addDaysToDateKey("2026-01-01", i));
const RANDOM_SEEDS = 400;

describe("site-day evidence — invariants and the closed-schema allowlist", () => {
  const reached = new Set<string>();
  const offenders: string[] = [];
  const record = (label: string, s: SiteDayEvidence) => {
    for (const bad of pathsOf(s, reached)) offenders.push(`${label}: ${bad}`);
  };

  it("hold on every 2026 fixture day, with and without a battery or grid meter", () => {
    for (const date of DATES_2026) {
      for (const available of VARIANTS) {
        const input = fixtureInput(date, available);
        const s = buildSiteDaySnapshot(input);
        expectReadInvariants(input, s);
        record(`${date} ${JSON.stringify(available)}`, s);
      }
    }
    for (const date of ["2026-03-29", "2026-10-25"]) {
      const input = fixtureInput(date, VARIANTS[0], "Europe/London");
      const s = buildSiteDaySnapshot(input);
      expect(s.window.bins).toBe(date === "2026-03-29" ? 276 : 300);
      expectReadInvariants(input, s);
      record(`London ${date}`, s);
    }
    expect(offenders).toEqual([]);
  }, LONG);

  it("hold on seeded random days", () => {
    let early = 0;
    for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
      const input = randomInput(seed);
      const s = buildSiteDaySnapshot(input);
      expectReadInvariants(input, s);
      record(`seed ${seed}`, s);
      if (input.day.readUntilMs < input.day.dayEndMs) early += 1;
    }
    expect(early).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  }, LONG);

  it("hold on refused reads of every reason", () => {
    for (const s of refusedSnapshots()) {
      expect(siteDayEvidenceSchema.safeParse(s).success).toBe(true);
      expect(JSON.parse(JSON.stringify(s))).toEqual(withoutNegativeZero(s));
      expect("t0" in s.window || "bins" in s.window).toBe(false);
      record("refused", s);
    }
    expect(offenders).toEqual([]);
  });

  it("reach every path on the allowlist", () => {
    const unreached = [...SITE_DAY_EVIDENCE_PATHS].filter((path) => !reached.has(path));
    expect(unreached).toEqual([]);
  });
});
