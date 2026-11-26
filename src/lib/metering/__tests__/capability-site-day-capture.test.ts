import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeteringCapability } from "../capability";
import { MeteringError } from "../errors";
import { generateSiteSamples } from "../fixture/site-samples";
import { MeteringRegistry } from "../registry";
import type { ManagedDevice, MeteringConnection, MeteringRepository, MeteringScope } from "../repository";
import {
  SITE_DAY_CALC_VERSION,
  type SiteDayRead,
} from "../site-operations";
import {
  SiteDayEvidenceDefect,
  siteDayEvidenceSchema,
  type SiteDayCapture,
  type SiteDayEvidenceRead,
  type SiteDayWindow,
} from "../site-day-evidence";
import type { MeteringProvider, SiteSamples, SiteSamplesRequest } from "../types";

/**
 * The builder as captureSiteDay imports it, passed through unless a test
 * sets `override`, which sees the input and may change what it returns or
 * throw.
 */
const builder = vi.hoisted(() => ({
  override: null as
    | null
    | ((build: () => SiteDayEvidenceRead) => SiteDayEvidenceRead),
}));
vi.mock("../site-day-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../site-day-evidence")>();
  return {
    ...actual,
    buildSiteDaySnapshot: (input: Parameters<typeof actual.buildSiteDaySnapshot>[0]) =>
      builder.override ? builder.override(() => actual.buildSiteDaySnapshot(input)) : actual.buildSiteDaySnapshot(input),
  };
});

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ORG_ID = "550e8400-e29b-41d4-a716-446655440001";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
/** Seed-style (not an RFC 9562 version), as the dev seed's device ids are. */
const BATTERY_ID = "d0000000-0000-0000-0000-000000000001";
const BATTERY_2_ID = "660e8400-e29b-41d4-a716-44665544b002";
const GRID_ID = "660e8400-e29b-41d4-a716-44665544a001";
const INVERTER_ID = "660e8400-e29b-41d4-a716-44665544e001";
const METER_1 = "660e8400-e29b-41d4-a716-44665544d001";
const METER_2 = "660e8400-e29b-41d4-a716-44665544d002";
const METER_3 = "660e8400-e29b-41d4-a716-44665544d003";
const EDGE = "SYNTHETIC-EDGE-CAPTURE";

/** 22:30 UTC on 6 November is 01:30 on 7 November in Kampala (UTC+3). */
const NOW = new Date("2026-11-06T22:30:00Z");
const DATE = "2026-11-05";
const WINDOW: SiteDayWindow = { date: DATE, tz: "Africa/Kampala", zone: "microgrid" };
const KAMPALA = { tz: "Africa/Kampala", zone: "microgrid" } as const;

const scope: MeteringScope = { organizationId: ORG_ID, userId: "user-1", roles: [] };

function device(overrides: Partial<ManagedDevice> & { id: string }): ManagedDevice {
  return {
    name: "Device",
    edgeId: "edge-1",
    deviceType: "consumption_meter",
    edgeOpenemsId: EDGE,
    componentId: "meter0",
    ...overrides,
  };
}

const SITE_DEVICES: ManagedDevice[] = [
  device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "ess0" }),
  device({ id: GRID_ID, name: "Grid", deviceType: "grid_meter", componentId: "meter0" }),
  device({ id: INVERTER_ID, name: "Inverter", deviceType: "inverter", componentId: "inverter0" }),
  device({ id: METER_1, name: "Meter 01", componentId: "meter1" }),
  device({ id: METER_2, name: "Meter 02", componentId: "meter2" }),
];

function stubRepo(overrides: Partial<MeteringRepository> = {}): MeteringRepository {
  return {
    getAuthenticatedUserId: async () => "user-1",
    getUserRoles: async () => [],
    isPluginEnabled: async () => true,
    getMicrogridOrganization: async (id: string) =>
      id === MG_ID ? { microgridId: MG_ID, communityId: "comm-1", orgId: ORG_ID } : null,
    getTenantOrganization: async () => null,
    getDeviceOrganization: async () => null,
    getStoredConnection: async () => null,
    getMicrogridTimezone: async () => "Africa/Kampala",
    getManagedDevices: async () => SITE_DEVICES,
    getHouseMeterIds: async () => [METER_1, METER_2],
    getMicrogridEdges: async () => [],
    getKnownEdgeIds: async () => [],
    getAssignmentLinks: async () => [],
    insertMeterReading: async () => ({ id: "reading-1", error: null }),
    findMeterReadingAt: async () => null,
    ...overrides,
  };
}

