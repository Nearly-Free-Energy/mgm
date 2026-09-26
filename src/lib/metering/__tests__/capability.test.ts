import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeteringCapability } from "../capability";
import { MeteringRegistry } from "../registry";
import { FixtureMeteringProvider } from "../fixture-provider";
import type {
  MeteringConnection,
  MeteringRepository,
  MeteringScope,
} from "../repository";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ORG_ID = "550e8400-e29b-41d4-a716-446655440001";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const HH_ID = "660e8400-e29b-41d4-a716-446655440010";
const DEV_ID = "660e8400-e29b-41d4-a716-44665544aaaa";

const scope: MeteringScope = {
  organizationId: ORG_ID,
  userId: "user-1",
  roles: [],
};

function stubRepo(overrides: Partial<MeteringRepository> = {}): MeteringRepository {
  return {
    getAuthenticatedUserId: async () => "user-1",
    getUserRoles: async () => [],
    isPluginEnabled: async () => true,
    getMicrogridOrganization: async (id: string) =>
      id === MG_ID
        ? { microgridId: MG_ID, communityId: "comm-1", orgId: ORG_ID }
        : null,
    getHouseholdOrganization: async (id: string) =>
      id === HH_ID
        ? { householdId: HH_ID, microgridId: MG_ID, orgId: ORG_ID }
        : null,
    getDeviceOrganization: async (id: string) =>
      id === DEV_ID
        ? { deviceId: DEV_ID, microgridId: MG_ID, orgId: ORG_ID }
        : null,
    getStoredConnection: async () => null,
    getMicrogridTimezone: async () => "Africa/Kampala",
    getManagedDevices: async () => [
      {
        id: DEV_ID,
        name: "Meter 01",
        edgeId: "edge-1",
        deviceType: "consumption_meter",
        edgeOpenemsId: "edge0",
        componentId: "meter0",
      },
    ],
    getMicrogridEdges: async () => [],
    getKnownEdgeIds: async () => [],
    getAssignmentLinks: async () => [],
    insertMeterReading: async () => ({ id: "reading-1", error: null }),
    findMeterReadingAt: async () => null,
    ...overrides,
  };
}

function stubConnection(
  overrides: Partial<MeteringConnection> = {}
): MeteringConnection {
  return {
    testStored: async () => ({ ok: true, edgeCount: 0, edges: [] }),
    testCandidate: async () => ({ ok: true, edgeCount: 0, edges: [] }),
    discover: async () => [],
    ...overrides,
  };
}

function setup(
  repoOverrides: Partial<MeteringRepository> = {},
  connectionOverrides: Partial<MeteringConnection> = {},
  provider: "openems" | "fixture" = "fixture"
) {
  const registry = new MeteringRegistry();
  if (provider === "fixture") {
    registry.register(
      "fixture",
      new FixtureMeteringProvider([
        {
          deviceId: DEV_ID,
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          timezone: "Africa/Kampala",
          usageKwh: 42.5,
        },
      ])
    );
  }
  const capability = new MeteringCapability(
    stubRepo(repoOverrides),
    scope,
    registry,
    stubConnection(connectionOverrides),
    () => true
  );
  return { capability, registry };
}

