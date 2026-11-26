import { describe, expect, it } from "vitest";
import {
  RANGE_ITEM_KEYS,
  SITE_DAY_EVIDENCE_SCHEMA,
  SITE_DAY_ITEM_KEYS,
  SITE_DAY_PARAMS,
  SITE_DAY_UNITS,
  SUMMARY_RESTS_ON,
  SiteDayEvidenceDefect,
  buildRefusedSiteDaySnapshot,
  buildSiteDaySnapshot,
  meterEntries,
  normaliseEvidencePath,
  resolveEvidencePointer,
  schemaDefect,
  siteDayEvidenceReadSchema,
  siteDayEvidenceSchema,
  siteDayRefusal,
  type RangeItemKey,
  type SiteDayEvidenceRead,
  type SummaryFigure,
} from "../site-day-evidence";
import { SITE_DAY_CALC_VERSION } from "../site-operations";
import {
  ALL,
  D1,
  D2,
  D3,
  D4,
  DAY_END,
  DAY_START,
  DEVICES,
  MINUTE,
  NO_PV,
  everyItemRows,
  evidenceOf,
  exampleRows,
  fill,
  sourceEvidence,
  type Row,
} from "./site-day-evidence.helpers";

const EXAMPLE_METERS = [D1, D2, D3];
const D4_UNREADABLE = [{ id: D4, reason: "tenant_meter_unreadable" as const }];

function example(options: Parameters<typeof evidenceOf>[1] = {}) {
  return evidenceOf(exampleRows(), { meters: EXAMPLE_METERS, unreadable: D4_UNREADABLE, ...options });
}

/** A day online in every bin: no gap. */
function fullDayRows(): Map<number, Row> {
  const rows = new Map<number, Row>();
  rows.set(-1, { volts: 230, soc: 60 });
  fill(rows, 0, 287, { volts: 230, soc: 60 });
  return rows;
}

const clone = <T>(value: T): T => structuredClone(value);
const parses = (value: unknown) => siteDayEvidenceSchema.safeParse(value).success;