function stubConnection(): MeteringConnection {
  return {
    testStored: async () => ({ ok: true, edgeCount: 0, edges: [] }),
    testCandidate: async () => ({ ok: true, edgeCount: 0, edges: [] }),
    discover: async () => [],
  };
}

type SiteSamplesFn = (request: SiteSamplesRequest) => Promise<SiteSamples>;

function setup(
  options: {
    repo?: Partial<MeteringRepository>;
    /** `null` registers a provider without `getSiteSamples`. */
    getSiteSamples?: SiteSamplesFn | null;
    active?: boolean;
    providerName?: string;
    selectProvider?: (microgridId: string) => Promise<string>;
  } = {}
) {
  const registry = new MeteringRegistry();
  const getSiteSamples = vi.fn<SiteSamplesFn>(
    options.getSiteSamples ?? (async (request) => generateSiteSamples(request))
  );
  const getReadings = vi.fn(async () => []);
  const provider: MeteringProvider =
    options.getSiteSamples === null ? { getReadings } : { getReadings, getSiteSamples, synthetic: true };
  const name = options.providerName ?? "synthetic";
  registry.register(name, provider);
  const capability = new MeteringCapability(
    stubRepo(options.repo),
    scope,
    registry,
    stubConnection(),
    () => options.active ?? true,
    options.selectProvider ?? (async () => name)
  );
  return { capability, getSiteSamples };
}

const query = (date = DATE) => ({ microgrid_id: MG_ID, date });

function refused(capture: SiteDayCapture) {
  if (capture.outcome !== "refused") throw new Error(`Expected a refusal, got ${capture.outcome}`);
  expect(siteDayEvidenceSchema.safeParse(capture.snapshot).success).toBe(true);
  return capture;
}

function read(capture: SiteDayCapture) {
  if (capture.outcome !== "read") {
    throw new Error(`Expected a read, got ${capture.outcome} ${JSON.stringify(capture).slice(0, 300)}`);
  }
  expect(siteDayEvidenceSchema.safeParse(capture.snapshot).success).toBe(true);
  return capture;
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  builder.override = null;
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  errorLog.mockRestore();
});

describe("MeteringCapability.captureSiteDay — a read", () => {
  it("returns getSiteDay's day, and a snapshot whose figures are the day's", async () => {
    const { capability } = setup();
    const capture = read(await capability.captureSiteDay(query(), WINDOW));
    const page = await capability.getSiteDay(query());
    if (!page.ok) throw new Error(page.code);
    expect(capture.day).toEqual(page.data);
    expect(capture.zoneRead).toEqual(KAMPALA);
    expect(capture.endedBeforeDay).toBe(false);
    const s = capture.snapshot;
    expect(s.by).toEqual({ calc: SITE_DAY_CALC_VERSION, provider: "synthetic" });
    expect(s.window).toMatchObject({ date: DATE, tz: "Africa/Kampala", zone: "microgrid", t0: page.data.dayStartMs, bins: 288 });
    const day: SiteDayRead = page.data;
    const figures = {
      darkMin: day.darkMinutes,
      darkInferredMin: day.darkInferredMinutes,
      noDataMin: day.noDataMinutes,
      knownMin: day.knownMinutes,
      lightsOnPct: day.lightsOnPct,
      cutMin: day.cutMinutes,
      tenantMetersEveningKwh: day.housesEveningKwh,
      metersLeftOut: day.housesEveningMetersMissing,
    };
    for (const [key, value] of Object.entries(s.items.summary)) {
      if (key === "c" || key === "k" || value === null) continue;
      expect(value, key).toBe(figures[key as keyof typeof figures]);
    }
    expect(s.items.src_battery).toEqual({
      c: "fact", k: "source", type: "battery", device: BATTERY_ID, edge: EDGE, component: "ess0",
    });
    expect(s.items.src_pv).toEqual({ c: "unavailable", k: "source", type: "pv_meter", reason: "source_not_readable" });
    expect(Object.keys(s.items.meter_readings).sort()).toEqual(["c", "k", METER_1, METER_2].sort());
    expect(s.items.meter_readings[METER_1]).toMatchObject({ component: "meter1" });
    expect(s.items.timestamps).toEqual({ c: "unavailable", k: "timestamps", reason: "not_reported" });
  });

  it("counts a meter the provider leaves out as missing", async () => {
    const { capability } = setup({
      getSiteSamples: async (request) => {
        const samples = generateSiteSamples(request);
        delete samples.houseEnergyWh[METER_2];
        return { ...samples, unreadableTimestamps: 0 };
      },
    });
    const s = read(await capability.captureSiteDay(query(), WINDOW)).snapshot;
    expect(s.items.meter_readings[METER_2]).toEqual({ component: "meter2", start: null, end: null });
    expect(s.items.meter_outcomes[METER_2]).toBe("no_start");
    expect(s.items.summary.metersLeftOut).toBe(1);
    expect(s.items.timestamps).toEqual({ c: "fact", k: "timestamps", dropped: 0 });
  });
});

