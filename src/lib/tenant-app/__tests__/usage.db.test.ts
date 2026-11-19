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
 * Units C, D and E pin the usage rules decided on #210 (19 November), one
 * test each: only consumption meters count (D, whose PV meter and inverter
 * are linked as secondary meters); a grid meter or battery never shows, in
 * either role (E); and a secondary link loses the days its meter is another
 * unit's primary (C, secondary on M, which is A's and then B's primary).
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
import type { TenantHome, TenantUsageDay, TenantUsageMonth } from "../types";
import { _resetTenantUsageCacheForTests } from "../usage-throttle";

const ORG = "e7700000-0000-4000-8000-000000000001";
const COMMUNITY = "e7700000-0000-4000-8001-000000000001";
const MICROGRID = "e7700000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e7700000-0000-4000-8002-000000000002";
const EDGE = "e7700000-0000-4000-8003-000000000001";
const OTHER_EDGE = "e7700000-0000-4000-8003-000000000002";
const METER = "e7700000-0000-4000-8004-000000000001";
const METER_X = "e7700000-0000-4000-8004-000000000002";
const METER_N = "e7700000-0000-4000-8004-000000000003";
const PV = "e7700000-0000-4000-8004-000000000004";
const INVERTER = "e7700000-0000-4000-8004-000000000005";
const GRID = "e7700000-0000-4000-8004-000000000006";
const BATTERY = "e7700000-0000-4000-8004-000000000007";
const METER_C = "e7700000-0000-4000-8004-000000000008";
const UNIT_A = "e7700000-0000-4000-8005-000000000001";
const UNIT_B = "e7700000-0000-4000-8005-000000000002";
const UNIT_C = "e7700000-0000-4000-8005-000000000003";
const UNIT_D = "e7700000-0000-4000-8005-000000000004";
const UNIT_E = "e7700000-0000-4000-8005-000000000005";
const LINK_X = "e7700000-0000-4000-8006-000000000001";
const LINK_M_B = "e7700000-0000-4000-8006-000000000002";
const EMAIL_A = "tenant-usage-a@test.local";
const EMAIL_B = "tenant-usage-b@test.local";
const EMAIL_C = "tenant-usage-c@test.local";
const EMAIL_D = "tenant-usage-d@test.local";
const EMAIL_E = "tenant-usage-e@test.local";
const EMAILS = [EMAIL_A, EMAIL_B, EMAIL_C, EMAIL_D, EMAIL_E];
const KAMPALA = "Africa/Kampala";
/** The component id of each device the synthetic provider may be asked for. */
const COMPONENT: Record<string, string> = { [METER]: "meter1", [METER_N]: "meter2", [METER_C]: "meter3" };

