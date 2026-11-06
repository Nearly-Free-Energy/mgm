import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeteringCapability, pickSiteSources } from "../capability";
import { MeteringRegistry } from "../registry";
import { MeteringError } from "../errors";
import type {
  ManagedDevice,
  MeteringConnection,
  MeteringRepository,
  MeteringScope,
} from "../repository";
import type { MeteringProvider, SiteSamples, SiteSamplesRequest } from "../types";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ORG_ID = "550e8400-e29b-41d4-a716-446655440001";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const BATTERY_ID = "660e8400-e29b-41d4-a716-44665544b001";
const GRID_ID = "660e8400-e29b-41d4-a716-44665544a001";
const PV_ID = "660e8400-e29b-41d4-a716-44665544c001";
const METER_ID = "660e8400-e29b-41d4-a716-44665544d001";

/**
 * 22:30 UTC on 6 November is 01:30 on 7 November in Kampala (UTC+3), so the
 * microgrid's "today" is a day ahead of UTC's.
 */
const NOW = new Date("2026-11-06T22:30:00Z");
const KAMPALA_TODAY = "2026-11-07";
const UTC_TODAY = "2026-11-06";

const scope: MeteringScope = {
  organizationId: ORG_ID,
  userId: "user-1",
  roles: [],
};

function device(overrides: Partial<ManagedDevice> & { id: string }): ManagedDevice {
  return {
    name: "Device",
    edgeId: "edge-1",
    deviceType: "consumption_meter",
    edgeOpenemsId: "edge0",
    componentId: "meter0",
    ...overrides,
  };
}

const SITE_DEVICES: ManagedDevice[] = [
  device({ id: METER_ID, name: "Meter 01", deviceType: "consumption_meter", componentId: "meter1" }),
  device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "ess0" }),
  device({ id: GRID_ID, name: "Grid", deviceType: "grid_meter", componentId: "meter0" }),
];