describe("MeteringCapability.captureSiteDay — the format check, before reading", () => {
  it("records a battery outside the format as id_not_storable and does not ask for it", async () => {
    const devices = SITE_DEVICES.map((d) => (d.id === BATTERY_ID ? { ...d, componentId: "ess 0" } : d));
    const { capability, getSiteSamples } = setup({ repo: { getManagedDevices: async () => devices } });
    const s = read(await capability.captureSiteDay(query(), WINDOW)).snapshot;
    expect(s.items.src_battery).toEqual({ c: "unavailable", k: "source", type: "battery", reason: "id_not_storable" });
    expect(getSiteSamples.mock.calls[0][0].sources.battery).toBeNull();
    expect(s.items.series.soc).toBeNull();
  });

  it("reads a second battery with valid ids instead", async () => {
    const devices = [
      ...SITE_DEVICES.map((d) => (d.id === BATTERY_ID ? { ...d, name: "A battery", componentId: "ess 0" } : d)),
      device({ id: BATTERY_2_ID, name: "B battery", deviceType: "battery", componentId: "ess1" }),
    ];
    const { capability, getSiteSamples } = setup({ repo: { getManagedDevices: async () => devices } });
    const s = read(await capability.captureSiteDay(query(), WINDOW)).snapshot;
    expect(s.items.src_battery).toMatchObject({ c: "fact", device: BATTERY_2_ID, component: "ess1" });
    expect(getSiteSamples.mock.calls[0][0].sources.battery?.id).toBe(BATTERY_2_ID);
  });

  it("lists a tenant meter outside the format, does not ask for it, and counts it as left out", async () => {
    const devices = [
      ...SITE_DEVICES.map((d) => (d.id === METER_2 ? { ...d, edgeOpenemsId: "edge/0" } : d)),
      // Padded: refused, untrimmed.
      device({ id: METER_3, name: "Meter 03", componentId: " meter3" }),
    ];
    const { capability, getSiteSamples } = setup({
      repo: { getManagedDevices: async () => devices, getHouseMeterIds: async () => [METER_1, METER_2, METER_3] },
    });
    const s = read(await capability.captureSiteDay(query(), WINDOW)).snapshot;
    expect(s.items.m_id_not_storable).toEqual({
      c: "unavailable", k: "meters", reason: "id_not_storable", devices: [METER_2, METER_3],
    });
    expect(getSiteSamples.mock.calls[0][0].sources.houseMeters.map((m) => m.id)).toEqual([METER_1]);
    expect(Object.keys(s.items.meter_readings)).toEqual(["c", "k", METER_1]);
    expect(s.items.summary.metersLeftOut).toBe(2);
  });

  it("keeps a meter missing its component id tenant_meter_unreadable, even with a bad edge id", async () => {
    const devices = SITE_DEVICES.map((d) => (d.id === METER_2 ? { ...d, edgeOpenemsId: "edge/0", componentId: "" } : d));
    const { capability } = setup({ repo: { getManagedDevices: async () => devices } });
    const s = read(await capability.captureSiteDay(query(), WINDOW)).snapshot;
    expect(s.items.m_unreadable).toMatchObject({ reason: "tenant_meter_unreadable", devices: [METER_2] });
    expect(s.items.m_id_not_storable).toBeUndefined();
  });

  it("leaves getSiteDay reading those devices", async () => {
    const devices = SITE_DEVICES.map((d) =>
      d.id === BATTERY_ID ? { ...d, componentId: "ess 0" } : d.id === METER_2 ? { ...d, edgeOpenemsId: "edge/0" } : d
    );
    const { capability, getSiteSamples } = setup({
      getSiteSamples: async (request) => generateSiteSamples({ ...request }),
      repo: { getManagedDevices: async () => devices },
    });
    const page = await capability.getSiteDay(query());
    expect(page.ok).toBe(true);
    const asked = getSiteSamples.mock.calls[0][0].sources;
    expect(asked.battery?.id).toBe(BATTERY_ID);
    expect(asked.houseMeters.map((m) => m.id)).toEqual([METER_1, METER_2]);
  });
});

