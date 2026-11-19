/**
 * GET /api/gui/view serves a tenant their unit's use, `tenant.usage-month`
 * and `tenant.usage-day` (RFC mgm#197 § 5), with MGM_METERING_FIXTURES on so
 * the synthetic provider answers for microgrids whose edges carry
 * `SYNTHETIC-EDGE-` ids: the route checks the session, the host picks the
 * unit among the caller's tenant rows, and the loader reads through
 * composeTenantApp and the usage source, which reads the edges and builds
 * the provider on the service role.
 *
 * One meter M moves from unit A to unit B on 15 September 2026. From then,
 * unit A's primary meter is a meter X on an edge of another microgrid of the
 * same organization (linked with the service role, which no app path would
 * do: fn_create_tenant refuses a meter of another microgrid). A's own client
 * reads X's device row, but the usage source reads edges only of A's
 * microgrid, so X is never sent to a provider and every day X is in force
 * has no data.
 * The capability's own database test (src/lib/tenant-app/__tests__/usage.db.test.ts)
 * checks the same facts below the host; this one checks them as the page
 * receives them, and that staff and another unit's tenant get nothing.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
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

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[tenant-usage.db] no caller");
    return caller.client;
  },
}));

import { SYNTHETIC_NOTICE } from "@/lib/gui/host/server/view";
import { FixtureMeteringProvider } from "@/lib/metering/fixture-provider";
import { generateDeviceEnergySeries } from "@/lib/metering/fixture/meter-energy";
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { _resetTenantUsageCacheForTests } from "@/lib/tenant-app/usage-throttle";
import { addDaysToDateKey } from "@/lib/timezone/day-key";
import { GET } from "../route";

const ORG = "e7800000-0000-4000-8000-000000000001";
const COMMUNITY = "e7800000-0000-4000-8001-000000000001";
const MICROGRID = "e7800000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e7800000-0000-4000-8002-000000000002";
const EDGE = "e7800000-0000-4000-8003-000000000001";
const OTHER_EDGE = "e7800000-0000-4000-8003-000000000002";
const METER = "e7800000-0000-4000-8004-000000000001";
const METER_X = "e7800000-0000-4000-8004-000000000002";
const UNIT_A = "e7800000-0000-4000-8005-000000000001";
const UNIT_B = "e7800000-0000-4000-8005-000000000002";
const LINK_X = "e7800000-0000-4000-8006-000000000001";
const EMAIL_A = "gui-tenant-usage-a@test.local";
const EMAIL_B = "gui-tenant-usage-b@test.local";
const EMAIL_MANAGER = "gui-tenant-usage-manager@test.local";
const EMAILS = [EMAIL_A, EMAIL_B, EMAIL_MANAGER];
const KAMPALA = "Africa/Kampala";

let tenantA: TestUser;
let tenantB: TestUser;
let manager: TestUser;

const energySeries = vi.spyOn(FixtureMeteringProvider.prototype, "getDeviceEnergySeries");

async function view(user: TestUser, href: string) {
  caller = user;
  try {
    const res = await GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(href)}`));
    return { status: res.status, body: await res.json() };
  } finally {
    caller = null;
  }
}

type Cell = { t: string; text: string; v?: number; synthetic?: true };
type Row = { id: string; cells: Record<string, Cell> };

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Read when the root loads its platform plugins, on the first request below.
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
    ["organizations", { id: ORG, name: "GUI Tenant Usage Org" }],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "GUI Tenant Usage Community" }],
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
    ["tenant_devices", { id: LINK_X, tenant_id: UNIT_A, device_id: METER_X, role: "primary_consumption_meter", effective_from: "2026-09-15", effective_to: null }],
    // The tenant app is off without a row (defaultEnabled in src/lib/plugins/bundled.ts).
    ["mgm_plugins", { org_id: ORG, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled: true }],
  ];
  for (const [table, row] of rows) {
    const { error } = await svc.from(table).insert(row);
    if (error) throw new Error(`[tenant-usage.db] ${table}: ${error.message}`);
  }
  tenantA = await createTestUser({ email: EMAIL_A, role: "tenant", scopeId: UNIT_A });
  tenantB = await createTestUser({ email: EMAIL_B, role: "tenant", scopeId: UNIT_B });
  manager = await createTestUser({ email: EMAIL_MANAGER, role: "org_manager", scopeId: ORG });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  vi.unstubAllEnvs();
  energySeries.mockRestore();
  caller = null;
  await cleanupTestData({ orgIds: [ORG], userEmails: EMAILS });
}, 60_000);

beforeEach(() => {
  _resetTenantUsageCacheForTests();
  energySeries.mockClear();
});

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

/** A row's use as the figure it shows, or its text when it shows none. */
const shown = (row: Row) => (row.cells.usage.t === "energy" ? row.cells.usage.v : row.cells.usage.text);
const expected = (kwh: number | null) => (kwh === null ? "No data" : kwh);
const close = (actual: (number | string | undefined)[], wanted: (number | string)[]) =>
  actual.forEach((value, i) => (typeof wanted[i] === "number" ? expect(value).toBeCloseTo(wanted[i] as number, 9) : expect(value).toBe(wanted[i])));