let tenantA: TestUser;
let tenantB: TestUser;
let tenantC: TestUser;
let tenantD: TestUser;
let tenantE: TestUser;

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
  await cleanupTestData({ orgIds: [ORG], userEmails: EMAILS });

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
    ["devices", { id: METER_N, edge_id: EDGE, name: "Meter N", device_type: "consumption_meter", openems_component_id: "meter2" }],
    ["devices", { id: PV, edge_id: EDGE, name: "PV meter", device_type: "pv_meter", openems_component_id: "pv1" }],
    ["devices", { id: INVERTER, edge_id: EDGE, name: "Inverter", device_type: "inverter", openems_component_id: "inv1" }],
    ["devices", { id: GRID, edge_id: EDGE, name: "Grid meter", device_type: "grid_meter", openems_component_id: "grid1" }],
    ["devices", { id: BATTERY, edge_id: EDGE, name: "Battery", device_type: "battery", openems_component_id: "bat1" }],
    ["devices", { id: METER_C, edge_id: EDGE, name: "Meter C", device_type: "consumption_meter", openems_component_id: "meter3" }],
    ["tenants", { id: UNIT_A, microgrid_id: MICROGRID, display_name: "Unit A", primary_phone: "+256700000001" }],
    ["tenants", { id: UNIT_B, microgrid_id: MICROGRID, display_name: "Unit B", primary_phone: "+256700000002" }],
    ["tenants", { id: UNIT_C, microgrid_id: MICROGRID, display_name: "Unit C", primary_phone: "+256700000003" }],
    ["tenants", { id: UNIT_D, microgrid_id: MICROGRID, display_name: "Unit D", primary_phone: "+256700000004" }],
    ["tenants", { id: UNIT_E, microgrid_id: MICROGRID, display_name: "Unit E", primary_phone: "+256700000005" }],
    ["tenant_devices", { tenant_id: UNIT_A, device_id: METER, role: "primary_consumption_meter", effective_from: "2026-09-01", effective_to: "2026-09-15" }],
    ["tenant_devices", { id: LINK_M_B, tenant_id: UNIT_B, device_id: METER, role: "primary_consumption_meter", effective_from: "2026-09-15", effective_to: null }],
    ["tenant_devices", { id: LINK_X, tenant_id: UNIT_A, device_id: METER_X, role: "secondary_meter", effective_from: "2026-09-01", effective_to: null }],
    // C: a secondary link on M from 25 August, and its own primary Meter C from 10 September.
    ["tenant_devices", { tenant_id: UNIT_C, device_id: METER, role: "secondary_meter", effective_from: "2026-08-25", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_C, device_id: METER_C, role: "primary_consumption_meter", effective_from: "2026-09-10", effective_to: null }],
    // D: a consumption meter, and a PV meter and an inverter as secondary meters.
    ["tenant_devices", { tenant_id: UNIT_D, device_id: METER_N, role: "primary_consumption_meter", effective_from: "2026-09-01", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_D, device_id: PV, role: "secondary_meter", effective_from: "2026-09-01", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_D, device_id: INVERTER, role: "secondary_meter", effective_from: "2026-09-01", effective_to: null }],
    // E: only a grid meter and a battery, each as primary in turn and as secondary throughout.
    ["tenant_devices", { tenant_id: UNIT_E, device_id: GRID, role: "primary_consumption_meter", effective_from: "2026-09-01", effective_to: "2026-09-15" }],
    ["tenant_devices", { tenant_id: UNIT_E, device_id: BATTERY, role: "primary_consumption_meter", effective_from: "2026-09-15", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_E, device_id: GRID, role: "secondary_meter", effective_from: "2026-09-01", effective_to: null }],
    ["tenant_devices", { tenant_id: UNIT_E, device_id: BATTERY, role: "secondary_meter", effective_from: "2026-09-01", effective_to: null }],
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
  tenantD = await createTestUser({ email: EMAIL_D, role: "tenant", scopeId: UNIT_D });
  tenantE = await createTestUser({ email: EMAIL_E, role: "tenant", scopeId: UNIT_E });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  vi.unstubAllEnvs();
  energySeries.mockRestore();
  await cleanupTestData({ orgIds: [ORG], userEmails: EMAILS });
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

async function home(user: TestUser, tenantId: string, now?: number): Promise<TenantHome> {
  const composed = await composeTenantApp({ supabase: user.client, tenantId, now: now === undefined ? undefined : () => now });
  if (!composed.ok) throw new Error(`composeTenantApp: ${composed.status} ${composed.code}`);
  try {
    const result = await composed.data.tenantApp.getHome();
    if (!result.ok) throw new Error(`getHome: ${result.status} ${result.code}`);
    return result.data;
  } finally {
    await composed.data.dispose();
  }
}

/** A device's generated figures, as the synthetic provider makes them for MICROGRID. */
function generatedFor(deviceId: string, startDate: string, endDate: string, resolution: "day" | "hour") {
  return generateDeviceEnergySeries({
    microgridId: MICROGRID,
    devices: [{ id: deviceId, edgeOpenemsId: `SYNTHETIC-EDGE-${MICROGRID}`, componentId: COMPONENT[deviceId] }],
    startDate,
    endDate,
    resolution,
    timezone: KAMPALA,
  }).kwh[deviceId];
}

/** Meter M's generated figures. */
const generated = (startDate: string, endDate: string, resolution: "day" | "hour") =>
  generatedFor(METER, startDate, endDate, resolution);