describe("MeteringCapability.captureSiteDay — refusals, by stage", () => {
  it("records disposal as internal_error in the operation's window", async () => {
    const { capability } = setup({ active: false });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.zoneRead).toBeNull();
    expect(c.refusal).toEqual({ status: 500, code: "metering_composition_disposed" });
    expect(c.snapshot.window).toEqual({ date: DATE, tz: "Africa/Kampala", zone: "microgrid", res: 5 });
    expect(c.snapshot.by.provider).toBeNull();
    expect(c.snapshot.items).toEqual({
      read: { c: "unavailable", k: "read", reason: "internal_error", from: { status: 500, code: "metering_composition_disposed" } },
    });
  });

  it("records a query that is not an object as request_invalid", async () => {
    const { capability } = setup();
    const c = refused(await capability.captureSiteDay("not a query", WINDOW));
    expect(c.zoneRead).toBeNull();
    expect(c.snapshot.items.read).toMatchObject({ reason: "request_invalid", from: { status: 400, code: "metering_invalid_query" } });
    expect(c.snapshot.window.date).toBe(DATE);
  });

  it.each([
    ["not a calendar date", "2026-02-30"],
    ["another valid date than the window's", "2026-11-04"],
    ["after today", "2026-11-08"],
  ])("records %s as request_invalid, in the window's date and the zone read", async (_label, date) => {
    const { capability, getSiteSamples } = setup();
    const c = refused(await capability.captureSiteDay(query(date), WINDOW));
    expect(c.zoneRead).toEqual(KAMPALA);
    expect(c.snapshot.items).toEqual({
      read: { c: "unavailable", k: "read", reason: "request_invalid", from: { status: 422, code: "metering_invalid_date" } },
    });
    expect(c.snapshot.window.date).toBe(DATE);
    expect(c.snapshot.by.provider).toBeNull();
    expect(getSiteSamples).not.toHaveBeenCalled();
  });

  it("returns a scope mismatch as an access refusal, with no snapshot", async () => {
    const { capability } = setup({
      repo: {
        getMicrogridOrganization: async () => ({ microgridId: MG_ID, communityId: "comm-1", orgId: OTHER_ORG_ID }),
      },
    });
    expect(await capability.captureSiteDay(query(), WINDOW)).toEqual({
      outcome: "access_refused",
      status: 403,
      code: "metering_scope_mismatch",
    });
  });

  it("records the plugin off as metering_disabled, before the zone read", async () => {
    const getMicrogridTimezone = vi.fn(async () => "Africa/Kampala");
    const { capability } = setup({ repo: { isPluginEnabled: async () => false, getMicrogridTimezone } });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.zoneRead).toBeNull();
    expect(c.snapshot.items.read).toMatchObject({ reason: "metering_disabled", from: { status: 409, code: "metering_disabled" } });
    expect(getMicrogridTimezone).not.toHaveBeenCalled();
  });

  it("records an unreadable plugin state as gate_unavailable", async () => {
    const { capability } = setup({
      repo: {
        isPluginEnabled: async () => {
          throw new Error("connection reset");
        },
      },
    });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.snapshot.items.read).toMatchObject({ reason: "gate_unavailable", from: { status: 503, code: "metering_gate_unavailable" } });
    expect(c.zoneRead).toBeNull();
  });

  it("records a failed zone read as zone_unavailable, in the operation's zone", async () => {
    const window: SiteDayWindow = { date: DATE, tz: "UTC", zone: "fallback" };
    const { capability } = setup({
      repo: {
        getMicrogridTimezone: async () => {
          throw new Error("timeout");
        },
      },
    });
    const c = refused(await capability.captureSiteDay(query(), window));
    expect(c.zoneRead).toBeNull();
    expect(c.snapshot.window).toEqual({ date: DATE, tz: "UTC", zone: "fallback", res: 5, caveat: ["zone_fallback"] });
    expect(c.snapshot.items.read).toMatchObject({ reason: "zone_unavailable" });
  });

  it("records mixed edges as mixed_edges, with no provider", async () => {
    const { capability } = setup({
      selectProvider: async () => {
        throw new MeteringError("mixed", "METERING_CONFIGURATION", 409);
      },
    });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.zoneRead).toEqual(KAMPALA);
    expect(c.snapshot.by.provider).toBeNull();
    expect(c.snapshot.items).toEqual({
      read: { c: "unavailable", k: "read", reason: "mixed_edges", from: { status: 409, code: "METERING_CONFIGURATION" } },
    });
  });

  it("records a provider without site samples as provider_unsupported, with its name", async () => {
    const { capability } = setup({ getSiteSamples: null, providerName: "openems" });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.snapshot.by.provider).toBe("openems");
    expect(c.snapshot.items.read).toMatchObject({ reason: "provider_unsupported" });
    expect(Object.keys(c.snapshot.items)).toEqual(["read"]);
  });

  it("records a failed device read as site_devices_unavailable, with no sources", async () => {
    const { capability } = setup({
      repo: {
        getManagedDevices: async () => {
          throw new Error("timeout");
        },
      },
    });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.snapshot.items).toEqual({
      read: {
        c: "unavailable", k: "read", reason: "site_devices_unavailable",
        from: { status: 503, code: "metering_site_devices_unavailable" },
      },
    });
    expect(c.snapshot.by.provider).toBe("synthetic");
  });

  it("records no battery or grid meter as no_site_devices, with the four sources", async () => {
    const devices = SITE_DEVICES.filter((d) => d.deviceType !== "battery" && d.deviceType !== "grid_meter");
    const { capability, getSiteSamples } = setup({ repo: { getManagedDevices: async () => devices } });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(Object.keys(c.snapshot.items)).toEqual(["src_battery", "src_grid", "src_load", "src_pv", "read"]);
    expect(c.snapshot.items.src_battery).toMatchObject({ c: "unavailable", reason: "source_not_readable" });
    expect(c.snapshot.items.src_load).toMatchObject({ c: "fact", device: INVERTER_ID });
    expect(c.snapshot.items.read).toMatchObject({ reason: "no_site_devices", from: { status: 404, code: "metering_no_site_devices" } });
    expect(getSiteSamples).not.toHaveBeenCalled();
  });

  it("records a provider outage as provider_unavailable, with the sources", async () => {
    const { capability } = setup({
      getSiteSamples: async () => {
        throw new MeteringError("down", "METERING_UNAVAILABLE", 502);
      },
    });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.snapshot.items.read).toEqual({
      c: "unavailable", k: "read", reason: "provider_unavailable", from: { status: 503, code: "METERING_UNAVAILABLE" },
    });
    expect(c.snapshot.items.src_grid).toMatchObject({ c: "fact", device: GRID_ID });
    expect(c.refusal).toEqual({ status: 503, code: "METERING_UNAVAILABLE" });
  });

  it("records a computation that throws as calculation_failed", async () => {
    const { capability } = setup({
      getSiteSamples: async () => {
        throw new RangeError("no such day");
      },
    });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.snapshot.items.read).toMatchObject({
      reason: "calculation_failed",
      from: { status: 500, code: "metering_site_day_failed" },
    });
    expect(c.defect).toBeUndefined();
  });

  it("carries the zone_fallback caveat on a refusal after the zone read", async () => {
    const window: SiteDayWindow = { date: "2026-11-05", tz: "UTC", zone: "fallback" };
    const { capability } = setup({
      repo: {
        getMicrogridTimezone: async () => null,
        getManagedDevices: async () => {
          throw new Error("timeout");
        },
      },
    });
    const c = refused(await capability.captureSiteDay(query(), window));
    expect(c.zoneRead).toEqual({ tz: "UTC", zone: "fallback" });
    expect(c.snapshot.window).toEqual({ date: "2026-11-05", tz: "UTC", zone: "fallback", res: 5, caveat: ["zone_fallback"] });
  });
});

