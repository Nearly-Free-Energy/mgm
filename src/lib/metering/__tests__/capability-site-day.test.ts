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
    /** The name the provider registers under (default `openems`), and whether it is synthetic. */
    providerName?: string;
    synthetic?: boolean;
    /** Omitted: the capability's default selector. */
    selectProvider?: (microgridId: string) => Promise<string>;
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
    registry.register(
      options.providerName ?? "openems",
      options.synthetic ? { ...provider, synthetic: true } : provider
    );
  }
  const repo = stubRepo(options.repo);
  const capability = new MeteringCapability(
    repo,
    scope,
    registry,
    stubConnection(),
    () => options.active ?? true,
    options.selectProvider
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

    describe("provider selection", () => {
      it("reads from the provider selected for the microgrid, by name", async () => {
        const selectProvider = vi.fn(async () => "synthetic");
        const { capability, getSiteSamples } = setup({ providerName: "synthetic", selectProvider });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result.ok).toBe(true);
        expect(selectProvider).toHaveBeenCalledWith(MG_ID);
        expect(getSiteSamples).toHaveBeenCalledTimes(1);
      });

      it("answers a selection MeteringError with its status and message", async () => {
        const { capability, getSiteSamples } = setup({
          selectProvider: async () => {
            throw new MeteringError("mixed edges", "METERING_CONFIGURATION", 409);
          },
        });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result).toEqual({ ok: false, status: 409, code: "METERING_CONFIGURATION", message: "mixed edges" });
        expect(getSiteSamples).not.toHaveBeenCalled();
      });

      it("answers 503 when selection fails with another error, without its message", async () => {
        const { capability } = setup({
          selectProvider: async () => {
            throw new Error("socket hang up");
          },
        });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result).toEqual({
          ok: false,
          status: 503,
          code: "METERING_CONFIGURATION",
          message: "Metering provider is not available.",
        });
      });

      it("answers 503 when the selected provider is not registered for the request", async () => {
        const { capability } = setup({ selectProvider: async () => "synthetic" });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result).toMatchObject({ ok: false, status: 503, code: "METERING_CONFIGURATION" });
      });

      it("does not select a provider while the plugin is disabled", async () => {
        const selectProvider = vi.fn(async () => "openems");
        const { capability } = setup({ repo: { isPluginEnabled: async () => false }, selectProvider });
        const result = await capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        expect(result).toMatchObject({ ok: false, status: 409, code: "metering_disabled" });
        expect(selectProvider).not.toHaveBeenCalled();
      });

      it("marks the day synthetic only when the provider is", async () => {
        const real = await setup().capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        if (!real.ok) throw new Error("expected a site day");
        expect(real.data).not.toHaveProperty("synthetic");
        const generated = await setup({
          providerName: "synthetic",
          synthetic: true,
          selectProvider: async () => "synthetic",
        }).capability.getSiteDay({ microgrid_id: MG_ID, date: "2026-11-01" });
        if (!generated.ok) throw new Error("expected a site day");
        expect(generated.data.synthetic).toBe(true);
      });
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