function stubRepo(overrides: Partial<MeteringRepository> = {}): MeteringRepository {
  return {
    getAuthenticatedUserId: async () => "user-1",
    getUserRoles: async () => [],
    isPluginEnabled: async () => true,
    getMicrogridOrganization: async (id: string) =>
      id === MG_ID
        ? { microgridId: MG_ID, communityId: "comm-1", orgId: ORG_ID }
        : null,
    getHouseholdOrganization: async () => null,
    getDeviceOrganization: async () => null,
    getStoredConnection: async () => null,
    getMicrogridTimezone: async () => "Africa/Kampala",
    getManagedDevices: async () => SITE_DEVICES,
    getHouseMeterIds: async () => [],
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

function emptySamples(): SiteSamples {
  return {
    timestamps: [],
    batterySocPct: [],
    batteryPowerW: [],
    gridPowerW: [],
    gridVoltageV: [],
    loadPowerW: [],
    pvPowerW: [],
    houseEnergyWh: {},
  };
}

type SiteSamplesFn = (request: SiteSamplesRequest) => Promise<SiteSamples>;

function setup(
  options: {
    repo?: Partial<MeteringRepository>;
    /** `null` registers a provider without `getSiteSamples`; `"none"` registers nothing. */
    getSiteSamples?: SiteSamplesFn | null | "none";
    active?: boolean;
  } = {}
) {
  const registry = new MeteringRegistry();
  const getSiteSamples = vi.fn<SiteSamplesFn>(async () => emptySamples());
  const getReadings = vi.fn(async () => []);
  if (options.getSiteSamples !== "none") {
    const provider: MeteringProvider =
      options.getSiteSamples === null
        ? { getReadings }
        : {
            getReadings,
            getSiteSamples: options.getSiteSamples
              ? getSiteSamples.mockImplementation(options.getSiteSamples)
              : getSiteSamples,
          };
    registry.register("openems", provider);
  }
  const repo = stubRepo(options.repo);
  const capability = new MeteringCapability(
    repo,
    scope,
    registry,
    stubConnection(),
    () => options.active ?? true
  );
  return { capability, registry, getSiteSamples, repo };
}

describe("MeteringCapability.getSiteDay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("query shape", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a string", "2026-11-01"],
      ["a number", 42],
      ["an array", [MG_ID, "2026-11-01"]],
    ])("answers 400 metering_invalid_query for %s", async (_label, query) => {
      const { capability, registry, getSiteSamples } = setup();
      const resolve = vi.spyOn(registry, "resolve");
      const result = await capability.getSiteDay(query);
      expect(result).toMatchObject({
        ok: false,
        status: 400,
        code: "metering_invalid_query",
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it.each([
      ["not a UUID", "mg-1"],
      ["missing", undefined],
      ["not a string", 12345],
    ])("answers 400 metering_invalid_microgrid when the id is %s", async (_label, microgridId) => {
      const getMicrogridOrganization = vi.fn(async () => null);
      const { capability } = setup({ repo: { getMicrogridOrganization } });
      const result = await capability.getSiteDay({ microgrid_id: microgridId, date: "2026-11-01" });
      expect(result).toMatchObject({
        ok: false,
        status: 400,
        code: "metering_invalid_microgrid",
      });
      expect(getMicrogridOrganization).not.toHaveBeenCalled();
    });
  });

  describe("scope and plugin gate", () => {
    it("answers 403 metering_scope_mismatch for a microgrid in another organization", async () => {
      const getManagedDevices = vi.fn(async () => SITE_DEVICES);
      const { capability, getSiteSamples } = setup({
        repo: {
          getMicrogridOrganization: async () => ({
            microgridId: MG_ID,
            communityId: "comm-1",
            orgId: OTHER_ORG_ID,
          }),
          getManagedDevices,
        },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({
        ok: false,
        status: 403,
        code: "metering_scope_mismatch",
      });
      expect(getManagedDevices).not.toHaveBeenCalled();
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 403 metering_scope_mismatch for an unknown microgrid", async () => {
      const { capability } = setup();
      const result = await capability.getSiteDay({
        microgrid_id: "660e8400-e29b-41d4-a716-446655440099",
        date: "2026-11-01",
      });
      expect(result).toMatchObject({ ok: false, status: 403, code: "metering_scope_mismatch" });
    });

    it("answers 409 metering_disabled and reads nothing more when the plugin is disabled", async () => {
      const isPluginEnabled = vi.fn(async () => false);
      const getMicrogridTimezone = vi.fn(async () => "Africa/Kampala");
      const getManagedDevices = vi.fn(async () => SITE_DEVICES);
      const getHouseMeterIds = vi.fn(async () => [METER_ID]);
      const { capability, registry, getSiteSamples } = setup({
        repo: { isPluginEnabled, getMicrogridTimezone, getManagedDevices, getHouseMeterIds },
      });
      const resolve = vi.spyOn(registry, "resolve");
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({ ok: false, status: 409, code: "metering_disabled" });
      expect(isPluginEnabled).toHaveBeenCalledWith(ORG_ID);
      expect(getMicrogridTimezone).not.toHaveBeenCalled();
      expect(getManagedDevices).not.toHaveBeenCalled();
      expect(getHouseMeterIds).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 503 metering_gate_unavailable and reads nothing more when plugin state cannot be read", async () => {
      const isPluginEnabled = vi.fn(async () => {
        throw new Error("canceling statement due to statement timeout");
      });
      const getMicrogridTimezone = vi.fn(async () => "Africa/Kampala");
      const getManagedDevices = vi.fn(async () => SITE_DEVICES);
      const { capability, registry, getSiteSamples } = setup({
        repo: { isPluginEnabled, getMicrogridTimezone, getManagedDevices },
      });
      const resolve = vi.spyOn(registry, "resolve");
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({ ok: false, status: 503, code: "metering_gate_unavailable" });
      expect(isPluginEnabled).toHaveBeenCalledWith(ORG_ID);
      expect(getMicrogridTimezone).not.toHaveBeenCalled();
      expect(getManagedDevices).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 500 metering_composition_disposed and touches nothing once disposed", async () => {
      const getMicrogridOrganization = vi.fn(async () => ({
        microgridId: MG_ID,
        communityId: "comm-1",
        orgId: ORG_ID,
      }));
      const isPluginEnabled = vi.fn(async () => true);
      const { capability, getSiteSamples } = setup({
        repo: { getMicrogridOrganization, isPluginEnabled },
        active: false,
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({
        ok: false,
        status: 500,
        code: "metering_composition_disposed",
      });
      expect(getMicrogridOrganization).not.toHaveBeenCalled();
      expect(isPluginEnabled).not.toHaveBeenCalled();
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("checks disposal before the query shape", async () => {
      const { capability } = setup({ active: false });
      const result = await capability.getSiteDay(null);
      expect(result).toMatchObject({ status: 500, code: "metering_composition_disposed" });
    });
  });

  describe("date validation", () => {
    it.each([
      ["a missing date", undefined],
      ["a non-string date", 20261101],
      ["an empty string", ""],
      ["a non-calendar day", "2026-02-30"],
      ["month 13", "2026-13-01"],
      ["an unpadded date", "2026-11-1"],
      ["a timestamp", "2026-11-01T00:00:00Z"],
      ["a day after the microgrid's today", "2026-11-08"],
      ["a far-future day", "2999-01-01"],
    ])("answers 422 metering_invalid_date for %s", async (_label, date) => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date });
      expect(result).toMatchObject({
        ok: false,
        status: 422,
        code: "metering_invalid_date",
        field: "date",
      });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("allows today in the microgrid's timezone even when UTC is still on the previous day", async () => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: KAMPALA_TODAY });
      expect(result.ok).toBe(true);
      expect(getSiteSamples).toHaveBeenCalledTimes(1);
      if (!result.ok) throw new Error("expected a site day");
      expect(result.data.date).toBe(KAMPALA_TODAY);
      expect(result.data.timezone).toBe("Africa/Kampala");
      // Today stops at the present rather than reading the rest of the day.
      expect(result.data.readUntilMs).toBeLessThanOrEqual(
        NOW.getTime() + 5 * 60_000
      );
      expect(result.data.readUntilMs).toBeLessThan(result.data.dayEndMs);
    });

    it("allows a past day", async () => {
      const { capability } = setup();
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-10-15" });
      expect(result.ok).toBe(true);
    });

    it("rejects the microgrid's today when the microgrid is in UTC and UTC is still a day behind", async () => {
      const { capability } = setup({ repo: { getMicrogridTimezone: async () => "UTC" } });
      expect(
        await capability.getSiteDay({ microgrid_id: MG_ID, date: KAMPALA_TODAY })
      ).toMatchObject({ ok: false, status: 422, code: "metering_invalid_date" });
      expect(
        (await capability.getSiteDay({ microgrid_id: MG_ID, date: UTC_TODAY })).ok
      ).toBe(true);
    });

    it.each([
      ["a city name", "Kampala"],
      ["an offset", "UTC+3"],
      ["an unknown zone", "Mars/OlympusMons"],
      ["an empty string", ""],
      ["null", null],
    ])("falls back to UTC when the stored timezone is %s", async (_label, stored) => {
      const { capability, getSiteSamples } = setup({
        repo: { getMicrogridTimezone: async () => stored },
      });
      // Under UTC, Kampala's today has not started yet.
      expect(
        await capability.getSiteDay({ microgrid_id: MG_ID, date: KAMPALA_TODAY })
      ).toMatchObject({ ok: false, status: 422, code: "metering_invalid_date" });

      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: UTC_TODAY });
      expect(result.ok).toBe(true);
      expect(getSiteSamples).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: "UTC", endDate: UTC_TODAY })
      );
      if (!result.ok) throw new Error("expected a site day");
      expect(result.data.timezone).toBe("UTC");
    });
  });

  describe("provider and devices", () => {
    it("answers 503 METERING_CONFIGURATION when the provider has no getSiteSamples", async () => {
      const { capability } = setup({ getSiteSamples: null });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({
        ok: false,
        status: 503,
        code: "METERING_CONFIGURATION",
      });
    });

    it("answers 503 METERING_CONFIGURATION when no openems provider is registered", async () => {
      const { capability } = setup({ getSiteSamples: "none" });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({
        ok: false,
        status: 503,
        code: "METERING_CONFIGURATION",
      });
    });

    it.each([
      ["no devices", []],
      [
        "only consumption meters and a solar meter",
        [
          device({ id: METER_ID, name: "Meter 01", deviceType: "consumption_meter" }),
          device({ id: PV_ID, name: "PV", deviceType: "pv_meter", componentId: "meter2" }),
        ],
      ],
      [
        "a battery and grid meter without OpenEMS identifiers",
        [
          device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "" }),
          device({ id: GRID_ID, name: "Grid", deviceType: "grid_meter", edgeOpenemsId: "" }),
        ],
      ],
    ])("answers 404 metering_no_site_devices with %s", async (_label, devices) => {
      const { capability, getSiteSamples } = setup({
        repo: { getManagedDevices: async () => devices as ManagedDevice[] },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({
        ok: false,
        status: 404,
        code: "metering_no_site_devices",
      });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("reads the day before as well, at 5-minute resolution, in the microgrid's timezone", async () => {
      const getManagedDevices = vi.fn(async () => SITE_DEVICES);
      const { capability, getSiteSamples } = setup({ repo: { getManagedDevices } });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result.ok).toBe(true);
      expect(getManagedDevices).toHaveBeenCalledWith(MG_ID);
      expect(getSiteSamples).toHaveBeenCalledTimes(1);
      expect(getSiteSamples).toHaveBeenCalledWith({
        microgridId: MG_ID,
        sources: pickSiteSources(SITE_DEVICES),
        startDate: "2026-10-31",
        endDate: "2026-11-01",
        timezone: "Africa/Kampala",
        resolutionMinutes: 5,
      });
      expect(getSiteSamples.mock.calls[0][0].sources).toEqual({
        battery: { id: BATTERY_ID, edgeOpenemsId: "edge0", componentId: "ess0" },
        gridMeter: { id: GRID_ID, edgeOpenemsId: "edge0", componentId: "meter0" },
        load: null,
        pv: null,
        houseMeters: [],
        houseMetersUnreadable: 0,
      });
    });

    it("steps back across a month and year boundary for the previous day", async () => {
      const { capability, getSiteSamples } = setup();
      await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-01-01" });
      expect(getSiteSamples).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: "2025-12-31", endDate: "2026-01-01" })
      );
      getSiteSamples.mockClear();
      await capability.getSiteDay({ microgrid_id: MG_ID, date: "2024-03-01" });
      expect(getSiteSamples).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: "2024-02-29", endDate: "2024-03-01" })
      );
    });

    it("reads with only a grid meter, and reports which sources were available", async () => {
      const devices = [
        device({ id: GRID_ID, name: "Grid", deviceType: "grid_meter", componentId: "meter0" }),
        device({ id: PV_ID, name: "PV", deviceType: "pv_meter", componentId: "meter2" }),
      ];
      const { capability, getSiteSamples } = setup({
        repo: { getManagedDevices: async () => devices },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      if (!result.ok) throw new Error(`expected a site day, got ${JSON.stringify(result)}`);
      expect(getSiteSamples.mock.calls[0][0].sources).toEqual({
        battery: null,
        gridMeter: { id: GRID_ID, edgeOpenemsId: "edge0", componentId: "meter0" },
        load: null,
        pv: { id: PV_ID, edgeOpenemsId: "edge0", componentId: "meter2" },
        houseMeters: [],
        houseMetersUnreadable: 0,
      });
      expect(result.data.sources).toEqual({
        battery: false,
        gridMeter: true,
        load: false,
        pv: true,
        houses: false,
        houseMetersUnreadable: 0,
      });
      expect(result.data.resolutionMinutes).toBe(5);
      expect(result.data.date).toBe("2026-11-01");
    });

    it("reads with only a battery", async () => {
      const devices = [
        device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "ess0" }),
      ];
      const { capability } = setup({ repo: { getManagedDevices: async () => devices } });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      if (!result.ok) throw new Error(`expected a site day, got ${JSON.stringify(result)}`);
      expect(result.data.sources).toEqual({
        battery: true,
        gridMeter: false,
        load: false,
        pv: false,
        houses: false,
        houseMetersUnreadable: 0,
      });
    });

    it("reads the house meters after the plugin gate and passes them to the provider", async () => {
      const order: string[] = [];
      const isPluginEnabled = vi.fn(async () => {
        order.push("gate");
        return true;
      });
      const getHouseMeterIds = vi.fn(async () => {
        order.push("houses");
        return [METER_ID];
      });
      const { capability, getSiteSamples } = setup({ repo: { isPluginEnabled, getHouseMeterIds } });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      if (!result.ok) throw new Error(`expected a site day, got ${JSON.stringify(result)}`);
      expect(getHouseMeterIds).toHaveBeenCalledWith(MG_ID, "2026-11-01");
      expect(order).toEqual(["gate", "houses"]);
      expect(getSiteSamples.mock.calls[0][0].sources.houseMeters).toEqual([
        { id: METER_ID, edgeOpenemsId: "edge0", componentId: "meter1" },
      ]);
      expect(result.data.sources.houses).toBe(true);
    });

    it("reports no houses when no device is a linked house meter", async () => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      if (!result.ok) throw new Error(`expected a site day, got ${JSON.stringify(result)}`);
      expect(getSiteSamples.mock.calls[0][0].sources.houseMeters).toEqual([]);
      expect(result.data.sources.houses).toBe(false);
      expect(result.data.housesEveningKwh).toBeNull();
    });

    it("still answers 404 with house meters but no battery or grid meter", async () => {
      const { capability, getSiteSamples } = setup({
        repo: {
          getManagedDevices: async () => [
            device({ id: METER_ID, name: "Meter 01", deviceType: "consumption_meter" }),
          ],
          getHouseMeterIds: async () => [METER_ID],
        },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({ ok: false, status: 404, code: "metering_no_site_devices" });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 503, not a site without household meters, when the meter links cannot be read", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { capability, getSiteSamples } = setup({
        repo: {
          getHouseMeterIds: async () => {
            throw new Error("Could not read household meter links: boom");
          },
        },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({
        ok: false,
        status: 503,
        code: "metering_site_devices_unavailable",
      });
      expect(getSiteSamples).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith("MGM site devices could not be read", {
        name: "Error",
        message: "Could not read household meter links: boom",
      });
      consoleSpy.mockRestore();
    });

    it("reports linked house meters that cannot be read", async () => {
      const { capability, getSiteSamples } = setup({
        repo: {
          getManagedDevices: async () => [
            ...SITE_DEVICES,
            device({ id: "m-no-comp", name: "Meter 02", componentId: "" }),
          ],
          getHouseMeterIds: async () => [METER_ID, "m-no-comp"],
        },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      if (!result.ok) throw new Error(`expected a site day, got ${JSON.stringify(result)}`);
      expect(getSiteSamples.mock.calls[0][0].sources.houseMeters).toHaveLength(1);
      expect(getSiteSamples.mock.calls[0][0].sources.houseMetersUnreadable).toBe(1);
      expect(result.data.sources).toMatchObject({ houses: true, houseMetersUnreadable: 1 });
    });

    it("counts houses when every linked meter is unreadable", async () => {
      const { capability } = setup({
        repo: {
          getManagedDevices: async () => [
            ...SITE_DEVICES.filter((d) => d.id !== METER_ID),
            device({ id: "m-no-edge", name: "Meter 02", edgeOpenemsId: "" }),
          ],
          getHouseMeterIds: async () => ["m-no-edge"],
        },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      if (!result.ok) throw new Error(`expected a site day, got ${JSON.stringify(result)}`);
      expect(result.data.sources).toMatchObject({ houses: true, houseMetersUnreadable: 1 });
    });

    it("feeds the provider's samples into the day", async () => {
      const dayStart = Date.parse("2026-10-31T21:00:00Z"); // 00:00 1 Nov in Kampala
      const samples: SiteSamples = {
        timestamps: [dayStart, dayStart + 5 * 60_000],
        batterySocPct: [80, 79],
        batteryPowerW: [100, 100],
        gridPowerW: [0, 0],
        gridVoltageV: [230, 230],
        loadPowerW: [null, null],
        pvPowerW: [null, null],
        houseEnergyWh: {},
      };
      const { capability } = setup({ getSiteSamples: async () => samples });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      if (!result.ok) throw new Error(`expected a site day, got ${JSON.stringify(result)}`);
      expect(result.data.dayStartMs).toBe(dayStart);
      expect(result.data.soc.slice(0, 2)).toEqual([
        { atMs: dayStart, pct: 80 },
        { atMs: dayStart + 5 * 60_000, pct: 79 },
      ]);
    });

    it.each([
      ["METERING_UNAUTHORIZED", 401],
      ["METERING_CONFIGURATION", 400],
      ["METERING_UNAVAILABLE", 503],
      ["METERING_INVALID_DATA", 422],
    ] as const)("maps a provider MeteringError %s (%i) to its status", async (code, status) => {
      const { capability } = setup({
        getSiteSamples: async () => {
          throw new MeteringError("provider said no", code, status);
        },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toEqual({
        ok: false,
        status,
        code,
        message: "provider said no",
      });
    });

    it("maps a MeteringError with an unlisted status to 503", async () => {
      const { capability } = setup({
        getSiteSamples: async () => {
          throw new MeteringError("teapot", "METERING_UNAVAILABLE", 418);
        },
      });
      const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
      expect(result).toMatchObject({ ok: false, status: 503, code: "METERING_UNAVAILABLE" });
    });

    describe("errors that are not MeteringErrors", () => {
      const FAILED = {
        ok: false,
        status: 500,
        code: "metering_site_day_failed",
        message: "This day's operations could not be worked out. Try another day.",
      };
      let consoleSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      });

      afterEach(() => {
        consoleSpy.mockRestore();
      });

      it("answers 500 metering_site_day_failed when the provider throws, and logs it", async () => {
        const { capability } = setup({
          getSiteSamples: async () => {
            throw new TypeError("boom");
          },
        });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result).toEqual(FAILED);
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy).toHaveBeenCalledWith("MGM site day could not be computed", {
          date: "2026-11-01",
          timezone: "Africa/Kampala",
          name: "TypeError",
          message: "boom",
        });
      });

      it("answers 500 metering_site_day_failed when the computation throws", async () => {
        // A provider answer without series makes computeSiteDay fail.
        const { capability } = setup({
          getSiteSamples: async () => ({}) as SiteSamples,
        });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result).toEqual(FAILED);
        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy.mock.calls[0][1]).toMatchObject({ name: "TypeError" });
      });

      it("logs a thrown non-Error value by its type without a message", async () => {
        const { capability } = setup({
          getSiteSamples: async () => {
            throw "plain string";
          },
        });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result).toEqual(FAILED);
        expect(consoleSpy).toHaveBeenCalledWith("MGM site day could not be computed", {
          date: "2026-11-01",
          timezone: "Africa/Kampala",
          name: "string",
          message: "non-Error thrown",
        });
      });

      it("does not log a MeteringError", async () => {
        const { capability } = setup({
          getSiteSamples: async () => {
            throw new MeteringError("down", "METERING_UNAVAILABLE", 503);
          },
        });
        await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(consoleSpy).not.toHaveBeenCalled();
      });
    });
  });
});