describe("buildSiteDaySnapshot — the evidence document's §4 example", () => {
  const { snapshot, day } = example();
  const s = snapshot();

  it("parses, and holds every key a successful read holds, in order", () => {
    expect(siteDayEvidenceSchema.parse(s)).toEqual(s);
    expect(Object.keys(s)).toEqual(["schema", "window", "units", "by", "params", "items"]);
    expect(Object.keys(s.items)).toEqual([
      "src_battery", "src_grid", "src_load", "src_pv", "carry_in", "series", "timestamps",
      "dark_cut", "dark_lowbat", "no_data", "meter_window", "meter_readings", "meter_outcomes",
      "m_unreadable", "summary",
    ]);
  });

  it("holds §4's window, units, version and params", () => {
    expect(s.schema).toBe(SITE_DAY_EVIDENCE_SCHEMA);
    expect(s.window).toEqual({
      date: "2026-11-10",
      tz: "Africa/Kampala",
      zone: "microgrid",
      t0: 1794258000000,
      res: 5,
      bins: 288,
    });
    expect(s.units).toEqual({ soc: "%", w: "W", v: "V", meter: "Wh", energy: "kWh", pct: "%", pos: "bin", range: "min" });
    expect(s.by).toEqual({ calc: SITE_DAY_CALC_VERSION, provider: "synthetic" });
    expect(s.params).toEqual({ gridMinV: 170, lowBatPct: 15, meterTolMin: 30, eveningStartH: 18, lagMin: 2 });
  });

  it("holds the sources, carry-in, series and timestamps as facts", () => {
    expect(s.items.src_battery).toEqual({
      c: "fact", k: "source", type: "battery", device: DEVICES.battery, edge: "SYNTHETIC-EDGE-EVIDENCE", component: "ess0",
    });
    expect(s.items.src_pv).toEqual({ c: "unavailable", k: "source", type: "pv_meter", reason: "source_not_readable" });
    expect(s.items.carry_in).toEqual({ c: "fact", k: "carry_in", gridV: [-1, 231.4], soc: [-1, 14.8] });
    expect(s.items.series.pvW).toBeNull();
    expect(s.items.series.gridV).toHaveLength(288);
    expect(s.items.timestamps).toEqual({ c: "fact", k: "timestamps", dropped: 0 });
  });

  it("points each range at what decided it", () => {
    expect(s.items.dark_lowbat).toEqual({
      c: "calculated", k: "dark", cause: "low_battery", ranges: [[0, 95]], min: 95,
      decidedBy: [{ ptr: "/items/carry_in/soc/1", v: 14.8 }],
    });
    expect(s.items.no_data).toEqual({
      c: "calculated", k: "no_data", ranges: [[600, 645]], min: 45,
      ruledOut: [{ grid: { ptr: "/items/series/gridV/119", v: 229.8 }, soc: { ptr: "/items/series/soc/119", v: 63 } }],
    });
    expect(s.items.dark_cut).toEqual({
      c: "calculated", k: "dark", cause: "known_cut", ranges: [[1140, 1305]], min: 165,
      decidedBy: [{ ptr: "/items/series/gridV/227", v: 0 }],
    });
    expect(s.items.dark_after_lowbat).toBeUndefined();
  });

  it("holds the meters' readings with their component ids, and the outcomes", () => {
    expect(s.items.meter_window).toEqual({ c: "calculated", k: "meter_window", start: [209, 216], end: [281, 287] });
    expect(s.items.meter_readings).toEqual({
      c: "fact",
      k: "meter_readings",
      [D1]: { component: "meter1", start: [215, 48211], end: [287, 48903.5] },
      [D2]: { component: "meter2", start: [215, 182340], end: [287, 1200] },
      [D3]: { component: "meter3", start: [214, 90412.5], end: null },
    });
    expect(Object.keys(s.items.meter_readings)).toEqual(["c", "k", D1, D2, D3]);
    expect(s.items.meter_outcomes).toEqual({ c: "calculated", k: "meter_outcomes", [D2]: "backwards", [D3]: "no_end" });
    expect(s.items.m_unreadable).toEqual({ c: "unavailable", k: "meters", reason: "tenant_meter_unreadable", devices: [D4] });
    expect(s.items.m_id_not_storable).toBeUndefined();
  });

  it("holds §4's summary, unrounded", () => {
    expect(s.items.summary).toEqual({
      c: "calculated",
      k: "summary",
      darkMin: 260,
      darkInferredMin: 95,
      noDataMin: 45,
      knownMin: 1395,
      lightsOnPct: day.lightsOnPct,
      cutMin: 265,
      tenantMetersEveningKwh: day.housesEveningKwh,
      metersLeftOut: 3,
    });
    expect(s.items.summary.lightsOnPct).toBeCloseTo(81.36, 2);
    expect(s.items.summary.tenantMetersEveningKwh).toBeCloseTo(0.6925, 9);
  });
});