describe("MeteringCapability.captureSiteDay — a read that ends before the day", () => {
  it("is ended before the day today at 17:00, with meter_window's bounds null", async () => {
    // 17:00 on 7 November in Kampala.
    vi.setSystemTime(new Date("2026-11-07T14:00:00Z"));
    const { capability } = setup();
    const c = read(await capability.captureSiteDay(query("2026-11-07"), { ...WINDOW, date: "2026-11-07" }));
    expect(c.endedBeforeDay).toBe(true);
    expect(c.snapshot.items.meter_window).toEqual({ c: "calculated", k: "meter_window", start: null, end: null });
    expect(c.snapshot.window.bins).toBeLessThan(288);
  });

  it("is ended before the day one minute after midnight", async () => {
    // 00:01 on 7 November in Kampala: 6 November's last bin is not yet read.
    vi.setSystemTime(new Date("2026-11-06T21:01:00Z"));
    const { capability } = setup();
    const c = read(await capability.captureSiteDay(query("2026-11-06"), { ...WINDOW, date: "2026-11-06" }));
    expect(c.endedBeforeDay).toBe(true);
    expect(c.snapshot.window.bins).toBe(287);
  });

  it("is not on a finished day", async () => {
    const { capability } = setup();
    expect(read(await capability.captureSiteDay(query(), WINDOW)).endedBeforeDay).toBe(false);
  });
});