describe("pickSiteSources", () => {
  it("picks a battery, grid meter, inverter output (load) and solar meter by device type", () => {
    const devices = [
      device({ id: METER_ID, name: "Meter 01", deviceType: "consumption_meter", componentId: "meter1" }),
      device({ id: "inv-1", name: "Inverter", deviceType: "inverter", componentId: "inv0" }),
      device({ id: "other-1", name: "Other", deviceType: "other", componentId: "x0" }),
      device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "ess0" }),
      device({ id: GRID_ID, name: "Grid", deviceType: "grid_meter", componentId: "meter0", edgeOpenemsId: "edge7" }),
      device({ id: PV_ID, name: "PV", deviceType: "pv_meter", componentId: "meter2" }),
    ];
    expect(pickSiteSources(devices)).toEqual({
      battery: { id: BATTERY_ID, edgeOpenemsId: "edge0", componentId: "ess0" },
      gridMeter: { id: GRID_ID, edgeOpenemsId: "edge7", componentId: "meter0" },
      load: { id: "inv-1", edgeOpenemsId: "edge0", componentId: "inv0" },
      pv: { id: PV_ID, edgeOpenemsId: "edge0", componentId: "meter2" },
      houseMeters: [],
      houseMetersUnreadable: 0,
    });
  });

  it("returns all nulls when nothing matches", () => {
    const none = {
      battery: null,
      gridMeter: null,
      load: null,
      pv: null,
      houseMeters: [],
      houseMetersUnreadable: 0,
    };
    expect(pickSiteSources([])).toEqual(none);
    expect(
      pickSiteSources([device({ id: METER_ID, deviceType: "consumption_meter" })])
    ).toEqual(none);
  });

  it("picks every listed house meter with OpenEMS identifiers, by name then id", () => {
    const devices = [
      device({ id: "m-3", name: "Meter 02", componentId: "meter3" }),
      device({ id: "m-2", name: "Meter 01", componentId: "meter2" }),
      device({ id: "m-1", name: "Meter 01", componentId: "meter1" }),
      device({ id: "m-unlinked", name: "Meter 00", componentId: "meter9" }),
      device({ id: "m-no-comp", name: "Meter 00", componentId: "" }),
      device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "ess0" }),
    ];
    const sources = pickSiteSources(devices, ["m-3", "m-2", "m-1", "m-no-comp", "not-a-device"]);
    expect(sources.houseMeters).toEqual([
      { id: "m-1", edgeOpenemsId: "edge0", componentId: "meter1" },
      { id: "m-2", edgeOpenemsId: "edge0", componentId: "meter2" },
      { id: "m-3", edgeOpenemsId: "edge0", componentId: "meter3" },
    ]);
    expect(sources.houseMetersUnreadable).toBe(1);
    expect(sources.battery?.id).toBe(BATTERY_ID);
  });

  it("does not count a linked grid meter, inverter or battery as a house", () => {
    const devices = [
      device({ id: GRID_ID, name: "Grid", deviceType: "grid_meter", componentId: "meter0" }),
      device({ id: "inv-1", name: "Inverter", deviceType: "inverter", componentId: "inv0" }),
      device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "ess0" }),
      device({ id: METER_ID, name: "Meter 01", componentId: "meter1" }),
    ];
    const sources = pickSiteSources(devices, [GRID_ID, "inv-1", BATTERY_ID, METER_ID]);
    expect(sources.gridMeter?.id).toBe(GRID_ID);
    expect(sources.load?.id).toBe("inv-1");
    expect(sources.houseMeters).toEqual([
      { id: METER_ID, edgeOpenemsId: "edge0", componentId: "meter1" },
    ]);
    expect(sources.houseMetersUnreadable).toBe(0);
  });

  it("counts linked consumption meters without an edge or component id as unreadable", () => {
    const devices = [
      device({ id: "m-1", name: "Meter 01", componentId: "meter1" }),
      device({ id: "m-no-comp", name: "Meter 02", componentId: "" }),
      device({ id: "m-no-edge", name: "Meter 03", edgeOpenemsId: "" }),
      device({ id: "m-unlinked", name: "Meter 04", componentId: "" }),
    ];
    const sources = pickSiteSources(devices, ["m-1", "m-no-comp", "m-no-edge"]);
    expect(sources.houseMeters.map((m) => m.id)).toEqual(["m-1"]);
    expect(sources.houseMetersUnreadable).toBe(2);
  });

  it("ignores devices without a component id or an edge id", () => {
    const devices = [
      device({ id: "bat-no-comp", name: "A battery", deviceType: "battery", componentId: "" }),
      device({ id: "bat-no-edge", name: "B battery", deviceType: "battery", edgeOpenemsId: "" }),
      device({ id: BATTERY_ID, name: "C battery", deviceType: "battery", componentId: "ess0" }),
      device({ id: "grid-no-comp", name: "Grid", deviceType: "grid_meter", componentId: "" }),
    ];
    expect(pickSiteSources(devices)).toEqual({
      battery: { id: BATTERY_ID, edgeOpenemsId: "edge0", componentId: "ess0" },
      gridMeter: null,
      load: null,
      pv: null,
      houseMeters: [],
      houseMetersUnreadable: 0,
    });
  });

  it("picks the first device of a type by name, whatever order the devices arrive in", () => {
    const a = device({ id: "bat-a", name: "Battery A", deviceType: "battery", componentId: "ess0" });
    const b = device({ id: "bat-b", name: "Battery B", deviceType: "battery", componentId: "ess1" });
    const expected = { id: "bat-a", edgeOpenemsId: "edge0", componentId: "ess0" };
    expect(pickSiteSources([a, b]).battery).toEqual(expected);
    expect(pickSiteSources([b, a]).battery).toEqual(expected);
  });

  it("breaks a name tie by id", () => {
    const x = device({ id: "grid-2", name: "Grid", deviceType: "grid_meter", componentId: "meter2" });
    const y = device({ id: "grid-1", name: "Grid", deviceType: "grid_meter", componentId: "meter1" });
    expect(pickSiteSources([x, y]).gridMeter).toEqual({
      id: "grid-1",
      edgeOpenemsId: "edge0",
      componentId: "meter1",
    });
    expect(pickSiteSources([y, x]).gridMeter?.id).toBe("grid-1");
  });

  it("does not reorder the caller's array", () => {
    const devices = [
      device({ id: "z", name: "Zeta", deviceType: "battery", componentId: "ess1" }),
      device({ id: "a", name: "Alpha", deviceType: "battery", componentId: "ess0" }),
    ];
    pickSiteSources(devices);
    expect(devices.map((d) => d.id)).toEqual(["z", "a"]);
  });

  it("returns only the identifiers a provider needs", () => {
    const sources = pickSiteSources([
      device({ id: BATTERY_ID, name: "Battery", deviceType: "battery", componentId: "ess0" }),
    ]);
    expect(Object.keys(sources.battery ?? {}).sort()).toEqual(["componentId", "edgeOpenemsId", "id"]);
  });
});