describe("buildSiteDaySnapshot — rule Z", () => {
  const NO_BATTERY = { ...NO_PV, battery: false };
  const NO_GRID = { ...NO_PV, grid: false };
  const SIX: SummaryFigure[] = ["darkMin", "darkInferredMin", "noDataMin", "knownMin", "lightsOnPct", "cutMin"];
  const nullFigures = (s: SiteDayEvidenceRead) =>
    (Object.keys(s.items.summary) as (keyof typeof s.items.summary)[]).filter(
      (key) => key !== "c" && key !== "k" && s.items.summary[key] === null
    );

  it("stores the items resting on a missing battery unavailable on a day with a gap", () => {
    const { snapshot, day } = example({ available: NO_BATTERY });
    const s = snapshot();
    expect(parses(s)).toBe(true);
    expect(s.items.src_battery).toEqual({ c: "unavailable", k: "source", type: "battery", reason: "source_not_readable" });
    for (const key of ["dark_lowbat", "dark_after_lowbat", "no_data"] as const) {
      expect(s.items[key]).toMatchObject({ c: "unavailable", reason: "input_unavailable", in: ["src_battery"] });
    }
    expect(s.items.dark_lowbat).toEqual({
      c: "unavailable", k: "dark", cause: "low_battery", reason: "input_unavailable", in: ["src_battery"],
    });
    expect(s.items.no_data).toEqual({ c: "unavailable", k: "no_data", reason: "input_unavailable", in: ["src_battery"] });
    // dark_cut rests on the grid meter alone, so it is as computed.
    expect(s.items.dark_cut).toMatchObject({ c: "calculated", ranges: [[1140, 1305]] });
    expect(nullFigures(s)).toEqual(SIX);
    expect(s.items.summary.tenantMetersEveningKwh).toBe(day.housesEveningKwh);
    expect(s.items.summary.metersLeftOut).toBe(day.housesEveningMetersMissing);
    expect(s.items.series.soc).toBeNull();
    expect(s.items.series.batW).toBeNull();
    expect(s.items.carry_in.soc).toBeNull();
    expect(s.items.carry_in.gridV).toEqual([-1, 231.4]);
  });

  it("stores no range item and the summary as computed on a day without a gap", () => {
    for (const available of [NO_BATTERY, NO_GRID]) {
      const { snapshot, day } = evidenceOf(fullDayRows(), { available });
      const s = snapshot();
      expect(parses(s)).toBe(true);
      for (const key of RANGE_ITEM_KEYS) expect(s.items[key]).toBeUndefined();
      expect(s.items.summary).toMatchObject({
        darkMin: day.darkMinutes,
        darkInferredMin: day.darkInferredMinutes,
        noDataMin: day.noDataMinutes,
        knownMin: day.knownMinutes,
        lightsOnPct: day.lightsOnPct,
        cutMin: day.cutMinutes,
      });
    }
  });

  it("stores all four range items unavailable without a grid meter on a day with a gap", () => {
    const { snapshot } = example({ available: NO_GRID });
    const s = snapshot();
    expect(parses(s)).toBe(true);
    for (const key of RANGE_ITEM_KEYS) {
      expect(s.items[key], key).toMatchObject({ c: "unavailable", reason: "input_unavailable", in: ["src_grid"] });
    }
    expect(s.items.dark_cut).toEqual({
      c: "unavailable", k: "dark", cause: "known_cut", reason: "input_unavailable", in: ["src_grid"],
    });
    expect(nullFigures(s)).toEqual(SIX);
    expect(s.items.series.gridV).toBeNull();
    expect(s.items.series.gridW).toBeNull();
    expect(s.items.carry_in.gridV).toBeNull();
  });

  it("names the unavailable sources in item-key order", () => {
    // A read refuses a site with neither, but the order is fixed.
    const { snapshot } = example({ available: { ...NO_PV, battery: false, grid: false } });
    const s = snapshot();
    expect(s.items.no_data).toMatchObject({ in: ["src_battery", "src_grid"] });
    expect(s.items.dark_cut).toMatchObject({ in: ["src_grid"] });
  });

  // One test per row of evidence §4's summary table: the range items each
  // figure rests on, and that it is null exactly when one is unavailable.
  const TABLE: [SummaryFigure, RangeItemKey[]][] = [
    ["darkMin", ["dark_cut", "dark_lowbat", "dark_after_lowbat"]],
    ["darkInferredMin", ["dark_lowbat"]],
    ["noDataMin", ["no_data"]],
    ["knownMin", ["no_data"]],
    ["lightsOnPct", ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"]],
    ["cutMin", ["dark_cut", "dark_lowbat", "dark_after_lowbat"]],
    ["tenantMetersEveningKwh", []],
    ["metersLeftOut", []],
  ];
  it("has a row for every summary figure", () => {
    expect(Object.keys(SUMMARY_RESTS_ON).sort()).toEqual(TABLE.map(([figure]) => figure).sort());
  });
  it.each(TABLE)("%s rests on %j", (figure, restsOn) => {
    expect(SUMMARY_RESTS_ON[figure]).toEqual(restsOn);
    for (const available of [NO_BATTERY, NO_GRID, NO_PV]) {
      const s = example({ available }).snapshot();
      const unavailable = restsOn.some((key) => s.items[key]?.c === "unavailable");
      if (unavailable) expect(s.items.summary[figure], JSON.stringify(available)).toBeNull();
      else expect(s.items.summary[figure], JSON.stringify(available)).not.toBeNull();
    }
  });
});

describe("buildSiteDaySnapshot — a read that ends by 18:00", () => {
  it.each([
    ["17:00", 17],
    ["18:00", 18],
  ])("at %s keeps meter_window with null bounds and no meter", (_label, hour) => {
    const { snapshot, day } = example({ nowMs: DAY_START + hour * 60 * MINUTE });
    const s = snapshot();
    expect(parses(s)).toBe(true);
    expect(s.items.meter_window).toEqual({ c: "calculated", k: "meter_window", start: null, end: null });
    expect(s.items.meter_readings).toEqual({ c: "fact", k: "meter_readings" });
    expect(s.items.meter_outcomes).toEqual({ c: "calculated", k: "meter_outcomes" });
    // Facts about the devices, listed whatever the time read.
    expect(s.items.m_unreadable).toMatchObject({ devices: [D4] });
    expect(s.items.summary.metersLeftOut).toBe(0);
    expect(s.window.bins).toBe(day.soc.length);
    expect(s.window.bins).toBeLessThan(288);
  });
});

describe("buildSiteDaySnapshot — window", () => {
  it("adds the zone_fallback caveat on a fallback, and only then", () => {
    const fallback = evidenceOf(fullDayRows(), { zone: { tz: "UTC", zone: "fallback" } }).snapshot();
    expect(fallback.window).toMatchObject({ tz: "UTC", zone: "fallback", caveat: ["zone_fallback"] });
    expect(parses(fallback)).toBe(true);
    expect(example().snapshot().window.caveat).toBeUndefined();
  });

  it("counts the bins read: 287 on a read that ends within the lag after midnight", () => {
    const { snapshot } = example({ nowMs: DAY_END + MINUTE });
    const s = snapshot();
    expect(s.window.bins).toBe(287);
    for (const series of Object.values(s.items.series)) {
      if (Array.isArray(series)) expect(series).toHaveLength(287);
    }
    expect(parses(s)).toBe(true);
  });
});

describe("buildSiteDaySnapshot — pointers", () => {
  it("points an after-low-battery gap at the low-battery range it follows", () => {
    const s = evidenceOf(everyItemRows(), { available: ALL, meters: EXAMPLE_METERS }).snapshot();
    expect(parses(s)).toBe(true);
    expect(s.items.dark_after_lowbat).toEqual({
      c: "calculated", k: "dark", cause: "after_low_battery", ranges: [[105, 130]], min: 25,
      decidedBy: [{ ptr: "/items/dark_lowbat/ranges/0" }],
    });
    expect(resolveEvidencePointer(s, "/items/dark_lowbat/ranges/0")).toEqual([0, 30]);
    for (const key of RANGE_ITEM_KEYS) expect(s.items[key]?.c, key).toBe("calculated");
  });

  it("points a no-data gap at the start of the day at the carry-in", () => {
    const rows = new Map<number, Row>();
    rows.set(-13, { volts: 231, soc: 60 });
    fill(rows, 36, 287, { volts: 230, soc: 50 });
    const s = evidenceOf(rows).snapshot();
    expect(s.items.carry_in).toMatchObject({ gridV: [-13, 231], soc: [-13, 60] });
    expect(s.items.no_data).toMatchObject({
      ranges: [[0, 180]],
      ruledOut: [{ grid: { ptr: "/items/carry_in/gridV/1", v: 231 }, soc: { ptr: "/items/carry_in/soc/1", v: 60 } }],
    });
    expect(parses(s)).toBe(true);
  });

  it("throws a pointer defect when a reading is not the value at its position", () => {
    const { input } = example();
    input.detail.series.gridV[227] = 1;
    expect(() => buildSiteDaySnapshot(input)).toThrow(
      expect.objectContaining({ check: "pointer", path: "/items/dark_cut/decidedBy/[]" })
    );
  });

  it("throws a meter_join defect for a meter reading with no requested source", () => {
    const { input } = example();
    input.houseMeters = input.houseMeters.filter((m) => m.id !== D2);
    let thrown: unknown;
    try {
      buildSiteDaySnapshot(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SiteDayEvidenceDefect);
    expect(thrown).toMatchObject({ check: "meter_join", path: "/items/meter_readings/<device>" });
    expect(String((thrown as Error).message)).not.toContain(D2);
  });

  it("throws a provider_name defect for a provider §4 does not name", () => {
    const { input } = example({ provider: "acme" });
    expect(() => buildSiteDaySnapshot(input)).toThrow(expect.objectContaining({ check: "provider_name" }));
  });
});

describe("siteDayRefusal — evidence §6", () => {
  it.each([
    [503, "METERING_UNAUTHORIZED", "provider_unauthorized"],
    [409, "METERING_CONFIGURATION", "mixed_edges"],
    [503, "METERING_CONFIGURATION", "provider_not_configured"],
    [403, "METERING_CONFIGURATION", "provider_not_configured"],
    [500, "METERING_CONFIGURATION", "provider_not_configured"],
    [503, "metering_site_samples_unsupported", "provider_unsupported"],
    [503, "METERING_UNAVAILABLE", "provider_unavailable"],
    [503, "METERING_UNREADABLE_TIMESTAMPS", "provider_unreadable_timestamps"],
    [503, "METERING_INVALID_DATA", "provider_invalid_data"],
    [404, "metering_no_site_devices", "no_site_devices"],
    [503, "metering_site_devices_unavailable", "site_devices_unavailable"],
    [409, "metering_disabled", "metering_disabled"],
    [503, "metering_gate_unavailable", "gate_unavailable"],
    [503, "metering_timezone_unavailable", "zone_unavailable"],
    [400, "metering_invalid_query", "request_invalid"],
    [400, "metering_invalid_microgrid", "request_invalid"],
    [422, "metering_invalid_date", "request_invalid"],
    [400, "metering_invalid_org", "request_invalid"],
    [500, "metering_site_day_failed", "calculation_failed"],
    [500, "metering_composition_disposed", "internal_error"],
    [500, "metering_composition_failed", "internal_error"],
  ] as const)("maps %i %s to %s, keeping the code", (status, code, reason) => {
    expect(siteDayRefusal(status, code)).toEqual({ kind: "evidence", reason, from: { status, code } });
  });

  it.each(["metering_scope_mismatch", "metering_forbidden", "metering_unauthenticated"])(
    "maps %s to an access refusal, with no evidence",
    (code) => {
      expect(siteDayRefusal(403, code)).toEqual({ kind: "access_refused" });
    }
  );

  it("keeps only the status of a code §6 does not name", () => {
    expect(siteDayRefusal(418, "METERING_TEAPOT")).toEqual({
      kind: "evidence",
      reason: "unknown_refusal",
      from: { status: 418 },
    });
    expect(siteDayRefusal(500, "toString")).toMatchObject({ reason: "unknown_refusal", from: { status: 500 } });
  });
});

describe("buildRefusedSiteDaySnapshot", () => {
  it("holds the window without t0 or bins, the given sources and the read item", () => {
    const refused = buildRefusedSiteDaySnapshot({
      date: "2026-11-10",
      zone: { tz: "UTC", zone: "fallback" },
      provider: "synthetic",
      sources: sourceEvidence({ battery: false, grid: false, load: true, pv: true }),
      refusal: { kind: "evidence", reason: "no_site_devices", from: { status: 404, code: "metering_no_site_devices" } },
    });
    expect(refused.window).toEqual({ date: "2026-11-10", tz: "UTC", zone: "fallback", res: 5, caveat: ["zone_fallback"] });
    expect(refused.by).toEqual({ calc: SITE_DAY_CALC_VERSION, provider: "synthetic" });
    expect(refused.units).toEqual(SITE_DAY_UNITS);
    expect(refused.params).toEqual(SITE_DAY_PARAMS);
    expect(Object.keys(refused.items)).toEqual(["src_battery", "src_grid", "src_load", "src_pv", "read"]);
    expect(refused.items.read).toEqual({
      c: "unavailable", k: "read", reason: "no_site_devices", from: { status: 404, code: "metering_no_site_devices" },
    });
    expect(parses(refused)).toBe(true);
  });

  it("holds no source and no provider when none was read or selected", () => {
    const refused = buildRefusedSiteDaySnapshot({
      date: "2026-11-10",
      zone: { tz: "Africa/Kampala", zone: "microgrid" },
      provider: null,
      sources: null,
      refusal: { kind: "evidence", reason: "unknown_refusal", from: { status: 418 } },
    });
    expect(refused.items).toEqual({ read: { c: "unavailable", k: "read", reason: "unknown_refusal", from: { status: 418 } } });
    expect(refused.by.provider).toBeNull();
    expect(refused.window.caveat).toBeUndefined();
    expect(parses(refused)).toBe(true);
  });

  it("stores a provider §4 does not name as none", () => {
    const refused = buildRefusedSiteDaySnapshot({
      date: "2026-11-10",
      zone: { tz: "Africa/Kampala", zone: "microgrid" },
      provider: "acme",
      sources: null,
      refusal: { kind: "evidence", reason: "provider_unsupported", from: { status: 503, code: "metering_site_samples_unsupported" } },
    });
    expect(refused.by.provider).toBeNull();
  });
});

/** Every plain object in a value, with its path. */
function objectsIn(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => objectsIn(v, [...path, i]));
  if (value === null || typeof value !== "object") return [];
  return [path, ...Object.entries(value).flatMap(([k, v]) => objectsIn(v, [...path, k]))];
}

function at(root: unknown, path: (string | number)[]): Record<string | number, unknown> {
  return path.reduce<unknown>((v, key) => (v as Record<string | number, unknown>)[key], root) as Record<
    string | number,
    unknown
  >;
}

describe("siteDayEvidenceSchema — closed", () => {
  const full = evidenceOf(everyItemRows(), {
    available: ALL,
    meters: EXAMPLE_METERS,
    unreadable: [
      { id: D4, reason: "tenant_meter_unreadable" },
      { id: "d0000000-0000-0000-0000-0000000000d5", reason: "id_not_storable" },
    ],
  }).snapshot();
  const unavailable = example({ available: { ...NO_PV, grid: false }, unreadableTimestamps: null }).snapshot();
  const refused = buildRefusedSiteDaySnapshot({
    date: "2026-11-10",
    zone: { tz: "UTC", zone: "fallback" },
    provider: "openems",
    sources: sourceEvidence(NO_PV),
    refusal: { kind: "evidence", reason: "provider_unavailable", from: { status: 503, code: "METERING_UNAVAILABLE" } },
  });

  it("accepts each snapshot it is built from", () => {
    for (const s of [full, unavailable, refused]) expect(siteDayEvidenceSchema.parse(s)).toEqual(s);
    expect(full.items.m_id_not_storable).toBeDefined();
    expect(unavailable.items.timestamps).toEqual({ c: "unavailable", k: "timestamps", reason: "not_reported" });
  });

  it("refuses an extra key on every object", () => {
    let tried = 0;
    for (const s of [full, unavailable, refused]) {
      for (const path of objectsIn(s)) {
        const changed = clone(s);
        at(changed, path).extra = 1;
        expect(parses(changed), path.join(".")).toBe(false);
        tried += 1;
      }
    }
    expect(tried).toBeGreaterThan(40);
  });

  it("refuses a message field, a c outside the three and NaN", () => {
    const withMessage = clone(refused) as unknown as { items: { read: Record<string, unknown> } };
    withMessage.items.read.message = "Metering provider is not available.";
    expect(parses(withMessage)).toBe(false);
    const hypothesis = clone(full);
    (hypothesis.items.summary as { c: string }).c = "hypothesis";
    expect(parses(hypothesis)).toBe(false);
    const nan = clone(full);
    nan.items.series.loadW![3] = NaN;
    expect(parses(nan)).toBe(false);
    const infinite = clone(full);
    infinite.items.summary.darkMin = Infinity;
    expect(parses(infinite)).toBe(false);
  });

  it("refuses an id outside the stored format, and a device key that is not uuid-shaped", () => {
    for (const component of [" ess0", "ess/0", "e".repeat(65)]) {
      const bad = clone(full);
      (bad.items.src_battery as { component: string }).component = component;
      expect(parses(bad), component).toBe(false);
    }
    const badKey = clone(full) as unknown as { items: { meter_readings: Record<string, unknown> } };
    badKey.items.meter_readings["m-1"] = { component: "meter9", start: null, end: null };
    expect(parses(badKey)).toBe(false);
    const badDevice = clone(full);
    (badDevice.items.src_grid as { device: string }).device = "m-1";
    expect(parses(badDevice)).toBe(false);
  });

  it("accepts a seed-style device id wherever a device id goes", () => {
    const seed = "d0000000-0000-0000-0000-000000000001";
    expect((full.items.src_battery as { device: string }).device).toBe(seed);
    const s = clone(full) as unknown as {
      items: { meter_readings: Record<string, unknown>; meter_outcomes: Record<string, unknown>; m_unreadable: { devices: string[] } };
    };
    s.items.meter_readings[seed.replace(/1$/, "9")] = { component: "meter9", start: null, end: null };
    s.items.meter_outcomes[seed.replace(/1$/, "9")] = "no_start";
    s.items.m_unreadable.devices = [seed];
    expect(parses(s)).toBe(true);
  });

  it("refuses a pointer outside the grammar, or one that does not resolve to its value", () => {
    for (const ptr of ["/items/series/loadW/3", "/items/carry_in/soc/0", "/items/series/soc/01", "/x", "#/items/series/soc/3"]) {
      const bad = clone(full);
      (bad.items.dark_cut as { decidedBy: { ptr: string }[] }).decidedBy[0].ptr = ptr;
      expect(parses(bad), ptr).toBe(false);
    }
    const wrongValue = clone(full);
    (wrongValue.items.dark_cut as { decidedBy: { v: number }[] }).decidedBy[0].v = 12;
    expect(parses(wrongValue)).toBe(false);
  });

  it("refuses misaligned decidedBy and a min that is not the ranges' sum", () => {
    const misaligned = clone(full);
    (misaligned.items.dark_cut as { decidedBy: unknown[] }).decidedBy.push({ ptr: "/items/series/gridV/201", v: 0 });
    expect(parses(misaligned)).toBe(false);
    const min = clone(full);
    (min.items.no_data as { min: number }).min += 5;
    expect(parses(min)).toBe(false);
  });

  it("refuses a code §6 does not name, or a reason that is not the code's", () => {
    const code = clone(refused);
    code.items.read.from.code = "SOMETHING_ELSE";
    expect(parses(code)).toBe(false);
    const reason = clone(refused);
    reason.items.read.reason = "provider_invalid_data";
    expect(parses(reason)).toBe(false);
  });

  it("keeps values unrounded through a JSON round trip", () => {
    const s = clone(full);
    s.items.series.loadW![4] = 2.9850000000000003;
    s.items.summary.tenantMetersEveningKwh = 0.1 + 0.2;
    const back = JSON.parse(JSON.stringify(s));
    expect(back).toEqual(s);
    expect(back.items.series.loadW[4]).toBe(2.9850000000000003);
    expect(parses(back)).toBe(true);
  });
});

describe("buildSiteDaySnapshot — resolution", () => {
  it("throws a resolution defect for a day not in 5-minute bins", () => {
    const rows = new Map<number, Row>();
    fill(rows, 0, 95, { volts: 230, soc: 60 });
    const { input } = evidenceOf(rows, { resolutionMinutes: 15 });
    expect(input.day.resolutionMinutes).toBe(15);
    expect(() => buildSiteDaySnapshot(input)).toThrow(
      expect.objectContaining({ check: "resolution", path: "/window/res" })
    );
  });
});

describe("schemaDefect — no id or value in a defect", () => {
  it("names the device key's place, never the device", () => {
    const s = example().snapshot();
    const changed = clone(s) as unknown as { items: { meter_readings: Record<string, Record<string, unknown>> } };
    changed.items.meter_readings[D2].note = "counter replaced";
    const parsed = siteDayEvidenceReadSchema.safeParse(changed);
    expect(parsed.success).toBe(false);
    const defect = schemaDefect(parsed.error!);
    expect(defect.check).toBe("schema");
    expect(defect.path).toBe("/items/meter_readings/<device>");
    expect(defect.issue).toBe("unrecognized_keys");
    for (const text of [defect.message, defect.path, String(defect.issue)]) {
      expect(text).not.toContain(D2);
      expect(text).not.toContain("note");
      expect(text).not.toContain("counter replaced");
    }
  });

  it("normalises indexes and unknown keys", () => {
    expect(normaliseEvidencePath(["items", "series", "soc", 12])).toBe("/items/series/soc/[]");
    expect(normaliseEvidencePath(["items", "meter_outcomes", D1])).toBe("/items/meter_outcomes/<device>");
    expect(normaliseEvidencePath(["items", "meter_readings", "c"])).toBe("/items/meter_readings/c");
    expect(normaliseEvidencePath(["items", "m_unreadable", "devices", 0])).toBe("/items/m_unreadable/devices/[]");
    expect(normaliseEvidencePath(["items", D1])).toBe("/items/<key>");
    expect(normaliseEvidencePath([])).toBe("/");
  });
});

describe("item keys", () => {
  it("restate evidence §4's key table", () => {
    expect(SITE_DAY_ITEM_KEYS).toEqual([
      "src_battery", "src_grid", "src_load", "src_pv", "carry_in", "series", "timestamps",
      "dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data",
      "meter_window", "meter_readings", "meter_outcomes", "m_unreadable", "m_id_not_storable",
      "summary", "read",
    ]);
  });

  it("reads meter entries without c and k", () => {
    const s = example().snapshot();
    expect(meterEntries(s.items.meter_outcomes)).toEqual([
      [D2, "backwards"],
      [D3, "no_end"],
    ]);
  });
});