describe("MeteringCapability.captureSiteDay — MGM's defects are recorded", () => {
  it("records a provider name §4 does not name", async () => {
    const { capability } = setup({ providerName: "acme" });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.defect).toEqual({ check: "provider_name", path: "/by/provider" });
    expect(c.snapshot.by.provider).toBeNull();
    expect(c.snapshot.items.read).toEqual({
      c: "unavailable", k: "read", reason: "calculation_failed", from: { status: 500, code: "metering_site_day_failed" },
    });
    expect(Object.keys(c.snapshot.items)).toEqual(["src_battery", "src_grid", "src_load", "src_pv", "read"]);
    expect(c.zoneRead).toEqual(KAMPALA);
  });

  it("records the builder's pointer check", async () => {
    builder.override = () => {
      throw new SiteDayEvidenceDefect("pointer", "/items/dark_cut/decidedBy/[]");
    };
    const { capability } = setup();
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.defect).toEqual({ check: "pointer", path: "/items/dark_cut/decidedBy/[]" });
    expect(c.snapshot.items.read).toMatchObject({ reason: "calculation_failed" });
    expect(c.snapshot.by.provider).toBe("synthetic");
  });

  it("records a built snapshot with a pointer that does not resolve as a schema defect", async () => {
    builder.override = (build) => {
      const s = build();
      s.items.no_data = {
        c: "calculated", k: "no_data", ranges: [[0, 5]], min: 5,
        ruledOut: [{ grid: { ptr: "/items/series/gridV/3", v: -1 }, soc: null }],
      };
      return s;
    };
    const { capability } = setup();
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.defect).toMatchObject({ check: "schema", path: "/items/no_data/ruledOut/[]/grid" });
    expect(c.snapshot.items.read).toMatchObject({ reason: "calculation_failed" });
  });

  it("falls back to the operation's window with no sources when a source fails the schema", async () => {
    const devices = SITE_DEVICES.map((d) => (d.id === BATTERY_ID ? { ...d, id: "m-1" } : d));
    const { capability } = setup({ repo: { getManagedDevices: async () => devices } });
    const c = refused(await capability.captureSiteDay(query(), WINDOW));
    expect(c.defect).toEqual({ check: "schema", path: "/items/src_battery/device", issue: "invalid_format" });
    expect(c.snapshot.items).toEqual({
      read: { c: "unavailable", k: "read", reason: "calculation_failed", from: { status: 500, code: "metering_site_day_failed" } },
    });
    expect(c.snapshot.by.provider).toBeNull();
    expect(c.snapshot.window).toEqual({ date: DATE, tz: "Africa/Kampala", zone: "microgrid", res: 5 });
    // Nothing from the content reaches the log.
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("m-1");
  });

  it("throws only when the operation's window itself is not valid", async () => {
    const { capability } = setup({ repo: { isPluginEnabled: async () => false } });
    await expect(
      capability.captureSiteDay(query(), { date: "x", tz: "Africa/Kampala", zone: "microgrid" })
    ).rejects.toBeInstanceOf(SiteDayEvidenceDefect);
    await expect(
      capability.captureSiteDay(query(), { date: DATE, tz: "Not/AZone", zone: "microgrid" })
    ).rejects.toMatchObject({ check: "schema", path: "/window/tz" });
  });
});
