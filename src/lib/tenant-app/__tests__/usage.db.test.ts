/**
 * A tenant's month and day of use against the database (RFC mgm#197 § 5):
 * composeTenantApp with the tenant's own client, the links read through RLS
 * with their half-open dates, and the usage source's service-role reads, with
 * MGM_METERING_FIXTURES on so the synthetic provider answers for a microgrid
 * whose edges carry `SYNTHETIC-EDGE-` ids.
 *
 * One meter M moves from unit A to unit B on 15 September. From then, unit
 * A's primary meter is a meter X on an edge of another microgrid of the same
 * organization (linked with the service role, which no app path would do:
 * fn_create_tenant refuses a meter of another microgrid). A's own client
 * reads X's device row, but the edges read is filtered to A's microgrid, so
 * X is never sent to a provider and every day X is in force reads as no
 * data.
 *
 * Unit C has every link that is not its use (USAGE_METER_ROLE, as decided
 * on mgm#210): a grid meter and then a PV meter linked as its primary, a
 * battery, and M, B's primary, linked to C as a secondary meter. Only C's
 * own primary consumption meter, from 21 October, is ever read.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  mintServiceRoleJwt,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import { FixtureMeteringProvider } from "@/lib/metering/fixture-provider";
import { generateDeviceEnergySeries } from "@/lib/metering/fixture/meter-energy";
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { addDaysToDateKey, localHourStarts } from "@/lib/timezone/day-key";
import { composeTenantApp } from "../compose";
import type { TenantUsageDay, TenantUsageMonth } from "../types";
import { _resetTenantUsageCacheForTests } from "../usage-throttle";

const ORG = "e7700000-0000-4000-8000-000000000001";
const COMMUNITY = "e7700000-0000-4000-8001-000000000001";
const MICROGRID = "e7700000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e7700000-0000-4000-8002-000000000002";
const EDGE = "e7700000-0000-4000-8003-000000000001";
const OTHER_EDGE = "e7700000-0000-4000-8003-000000000002";
const METER = "e7700000-0000-4000-8004-000000000001";
const METER_X = "e7700000-0000-4000-8004-000000000002";
const UNIT_A = "e7700000-0000-4000-8005-000000000001";
const UNIT_B = "e7700000-0000-4000-8005-000000000002";
const UNIT_C = "e7700000-0000-4000-8005-000000000003";
const GRID_METER = "e7700000-0000-4000-8004-000000000003";
const PV_METER = "e7700000-0000-4000-8004-000000000004";
const BATTERY = "e7700000-0000-4000-8004-000000000005";
const OWN_METER = "e7700000-0000-4000-8004-000000000006";
const LINK_X = "e7700000-0000-4000-8006-000000000001";
const EMAIL_A = "tenant-usage-a@test.local";
const EMAIL_B = "tenant-usage-b@test.local";
const EMAIL_C = "tenant-usage-c@test.local";
const KAMPALA = "Africa/Kampala";

let tenantA: TestUser;
let tenantB: TestUser;
let tenantC: TestUser;

const energySeries = vi.spyOn(FixtureMeteringProvider.prototype, "getDeviceEnergySeries");

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Read when the root loads its platform plugins, on the first composition below.
  vi.stubEnv("MGM_METERING_FIXTURES", "1");
  // The usage source reads edges and builds the provider on a service-role
  // client the product builds from SUPABASE_SERVICE_ROLE_KEY and the server
  // Supabase URL (src/lib/supabase/service.ts), as credential-canary.db.test.ts
  // sets them; CI's test step sets no service key. Any MGM_OPENEMS_* setting
  // would send a microgrid to the environment's backend first
  // (resolveOpenEmsConfig), so they are cleared. If those files read other
  // names, revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  for (const name of ["MGM_OPENEMS_MICROGRID_ID", "MGM_OPENEMS_URL", "MGM_OPENEMS_USERNAME", "MGM_OPENEMS_PASSWORD"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("OPENEMS_KEYCLOAK_TOKEN_URLS", "");
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL_A, EMAIL_B, EMAIL_C] });

  const svc = await serviceClient();
  const rows: [string, Record<string, unknown>][] = [
    ["organizations", { id: ORG, name: "Tenant Usage Org" }],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "Tenant Usage Community" }],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Synthetic site", currency: "UGX", timezone: KAMPALA }],
    ["microgrids", { id: OTHER_MICROGRID, community_id: COMMUNITY, name: "Other synthetic site", currency: "UGX", timezone: KAMPALA }],
    ["edges", { id: EDGE, microgrid_id: MICROGRID, name: "Synthetic edge", openems_edge_id: `SYNTHETIC-EDGE-${MICROGRID}` }],
    ["edges", { id: OTHER_EDGE, microgrid_id: OTHER_MICROGRID, name: "Other edge", openems_edge_id: `SYNTHETIC-EDGE-${OTHER_MICROGRID}` }],
    ["devices", { id: METER, edge_id: EDGE, name: "Meter M", device_type: "consumption_meter", openems_component_id: "meter1" }],
    ["devices", { id: METER_X, edge_id: OTHER_EDGE, name: "Meter X", device_type: "consumption_meter", openems_component_id: "meter1" }],
    ["devices", { id: GRID_METER, edge_id: EDGE, name: "Grid meter", device_type: "grid_meter", openems_component_id: "meter0" }],
    ["devices", { id: PV_METER, edge_id: EDGE, name: "PV meter", device_type: "pv_meter", openems_component_id: "meter2" }],
    ["devices", { id: BATTERY, edge_id: EDGE, name: "Battery", device_type: "battery", openems_component_id: "ess0" }],
    ["devices", { id: OWN_METER, edge_id: EDGE, name: "Meter C", device_type: "consumption_meter", openems_component_id: "meter3" }],
    ["tenants", { id: UNIT_A, microgrid_id: MICROGRID, display_name: "Unit A", primary_phone: "+256700000001" }],
    ["tenants", { id: UNIT_B, microgrid_id: MICROGRID, display_name: "Unit B", primary_phone: "+256700000002" }],
    ["tenants", { id: UNIT_C, microgrid_id: MICROGRID, display_name: "Unit C", primary_phone: "+256700000003" }],
    ["tenant_devices", { tenant_id: UNIT_A, device_id: METER, role: "primary_consumption_meter", effective_from: "2026-09-01", effective_to: "2026-09-15" }],
    ["tenant_devices", { tenant_id: UNIT_B, device_id: METER, role: "primary_consumption_meter", effective_from: "2026-09-15", effective_to: null }],
    ["tenant_devices", { id: LINK_X, tenant_id: UNIT_A, device_id: METER_X, role: "primary_consumption_meter", effective_from: "2026-09-15", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_C, device_id: GRID_METER, role: "primary_consumption_meter", effective_from: "2026-10-01", effective_to: "2026-10-11" }],
    ["tenant_devices", { tenant_id: UNIT_C, device_id: PV_METER, role: "primary_consumption_meter", effective_from: "2026-10-11", effective_to: "2026-10-21" }],
    ["tenant_devices", { tenant_id: UNIT_C, device_id: BATTERY, role: "battery", effective_from: "2026-10-01", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_C, device_id: METER, role: "secondary_meter", effective_from: "2026-10-01", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_C, device_id: OWN_METER, role: "primary_consumption_meter", effective_from: "2026-10-21", effective_to: null }],
    // The tenant app is off without a row (defaultEnabled in src/lib/plugins/bundled.ts).
    ["mgm_plugins", { org_id: ORG, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled: true }],
  ];
  for (const [table, row] of rows) {
    const { error } = await svc.from(table).insert(row);
    if (error) throw new Error(`[tenant-usage.db] ${table}: ${error.message}`);
  }
  tenantA = await createTestUser({ email: EMAIL_A, role: "tenant", scopeId: UNIT_A });
  tenantB = await createTestUser({ email: EMAIL_B, role: "tenant", scopeId: UNIT_B });
  tenantC = await createTestUser({ email: EMAIL_C, role: "tenant", scopeId: UNIT_C });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  vi.unstubAllEnvs();
  energySeries.mockRestore();
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL_A, EMAIL_B, EMAIL_C] });
}, 60_000);

beforeEach(() => {
  _resetTenantUsageCacheForTests();
  energySeries.mockClear();
});

async function usageMonth(user: TestUser, tenantId: string, month: string): Promise<TenantUsageMonth> {
  const composed = await composeTenantApp({ supabase: user.client, tenantId });
  if (!composed.ok) throw new Error(`composeTenantApp: ${composed.status} ${composed.code}`);
  try {
    const result = await composed.data.tenantApp.getUsageMonth({ month });
    if (!result.ok) throw new Error(`getUsageMonth: ${result.status} ${result.code}`);
    return result.data;
  } finally {
    await composed.data.dispose();
  }
}

async function usageDay(user: TestUser, tenantId: string, date: string): Promise<TenantUsageDay> {
  const composed = await composeTenantApp({ supabase: user.client, tenantId });
  if (!composed.ok) throw new Error(`composeTenantApp: ${composed.status} ${composed.code}`);
  try {
    const result = await composed.data.tenantApp.getUsageDay({ date });
    if (!result.ok) throw new Error(`getUsageDay: ${result.status} ${result.code}`);
    return result.data;
  } finally {
    await composed.data.dispose();
  }
}

/** A meter's generated figures (M's by default), as the synthetic provider makes them for MICROGRID. */
function generated(startDate: string, endDate: string, resolution: "day" | "hour", meter = { id: METER, componentId: "meter1" }) {
  return generateDeviceEnergySeries({
    microgridId: MICROGRID,
    devices: [{ id: meter.id, edgeOpenemsId: `SYNTHETIC-EDGE-${MICROGRID}`, componentId: meter.componentId }],
    startDate,
    endDate,
    resolution,
    timezone: KAMPALA,
  }).kwh[meter.id];
}