/** The device ids of every provider call so far, one sorted list per call. */
const askedDevices = () => energySeries.mock.calls.map(([request]) => request.devices.map((d) => d.id).sort());

/** Noon in Kampala on `date`. */
const noonOn = (date: string) => Date.parse(`${date}T12:00:00+03:00`);

const september = Array.from({ length: 30 }, (_, i) => addDaysToDateKey("2026-09-01", i));
const august = Array.from({ length: 31 }, (_, i) => addDaysToDateKey("2026-08-01", i));
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

describe.skipIf(shouldSkip())("which meters count as a unit's use (decided on #210, 19 November)", () => {
  it("counts only consumption meters", async () => {
    // The premise: D's own client reads the PV meter's and the inverter's rows.
    const visible = await tenantD.client.from("devices").select("id").in("id", [PV, INVERTER]).order("id");
    expect(visible).toMatchObject({ error: null, data: [{ id: PV }, { id: INVERTER }] });

    const shown = await usageMonth(tenantD, UNIT_D, "2026-09");
    const figures = generatedFor(METER_N, "2026-09-01", "2026-09-30", "day");
    expect(shown.days).toEqual(september.map((date, i) => ({ date, ...bucket(figures[i]) })));
    expect(shown.days.filter((d) => d.state === "data").length).toBeGreaterThan(10);

    const shownDay = await usageDay(tenantD, UNIT_D, "2026-09-10");
    const hours = generatedFor(METER_N, "2026-09-10", "2026-09-10", "hour");
    expect(shownDay.meters).toBe(1);
    expect(shownDay.hours).toEqual(localHourStarts("2026-09-10", KAMPALA).map((start, i) => ({ start, ...bucket(hours[i]) })));

    expect(askedDevices()).toEqual([[METER_N], [METER_N]]);
    expect((await home(tenantD, UNIT_D, noonOn("2026-09-20"))).meters.map((m) => m.deviceId)).toEqual([METER_N]);
  });

  it("never shows a grid meter or a battery, even when linked", async () => {
    // The premise: E's own client reads both device rows; the rule, not RLS, leaves them out.
    const visible = await tenantE.client.from("devices").select("id").in("id", [GRID, BATTERY]).order("id");
    expect(visible).toMatchObject({ error: null, data: [{ id: GRID }, { id: BATTERY }] });

    const shown = await usageMonth(tenantE, UNIT_E, "2026-09");
    expect(shown.days).toEqual(september.map((date) => ({ date, state: "no-meter", kwh: null })));
    expect(shown.total).toEqual({ kwh: null, withoutData: 0 });
    expect(shown.read.readAt).toBeNull();

    const shownDay = await usageDay(tenantE, UNIT_E, "2026-09-20");
    expect(shownDay.meters).toBe(0);
    expect(shownDay.hours.every((h) => h.state === "no-meter" && h.kwh === null)).toBe(true);

    expect(energySeries).not.toHaveBeenCalled();
    expect((await home(tenantE, UNIT_E, noonOn("2026-09-10"))).meters).toEqual([]);
    expect((await home(tenantE, UNIT_E, noonOn("2026-09-20"))).meters).toEqual([]);
  });

  describe("a secondary link on a meter that is another unit's primary", () => {
    it("never shows a secondary link's use on days its meter is another unit's primary", async () => {
      // M is A's primary from 1 to 14 September and B's from the 15th: none
      // of September is C's through the secondary link, and C's own meter
      // starts on the 10th.
      const shown = await usageMonth(tenantC, UNIT_C, "2026-09");
      const own = generatedFor(METER_C, "2026-09-10", "2026-09-30", "day");
      expect(shown.days.slice(0, 9)).toEqual(september.slice(0, 9).map((date) => ({ date, state: "no-meter", kwh: null })));
      expect(shown.days.slice(9)).toEqual(september.slice(9).map((date, i) => ({ date, ...bucket(own[i]) })));
      expect(energySeries.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({ devices: [expect.objectContaining({ id: METER_C })], startDate: "2026-09-10", endDate: "2026-09-30" }),
      ]);

      // Before the 1st, nobody's primary covers M: C's days from 25 August are M's.
      const shownAugust = await usageMonth(tenantC, UNIT_C, "2026-08");
      const m = generated("2026-08-25", "2026-08-31", "day");
      expect(shownAugust.days.slice(0, 24)).toEqual(august.slice(0, 24).map((date) => ({ date, state: "no-meter", kwh: null })));
      expect(shownAugust.days.slice(24)).toEqual(august.slice(24).map((date, i) => ({ date, ...bucket(m[i]) })));

      const shownDay = await usageDay(tenantC, UNIT_C, "2026-08-30");
      const hours = generated("2026-08-30", "2026-08-30", "hour");
      expect(shownDay.meters).toBe(1);
      expect(shownDay.hours).toEqual(localHourStarts("2026-08-30", KAMPALA).map((start, i) => ({ start, ...bucket(hours[i]) })));
      expect(askedDevices()).toEqual([[METER_C], [METER], [METER]]);

      // The home agrees with the calendar.
      expect((await home(tenantC, UNIT_C, noonOn("2026-09-20"))).meters.map((x) => x.deviceId)).toEqual([METER_C]);
      expect((await home(tenantC, UNIT_C, noonOn("2026-08-30"))).meters.map((x) => x.deviceId)).toEqual([METER]);

      // C still reads no other unit's link to M.
      const links = await tenantC.client.from("tenant_devices").select("tenant_id").eq("device_id", METER);
      expect(links).toMatchObject({ error: null, data: [{ tenant_id: UNIT_C }] });
    });

    it("never shows a secondary link's hours on a day its meter is another unit's primary", async () => {
      // 20 September: M is B's primary, so C's day is Meter C's alone and M is never asked for.
      const shownDay = await usageDay(tenantC, UNIT_C, "2026-09-20");
      const hours = generatedFor(METER_C, "2026-09-20", "2026-09-20", "hour");
      expect(shownDay.meters).toBe(1);
      expect(shownDay.hours).toEqual(
        localHourStarts("2026-09-20", KAMPALA).map((start, i) => ({ start, ...bucket(hours[i]) }))
      );
      expect(askedDevices()).toEqual([[METER_C]]);

      // 5 September: M is A's primary and Meter C has not started, so C has no meter that day.
      energySeries.mockClear();
      const before = await usageDay(tenantC, UNIT_C, "2026-09-05");
      expect(before.meters).toBe(0);
      expect(before.hours).toHaveLength(24);
      expect(before.hours.every((h) => h.state === "no-meter" && h.kwh === null)).toBe(true);
      expect(energySeries).not.toHaveBeenCalled();
    });

    describe("once the other unit's primary link is gone", () => {
      beforeAll(async () => {
        if (shouldSkip()) return;
        const svc = await serviceClient();
        const { error } = await svc.from("tenant_devices").delete().eq("id", LINK_M_B);
        if (error) throw new Error(`[tenant-usage.db] remove link: ${error.message}`);
      });

      it("counts the secondary link again on the days nobody else's primary covers", async () => {
        const shown = await usageMonth(tenantC, UNIT_C, "2026-09");
        const own = generatedFor(METER_C, "2026-09-10", "2026-09-30", "day");
        const m = generated("2026-09-15", "2026-09-30", "day");
        const sum = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a + b) * 1000) / 1000);

        expect(shown.days.slice(0, 9).every((d) => d.state === "no-meter")).toBe(true);
        expect(shown.days.slice(9, 14)).toEqual(september.slice(9, 14).map((date, i) => ({ date, ...bucket(own[i]) })));
        expect(shown.days.slice(14)).toEqual(september.slice(14).map((date, i) => ({ date, ...bucket(sum(own[i + 5], m[i])) })));
        expect(askedDevices()).toEqual([[METER, METER_C].sort()]);
        expect((await home(tenantC, UNIT_C, noonOn("2026-09-20"))).meters.map((x) => x.deviceId).sort()).toEqual(
          [METER, METER_C].sort()
        );
      });
    });
  });
});