describe.skipIf(shouldSkip())("GET /api/gui/view: a tenant's use", () => {
  it("shows unit B its month from the day the meter moved in, generated and marked so", async () => {
    const { status, body } = await view(tenantB, "/my/usage?month=2026-09");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      type: "view",
      view: "tenant.usage-month",
      kind: "collection",
      org: null,
      trail: [],
      actions: [],
      links: [],
      title: "September 2026",
      entity: { kind: "tenant", id: UNIT_B, label: "Unit B" },
      notice: SYNTHETIC_NOTICE,
      ext: { schema: "tenant.usage-month@1", data: { month: "2026-09", synthetic: true, problem: null } },
    });
    const rows = body.body.rows as Row[];
    expect(rows.map((r) => r.id)).toEqual(september);
    for (const row of rows.slice(0, 14)) {
      expect(row.cells, row.id).toMatchObject({ usage: { text: "No data" }, note: { text: "No meter on this day" } });
    }
    close(rows.slice(14).map(shown), generated("2026-09-15", "2026-09-30", "day").map(expected));
    expect(rows.slice(14).filter((r) => r.cells.usage.synthetic).length).toBeGreaterThan(10);

    expect(energySeries).toHaveBeenCalledTimes(1);
    expect(energySeries.mock.calls[0][0]).toMatchObject({ microgridId: MICROGRID, startDate: "2026-09-15", endDate: "2026-09-30", resolution: "day" });
  });

  it("shows unit B the hours of one of its days", async () => {
    const { status, body } = await view(tenantB, "/my/usage/day?date=2026-09-20");
    expect(status).toBe(200);
    expect(body).toMatchObject({ view: "tenant.usage-day", notice: SYNTHETIC_NOTICE, ext: { data: { date: "2026-09-20", meters: 1 } } });
    const rows = body.body.rows as Row[];
    expect(rows).toHaveLength(24);
    expect(rows[0].cells.hour.text).toBe("00:00");
    close(rows.map(shown), generated("2026-09-20", "2026-09-20", "hour").map(expected));
  });

  it("never sends unit A's meter on another microgrid's edge, so every day it is in force has no data", async () => {
    const { status, body } = await view(tenantA, "/my/usage?month=2026-09");
    expect(status).toBe(200);
    const rows = body.body.rows as Row[];
    // M's figures to the 14th, then X's days, which have none; the total
    // is M's days, with X's left out and said so.
    close(rows.slice(0, 14).map(shown), generated("2026-09-01", "2026-09-14", "day").map(expected));
    expect(rows.slice(14).map((r) => [r.id, r.cells.usage.text, r.cells.note?.text ?? null])).toEqual(
      september.slice(14).map((d) => [d, "No data", null])
    );
    const missing = 16 + generated("2026-09-01", "2026-09-14", "day").filter((v) => v === null).length;
    expect(body.body.totals.note).toEqual({ t: "text", text: `${missing} days missing` });
    expect(body.body.totals.usage).toMatchObject({ t: "energy", synthetic: true });
    expect(body.ext.data.problem).toBeNull();
    expect(energySeries).toHaveBeenCalledTimes(1);
    const [asked] = energySeries.mock.calls[0];
    expect(asked.microgridId).toBe(MICROGRID);
    expect(asked.devices.map((d) => d.id)).toEqual([METER]);
    // Nothing of either microgrid's meters or edges reaches the page.
    const text = JSON.stringify(body);
    for (const hidden of [METER, METER_X, EDGE, OTHER_EDGE, MICROGRID, OTHER_MICROGRID, ORG, "SYNTHETIC-EDGE", "meter1"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("gives staff, and a tenant naming another unit, the answer a missing page gets", async () => {
    for (const href of ["/my/usage?month=2026-09", "/my/usage/day?date=2026-09-20"]) {
      expect((await view(manager, href)).status, href).toBe(404);
      expect((await view(tenantA, `${href}&unit=${UNIT_B}`)).status, href).toBe(404);
    }
    expect(energySeries).not.toHaveBeenCalled();
  });

  describe("once the link to the other microgrid's meter is gone", () => {
    beforeAll(async () => {
      if (shouldSkip()) return;
      const svc = await serviceClient();
      const { error } = await svc.from("tenant_devices").delete().eq("id", LINK_X);
      if (error) throw new Error(`[tenant-usage.db] remove link: ${error.message}`);
    });

    it("shows unit A the meter up to the day it moved out, and no meter after", async () => {
      const { status, body } = await view(tenantA, "/my/usage?month=2026-09");
      expect(status).toBe(200);
      const rows = body.body.rows as Row[];
      close(rows.slice(0, 14).map(shown), generated("2026-09-01", "2026-09-14", "day").map(expected));
      for (const row of rows.slice(14)) {
        expect(row.cells, row.id).toMatchObject({ usage: { text: "No data" }, note: { text: "No meter on this day" } });
      }
    });

    it("shows unit A the empty state for a day after it moved out, without reading", async () => {
      const { status, body } = await view(tenantA, "/my/usage/day?date=2026-09-20");
      expect(status).toBe(200);
      expect(body.body.rows).toEqual([]);
      expect(body.body.empty).toEqual({ title: "No data", text: "No meter of this unit was in use on this day." });
      expect(body).not.toHaveProperty("notice");
      expect(energySeries).not.toHaveBeenCalled();
    });
  });
});