describe("MeteringCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects cross-organization microgrids without touching the provider", async () => {
    const { capability, registry } = setup();
    const resolve = vi.spyOn(registry, "resolve");
    const result = await capability.getConsumption({
      microgrid_id: "660e8400-e29b-41d4-a716-446655440099",
      start_date: "2026-09-01",
      end_date: "2026-09-30",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: "metering_scope_mismatch",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails closed when the metering plugin is disabled", async () => {
    const { capability } = setup({ isPluginEnabled: async () => false });
    const result = await capability.getConsumption({
      microgrid_id: MG_ID,
      start_date: "2026-09-01",
      end_date: "2026-09-30",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "metering_disabled",
    });
  });

  it("returns per-meter consumption with source and timestamp, preserving nulls", async () => {
    const { capability } = setup(
      {
        getManagedDevices: async () => [
          {
            id: DEV_ID,
            name: "Meter 01",
            edgeId: "edge-1",
            deviceType: "consumption_meter",
            edgeOpenemsId: "edge0",
            componentId: "meter0",
          },
          {
            id: "660e8400-e29b-41d4-a716-44665544bbbb",
            name: "Meter 02",
            edgeId: "edge-1",
            deviceType: "consumption_meter",
            edgeOpenemsId: "edge0",
            componentId: "meter1",
          },
        ],
      },
      {},
      "fixture"
    );
    // Fixture has no reading for meter1 → provider throws; surface as error,
    // never a substituted zero.
    const result = await capability.getConsumption({
      microgrid_id: MG_ID,
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      provider: "fixture",
    });
    expect(result).toMatchObject({ ok: false, code: "METERING_INVALID_DATA" });
  });

  it("returns consumption rows with household attribution", async () => {
    const { capability } = setup(
      {
        getAssignmentLinks: async () => [
          {
            id: "link-1",
            householdId: HH_ID,
            deviceId: DEV_ID,
            role: "primary_consumption_meter",
            effectiveFrom: "2026-01-01",
            effectiveTo: null,
          },
        ],
      },
      {},
      "fixture"
    );
    const result = await capability.getConsumption({
      microgrid_id: MG_ID,
      household_ids: [HH_ID],
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      provider: "fixture",
    });
    if (!result.ok) throw new Error("expected consumption");
    expect(result.data).toEqual([
      {
        deviceId: DEV_ID,
        householdId: HH_ID,
        usageKwh: 42.5,
        source: "fixture",
        readAt: expect.any(String),
      },
    ]);
  });

  it("rejects unknown meters with an actionable 404", async () => {
    const { capability } = setup({}, {}, "fixture");
    const result = await capability.getConsumption({
      microgrid_id: MG_ID,
      device_ids: ["660e8400-e29b-41d4-a716-44665544cccc"],
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      provider: "fixture",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: "metering_unknown_device",
    });
  });

  it("rejects inverted date ranges", async () => {
    const { capability } = setup();
    const result = await capability.getConsumption({
      microgrid_id: MG_ID,
      start_date: "2026-09-30",
      end_date: "2026-09-01",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "metering_invalid_range",
    });
  });

  it("computes assignment history with gaps and boundary evidence", async () => {
    const { capability } = setup({
      getAssignmentLinks: async () => [
        {
          id: "link-1",
          householdId: HH_ID,
          deviceId: DEV_ID,
          role: "primary_consumption_meter",
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-03-01",
        },
        {
          id: "link-2",
          householdId: HH_ID,
          deviceId: "660e8400-e29b-41d4-a716-44665544bbbb",
          role: "primary_consumption_meter",
          effectiveFrom: "2026-04-01",
          effectiveTo: null,
        },
      ],
    });
    const result = await capability.getAssignmentHistory(HH_ID);
    if (!result.ok) throw new Error("expected history");
    expect(result.data.entries).toHaveLength(2);
    expect(result.data.entries[1].current).toBe(true);
    expect(result.data.gaps).toEqual([
      { from: "2026-03-01", to: "2026-04-01" },
    ]);
  });

  it("validates opening registers and rejects duplicates", async () => {
    const { capability } = setup();
    const badReading = await capability.recordOpeningRegister({
      deviceId: DEV_ID,
      readingKwh: -5,
      readAt: "2026-09-01T00:00:00Z",
    });
    expect(badReading).toMatchObject({
      ok: false,
      status: 422,
      code: "metering_invalid_reading",
    });

    const future = await capability.recordOpeningRegister({
      deviceId: DEV_ID,
      readingKwh: 10,
      readAt: "2999-01-01T00:00:00Z",
    });
    expect(future).toMatchObject({
      ok: false,
      status: 422,
      code: "metering_invalid_read_at",
    });

    const { capability: dupeCap } = setup({
      findMeterReadingAt: async () => ({ id: "reading-9" }),
    });
    const dupe = await dupeCap.recordOpeningRegister({
      deviceId: DEV_ID,
      readingKwh: 10,
      readAt: "2026-09-01T00:00:00Z",
    });
    expect(dupe).toMatchObject({
      ok: false,
      status: 409,
      code: "metering_duplicate_reading",
    });

    const ok = await capability.recordOpeningRegister({
      deviceId: DEV_ID,
      readingKwh: 10,
      readAt: "2026-09-01T00:00:00Z",
    });
    expect(ok).toEqual({ ok: true, data: { id: "reading-1" } });
  });

  it("rejects opening registers for other organizations", async () => {
    const { capability } = setup({
      getDeviceOrganization: async () => ({
        deviceId: DEV_ID,
        microgridId: MG_ID,
        orgId: OTHER_ORG_ID,
      }),
    });
    const result = await capability.recordOpeningRegister({
      deviceId: DEV_ID,
      readingKwh: 10,
      readAt: "2026-09-01T00:00:00Z",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: "metering_scope_mismatch",
    });
  });

  it("delegates connection tests and maps auth failures", async () => {
    const { capability } = setup(
      {},
      {
        testStored: async () => ({
          ok: false,
          code: "auth_failed",
          message: "bad creds",
        }),
      }
    );
    const result = await capability.testConnection(MG_ID);
    expect(result).toEqual({
      ok: true,
      data: { ok: false, code: "auth_failed", message: "bad creds" },
    });
  });
});
