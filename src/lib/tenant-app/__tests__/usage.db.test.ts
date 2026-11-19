/**
 * A tenant's month and day of use against the database (RFC mgm#197 § 5):
 * composeTenantApp with the tenant's own client, the links read through RLS
 * with their half-open dates, and the usage source's service-role reads, with
 * MGM_METERING_FIXTURES on so the synthetic provider answers for a microgrid
 * whose edges carry `SYNTHETIC-EDGE-` ids.
 *
 * One meter M moves from unit A to unit B on 15 September. Unit A is also
 * linked (with the service role, which no app path would do:
 * fn_create_tenant refuses a meter of another microgrid) to a meter X on an
 * edge of another microgrid of the same organization. A's own client reads
 * X's device row, but the edges read is filtered to A's microgrid, so X is
 * never sent to a provider and every day X is in force reads as no data.
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
const LINK_X = "e7700000-0000-4000-8006-000000000001";
const EMAIL_A = "tenant-usage-a@test.local";
const EMAIL_B = "tenant-usage-b@test.local";
const KAMPALA = "Africa/Kampala";

let tenantA: TestUser;
let tenantB: TestUser;

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
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL_A, EMAIL_B] });

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
    ["tenants", { id: UNIT_A, microgrid_id: MICROGRID, display_name: "Unit A", primary_phone: "+256700000001" }],
    ["tenants", { id: UNIT_B, microgrid_id: MICROGRID, display_name: "Unit B", primary_phone: "+256700000002" }],
    ["tenant_devices", { tenant_id: UNIT_A, device_id: METER, role: "primary_consumption_meter", effective_from: "2026-09-01", effective_to: "2026-09-15" }],
    ["tenant_devices", { tenant_id: UNIT_B, device_id: METER, role: "primary_consumption_meter", effective_from: "2026-09-15", effective_to: null }],
    ["tenant_devices", { id: LINK_X, tenant_id: UNIT_A, device_id: METER_X, role: "secondary_meter", effective_from: "2026-09-01", effective_to: null }],
    // The tenant app is off without a row (defaultEnabled in src/lib/plugins/bundled.ts).
    ["mgm_plugins", { org_id: ORG, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled: true }],
  ];
  for (const [table, row] of rows) {
    const { error } = await svc.from(table).insert(row);
    if (error) throw new Error(`[tenant-usage.db] ${table}: ${error.message}`);
  }
  tenantA = await createTestUser({ email: EMAIL_A, role: "tenant", scopeId: UNIT_A });
  tenantB = await createTestUser({ email: EMAIL_B, role: "tenant", scopeId: UNIT_B });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  vi.unstubAllEnvs();
  energySeries.mockRestore();
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL_A, EMAIL_B] });
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

/** Meter M's generated figures, as the synthetic provider makes them for MICROGRID. */
function generated(startDate: string, endDate: string, resolution: "day" | "hour") {
  return generateDeviceEnergySeries({
    microgridId: MICROGRID,
    devices: [{ id: METER, edgeOpenemsId: `SYNTHETIC-EDGE-${MICROGRID}`, componentId: "meter1" }],
    startDate,
    endDate,
    resolution,
    timezone: KAMPALA,
  }).kwh[METER];
}

const september = Array.from({ length: 30 }, (_, i) => addDaysToDateKey("2026-09-01", i));
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

    // M has figures on the 1st to the 14th, but X is in force too and has none.
    expect(shown.days).toEqual(september.map((date) => ({ date, state: "no-data", kwh: null })));
    expect(shown.total).toEqual({ kwh: null, withoutData: 30 });
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

  it("does not let one unit's tenant compose the other's unit", async () => {
    const composed = await composeTenantApp({ supabase: tenantA.client, tenantId: UNIT_B });
    expect(composed).toMatchObject({ ok: false, status: 403 });
  });
});