const september = Array.from({ length: 30 }, (_, i) => addDaysToDateKey("2026-09-01", i));
const october = Array.from({ length: 31 }, (_, i) => addDaysToDateKey("2026-10-01", i));
const kwhSum = (values: (number | null)[]) => Math.round(values.reduce((sum: number, v) => sum + (v ?? 0) * 1000, 0)) / 1000;
const bucket = (kwh: number | null) => ({ state: kwh === null ? "no-data" : "data", kwh });

describe.skipIf(shouldSkip())("a tenant's use, read through the database", () => {
  it("shows unit B the meter from the day it moved in, and only those days are asked for", async () => {
    const shown = await usageMonth(tenantB, UNIT_B, "2026-09");
    const figures = generated("2026-09-15", "2026-09-30", "day");

    expect(shown.read).toMatchObject({ synthetic: true, stale: false, problem: null });
    expect(shown.days.slice(0, 14)).toEqual(september.slice(0, 14).map((date) => ({ date, state: "no-meter", kwh: null })));
    expect(shown.days.slice(14)).toEqual(september.slice(14).map((date, i) => ({ date, ...bucket(figures[i]) })));
    expect(shown.days.filter((d) => d.state === "data").length).toBeGreaterThan(10);

    expect(energySeries).toHaveBeenCalledTimes(1);
    expect(energySeries.mock.calls[0][0]).toEqual({
      microgridId: MICROGRID,
      devices: [{ id: METER, edgeOpenemsId: `SYNTHETIC-EDGE-${MICROGRID}`, componentId: "meter1" }],
      startDate: "2026-09-15",
      endDate: "2026-09-30",
      resolution: "day",
      timezone: KAMPALA,
      // The capability's clock, passed through to the provider.
      nowMs: expect.any(Number),
    });
  });

  it("shows unit B the hours of a day of its own, and none of the day before it moved in", async () => {
    const shown = await usageDay(tenantB, UNIT_B, "2026-09-20");
    const figures = generated("2026-09-20", "2026-09-20", "hour");

    expect(shown.meters).toBe(1);
    expect(shown.hours).toEqual(
      localHourStarts("2026-09-20", KAMPALA).map((start, i) => ({ start, ...bucket(figures[i]) }))
    );

    const before = await usageDay(tenantB, UNIT_B, "2026-09-14");
    expect(before.meters).toBe(0);
    expect(before.hours.every((h) => h.state === "no-meter")).toBe(true);
    expect(energySeries).toHaveBeenCalledTimes(1);
  });

  it("never sends unit A's meter on another microgrid's edge, so every day it is in force has no data", async () => {
    // The premise: A's own client reads X's device row through RLS.
    const visible = await tenantA.client.from("devices").select("id").eq("id", METER_X);
    expect(visible).toMatchObject({ error: null, data: [{ id: METER_X }] });

    const shown = await usageMonth(tenantA, UNIT_A, "2026-09");
    const figures = generated("2026-09-01", "2026-09-14", "day");

    // M's days to the 14th, then X's, which have none.
    expect(shown.days.slice(0, 14)).toEqual(september.slice(0, 14).map((date, i) => ({ date, ...bucket(figures[i]) })));
    expect(shown.days.slice(14)).toEqual(september.slice(14).map((date) => ({ date, state: "no-data", kwh: null })));
    expect(shown.total).toEqual({ kwh: kwhSum(figures), withoutData: 16 + figures.filter((v) => v === null).length });
    expect(shown.read.problem).toBeNull();
    expect(energySeries).toHaveBeenCalledTimes(1);
    const [asked] = energySeries.mock.calls[0];
    expect(asked.microgridId).toBe(MICROGRID);
    expect(asked.devices.map((d) => d.id)).toEqual([METER]);
  });

  describe("once the link to the other microgrid's meter is gone", () => {
    beforeAll(async () => {
      if (shouldSkip()) return;
      const svc = await serviceClient();
      const { error } = await svc.from("tenant_devices").delete().eq("id", LINK_X);
      if (error) throw new Error(`[tenant-usage.db] remove link: ${error.message}`);
    });

    it("shows unit A the meter up to the day it moved out, and nothing after", async () => {
      const shown = await usageMonth(tenantA, UNIT_A, "2026-09");
      const figures = generated("2026-09-01", "2026-09-14", "day");

      expect(shown.days.slice(0, 14)).toEqual(september.slice(0, 14).map((date, i) => ({ date, ...bucket(figures[i]) })));
      expect(shown.days.slice(14)).toEqual(september.slice(14).map((date) => ({ date, state: "no-meter", kwh: null })));
      expect(energySeries.mock.calls[0][0]).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-14" });
    });

    it("shows unit A no meter, without reading, on a day after it moved out", async () => {
      const shown = await usageDay(tenantA, UNIT_A, "2026-09-20");

      expect(shown.meters).toBe(0);
      expect(shown.hours).toHaveLength(24);
      expect(shown.hours.every((h) => h.state === "no-meter" && h.kwh === null)).toBe(true);
      expect(shown.read).toEqual({ readAt: null, stale: false, synthetic: false, problem: null });
      expect(energySeries).not.toHaveBeenCalled();
    });
  });

  describe("only the unit's own primary consumption meter is its use (mgm#210)", () => {
    const own = { id: OWN_METER, componentId: "meter3" };

    it("never shows a grid meter, even linked as the unit's primary", async () => {
      // The premise: C's own client reads the grid meter's row and its link.
      const visible = await tenantC.client.from("devices").select("id").eq("id", GRID_METER);
      expect(visible).toMatchObject({ error: null, data: [{ id: GRID_METER }] });

      const shown = await usageMonth(tenantC, UNIT_C, "2026-10");

      expect(shown.days.slice(0, 10)).toEqual(october.slice(0, 10).map((date) => ({ date, state: "no-meter", kwh: null })));
      expect(energySeries).toHaveBeenCalledTimes(1);
      expect(energySeries.mock.calls[0][0].devices.map((d) => d.id)).toEqual([OWN_METER]);
      // A day with only the grid meter linked reads nothing at all.
      const day = await usageDay(tenantC, UNIT_C, "2026-10-05");
      expect(day.meters).toBe(0);
      expect(energySeries).toHaveBeenCalledTimes(1);
    });

    it("never shows a meter that is not a consumption meter, such as a PV meter linked as the unit's primary", async () => {
      const shown = await usageMonth(tenantC, UNIT_C, "2026-10");

      expect(shown.days.slice(10, 20)).toEqual(october.slice(10, 20).map((date) => ({ date, state: "no-meter", kwh: null })));
      expect(energySeries.mock.calls[0][0].devices.map((d) => d.id)).not.toContain(PV_METER);
    });

    it("never shows a battery linked to the unit", async () => {
      const shown = await usageMonth(tenantC, UNIT_C, "2026-10");
      const day = await usageDay(tenantC, UNIT_C, "2026-10-15");

      expect(shown.days.slice(0, 20).every((d) => d.state === "no-meter")).toBe(true);
      expect(day.meters).toBe(0);
      expect(day.read).toEqual({ readAt: null, stale: false, synthetic: false, problem: null });
      for (const [asked] of energySeries.mock.calls) expect(asked.devices.map((d) => d.id)).not.toContain(BATTERY);
    });

    it("never shows a secondary link to a meter that is another unit's primary on those days", async () => {
      const shown = await usageMonth(tenantC, UNIT_C, "2026-10");
      const figures = generated("2026-10-21", "2026-10-31", "day", own);

      // Only C's own meter, from the 21st; M, B's primary, never.
      expect(shown.days.slice(20)).toEqual(october.slice(20).map((date, i) => ({ date, ...bucket(figures[i]) })));
      expect(energySeries).toHaveBeenCalledTimes(1);
      expect(energySeries.mock.calls[0][0]).toEqual({
        microgridId: MICROGRID,
        devices: [{ id: OWN_METER, edgeOpenemsId: `SYNTHETIC-EDGE-${MICROGRID}`, componentId: "meter3" }],
        startDate: "2026-10-21",
        endDate: "2026-10-31",
        resolution: "day",
        timezone: KAMPALA,
        nowMs: expect.any(Number),
      });
      // B still sees M as its own use on the same days.
      const unitB = await usageMonth(tenantB, UNIT_B, "2026-10");
      expect(unitB.days.find((d) => d.date === "2026-10-25")).toEqual({
        date: "2026-10-25",
        ...bucket(generated("2026-10-25", "2026-10-25", "day")[0]),
      });
    });
  });

  it("does not let one unit's tenant compose the other's unit", async () => {
    const composed = await composeTenantApp({ supabase: tenantA.client, tenantId: UNIT_B });
    expect(composed).toMatchObject({ ok: false, status: 403 });
  });
});