describe("MeteringCapability.getSiteDays", () => {
  it("does not read house meters: the multi-day read values energy only", async () => {
    const getHouseMeterIds = vi.fn(async () => [METER_ID]);
    const { capability, getSiteSamples } = setup({ repo: { getHouseMeterIds } });
    const result = await capability.getSiteDays({
      microgrid_id: MG_ID,
      start_date: "2026-10-01",
      end_date: "2026-10-02",
    });
    expect(result.ok).toBe(true);
    expect(getHouseMeterIds).not.toHaveBeenCalled();
    expect(getSiteSamples.mock.calls[0][0].sources.houseMeters).toEqual([]);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const range = (start_date: unknown, end_date: unknown) => ({
    microgrid_id: MG_ID,
    start_date,
    end_date,
  });

  /** Kampala midnight (UTC+3) of a day key. */
  const kampalaMidnight = (date: string) => Date.parse(`${date}T00:00:00+03:00`);

  /**
   * One sample per day at local midnight whose state of charge is the day of
   * the month, so each day's result shows which day's samples it read.
   */
  const samplesByDay: SiteSamplesFn = async ({ startDate, endDate }) => {
    const out = emptySamples();
    for (let d = startDate; d <= endDate; ) {
      out.timestamps.push(kampalaMidnight(d));
      out.batterySocPct.push(Number(d.slice(8)));
      out.batteryPowerW.push(0);
      out.gridPowerW.push(0);
      out.gridVoltageV.push(230);
      out.loadPowerW.push(null);
      out.pvPowerW.push(null);
      const next = new Date(`${d}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      d = next.toISOString().slice(0, 10);
    }
    return out;
  };

  describe("query shape and scope", () => {
    it.each([
      ["null", null],
      ["a string", "2026-11-01"],
      ["an array", [MG_ID]],
    ])("answers 400 metering_invalid_query for %s", async (_label, query) => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDays(query);
      expect(result).toMatchObject({ ok: false, status: 400, code: "metering_invalid_query" });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 400 metering_invalid_microgrid for an id that is not a UUID", async () => {
      const { capability } = setup();
      const result = await capability.getSiteDays({
        microgrid_id: "mg-1",
        start_date: "2026-11-01",
        end_date: "2026-11-02",
      });
      expect(result).toMatchObject({ ok: false, status: 400, code: "metering_invalid_microgrid" });
    });

    it("answers 403 metering_scope_mismatch for a microgrid in another organization", async () => {
      const { capability, getSiteSamples } = setup({
        repo: {
          getMicrogridOrganization: async () => ({
            microgridId: MG_ID,
            communityId: "comm-1",
            orgId: OTHER_ORG_ID,
          }),
        },
      });
      const result = await capability.getSiteDays(range("2026-11-01", "2026-11-02"));
      expect(result).toMatchObject({ ok: false, status: 403, code: "metering_scope_mismatch" });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 500 metering_composition_disposed once disposed", async () => {
      const { capability, getSiteSamples } = setup({ active: false });
      const result = await capability.getSiteDays(range("2026-11-01", "2026-11-02"));
      expect(result).toMatchObject({ ok: false, status: 500, code: "metering_composition_disposed" });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });
  });

  describe("date validation", () => {
    it.each([
      ["a malformed start_date", "2026-11", "2026-11-02", "start_date"],
      ["a start_date that does not exist", "2026-02-30", "2026-03-02", "start_date"],
      ["a missing start_date", undefined, "2026-11-02", "start_date"],
      ["a malformed end_date", "2026-11-01", "02/11/2026", "end_date"],
      ["a missing end_date", "2026-11-01", undefined, "end_date"],
    ])("answers 422 for %s", async (_label, start, end, field) => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDays(range(start, end));
      expect(result).toMatchObject({
        ok: false,
        status: 422,
        code: "metering_invalid_date",
        field,
      });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 422 for an end_date after today in the microgrid's timezone", async () => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDays(range("2026-11-01", "2026-11-08"));
      expect(result).toMatchObject({
        ok: false,
        status: 422,
        code: "metering_invalid_date",
        field: "end_date",
      });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("allows an end_date of today in the microgrid's timezone though UTC is a day behind", async () => {
      const { capability } = setup();
      const result = await capability.getSiteDays(range(UTC_TODAY, KAMPALA_TODAY));
      expect(result.ok).toBe(true);
    });

    it("answers 422 when start_date is after end_date", async () => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDays(range("2026-11-03", "2026-11-02"));
      expect(result).toMatchObject({
        ok: false,
        status: 422,
        code: "metering_invalid_date",
        field: "start_date",
      });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("answers 422 for a range longer than 366 days", async () => {
      const { capability, getSiteSamples } = setup();
      // 2025-11-06 to 2026-11-07 inclusive is 367 days.
      const result = await capability.getSiteDays(range("2025-11-06", KAMPALA_TODAY));
      expect(result).toMatchObject({
        ok: false,
        status: 422,
        code: "metering_invalid_date",
        field: "start_date",
      });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });

    it("reads a range of exactly 366 days in 12 provider calls", async () => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDays(range("2025-11-07", KAMPALA_TODAY));
      if (!result.ok) throw new Error(`expected site days, got ${JSON.stringify(result)}`);
      expect(result.data).toHaveLength(366);
      expect(getSiteSamples).toHaveBeenCalledTimes(12);
    });
  });

  describe("provider and devices", () => {
    it("answers 503 METERING_CONFIGURATION when the provider has no getSiteSamples", async () => {
      const { capability } = setup({ getSiteSamples: null });
      const result = await capability.getSiteDays(range("2026-11-01", "2026-11-02"));
      expect(result).toMatchObject({ ok: false, status: 503, code: "METERING_CONFIGURATION" });
    });

    it("answers 404 metering_no_site_devices without a battery or grid meter", async () => {
      const { capability, getSiteSamples } = setup({
        repo: { getManagedDevices: async () => [SITE_DEVICES[0]] },
      });
      const result = await capability.getSiteDays(range("2026-11-01", "2026-11-02"));
      expect(result).toMatchObject({ ok: false, status: 404, code: "metering_no_site_devices" });
      expect(getSiteSamples).not.toHaveBeenCalled();
    });
  });

  describe("chunked reads", () => {
    it("reads one day with one call from the day before", async () => {
      const { capability, getSiteSamples } = setup();
      const result = await capability.getSiteDays(range("2026-11-01", "2026-11-01"));
      if (!result.ok) throw new Error(`expected site days, got ${JSON.stringify(result)}`);
      expect(result.data.map((d) => d.date)).toEqual(["2026-11-01"]);
      expect(getSiteSamples).toHaveBeenCalledTimes(1);
      expect(getSiteSamples).toHaveBeenCalledWith({
        microgridId: MG_ID,
        sources: pickSiteSources(SITE_DEVICES),
        startDate: "2026-10-31",
        endDate: "2026-11-01",
        timezone: "Africa/Kampala",
        resolutionMinutes: 5,
      });
    });

    it("reads a 70-day range in three calls, each from the day before its first day", async () => {
      const { capability, getSiteSamples } = setup();
      // 1 Aug to 9 Oct 2026 inclusive is 70 days: 31 + 31 + 8.
      const result = await capability.getSiteDays(range("2026-08-01", "2026-10-09"));
      expect(result.ok).toBe(true);
      expect(getSiteSamples).toHaveBeenCalledTimes(3);
      expect(getSiteSamples.mock.calls.map(([r]) => [r.startDate, r.endDate])).toEqual([
        ["2026-07-31", "2026-08-31"],
        ["2026-08-31", "2026-10-01"],
        ["2026-10-01", "2026-10-09"],
      ]);
      for (const [request] of getSiteSamples.mock.calls) {
        expect(request).toMatchObject({
          microgridId: MG_ID,
          timezone: "Africa/Kampala",
          resolutionMinutes: 5,
        });
      }
    });

    it("returns one day per date, in order, each worked out from its own samples", async () => {
      const { capability } = setup({ getSiteSamples: samplesByDay });
      const result = await capability.getSiteDays(range("2026-08-01", "2026-10-09"));
      if (!result.ok) throw new Error(`expected site days, got ${JSON.stringify(result)}`);
      expect(result.data).toHaveLength(70);
      expect(result.data[0].date).toBe("2026-08-01");
      expect(result.data[30].date).toBe("2026-08-31");
      expect(result.data[31].date).toBe("2026-09-01");
      expect(result.data[69].date).toBe("2026-10-09");
      for (let i = 1; i < result.data.length; i++) {
        expect(result.data[i].date > result.data[i - 1].date).toBe(true);
      }
      for (const day of result.data) {
        expect(day.timezone).toBe("Africa/Kampala");
        expect(day.dayStartMs).toBe(kampalaMidnight(day.date));
        expect(day.soc[0]).toEqual({ atMs: day.dayStartMs, pct: Number(day.date.slice(8)) });
        expect(day.flows).toHaveLength(288);
      }
    });

    it("carries a cut into a chunk's first day from the day before it", async () => {
      // The day before the second chunk ends in a cut; the gateway is then
      // silent, so that chunk's first day starts dark.
      const { capability } = setup({
        getSiteSamples: async ({ startDate }) => {
          const out = emptySamples();
          if (startDate === "2026-08-31") {
            out.timestamps.push(kampalaMidnight("2026-09-01") - 5 * 60_000);
            out.batterySocPct.push(20);
            out.batteryPowerW.push(500);
            out.gridPowerW.push(0);
            out.gridVoltageV.push(0);
            out.loadPowerW.push(null);
            out.pvPowerW.push(null);
          }
          return out;
        },
      });
      const result = await capability.getSiteDays(range("2026-08-01", "2026-09-02"));
      if (!result.ok) throw new Error(`expected site days, got ${JSON.stringify(result)}`);
      const first = result.data.find((d) => d.date === "2026-09-01");
      expect(first?.darkMinutes).toBe(1440);
      expect(first?.flows[0].gridPresent).toBe(false);
    });

    it("stops the last day at now when the range ends today", async () => {
      const { capability } = setup();
      const result = await capability.getSiteDays(range("2026-11-06", KAMPALA_TODAY));
      if (!result.ok) throw new Error(`expected site days, got ${JSON.stringify(result)}`);
      const today = result.data[1];
      expect(today.date).toBe(KAMPALA_TODAY);
      // 01:30 in Kampala: 18 five-minute bins have started.
      expect(today.flows).toHaveLength(18);
    });
  });

  describe("errors", () => {
    it("fails the whole read when a later chunk's provider call fails", async () => {
      let calls = 0;
      const { capability } = setup({
        getSiteSamples: async () => {
          calls += 1;
          if (calls === 2) throw new MeteringError("provider said no", "METERING_UNAVAILABLE", 503);
          return emptySamples();
        },
      });
      const result = await capability.getSiteDays(range("2026-08-01", "2026-10-09"));
      expect(result).toEqual({
        ok: false,
        status: 503,
        code: "METERING_UNAVAILABLE",
        message: "provider said no",
      });
      // The three chunks of this range are read together (SITE_DAYS_PARALLEL).
      expect(calls).toBe(3);
    });

    it("answers 500 metering_site_days_failed when something else throws, and logs it", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { capability } = setup({
          getSiteSamples: async () => {
            throw new TypeError("boom");
          },
        });
        const result = await capability.getSiteDays(range("2026-11-01", "2026-11-02"));
        expect(result).toEqual({
          ok: false,
          status: 500,
          code: "metering_site_days_failed",
          message: "These days' operations could not be worked out. Try a shorter range.",
        });
        expect(consoleSpy).toHaveBeenCalledWith("MGM site day could not be computed", {
          startDate: "2026-11-01",
          endDate: "2026-11-02",
          timezone: "Africa/Kampala",
          name: "TypeError",
          message: "boom",
        });
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });
});
