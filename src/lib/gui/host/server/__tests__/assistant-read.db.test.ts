/**
 * The assistant read interface (../assistant-read.ts) against a database:
 * `metering.site-day`, as listed in src/lib/gui/assistant-reads.ts, read for
 * an organization manager through their own client, with
 * MGM_METERING_FIXTURES on and the microgrid's edge carrying a reserved
 * `SYNTHETIC-EDGE-` id, so the day is generated (#133, the read interface's
 * database case).
 *
 * The microgrid's address, its devices and its tenant carry canary text. The
 * answer must hold none of it: no device name (the loader reads them only to
 * order devices, so this holds by construction today and stays as the
 * guard), no free-text country (the time zone notice is withheld), and no
 * tenant name. The houses' evening figure, read through the tenant's meter
 * link, must still be there.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let manager: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!manager) throw new Error("[assistant-read.db] no caller");
    return manager.client;
  },
}));

import { getCurrentUserAccess } from "@/lib/auth/access";
import { readForAssistant, WITHHELD_NOTE } from "../assistant-read";
import { createFmt } from "../../../fmt";
import { hostContext } from "../access";
import { BROWSER } from "@/lib/runtime/caller";

const ORG = "e7ad0000-0000-4000-8000-000000000001";
const COMMUNITY = "e7ad0000-0000-4000-8001-000000000001";
const MICROGRID = "e7ad0000-0000-4000-8002-000000000001";
const EDGE = "e7ad0000-0000-4000-8003-000000000001";
const HOUSE_METER = "e7ad0000-0000-4000-8004-000000000001";
const TENANT = "e7ad0000-0000-4000-8005-000000000001";
const EMAIL = "assistant-read-manager@test.local";

const COUNTRY = "CANARY-COUNTRY-7f20";
const DEVICE = "CANARY-DEVICE-7f20";
const TENANT_NAME = "CANARY-TENANT-7f20";

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Read when the root loads its platform plugins, on the first read below.
  vi.stubEnv("MGM_METERING_FIXTURES", "1");
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown>][] = [
    ["organizations", { id: ORG, name: "Assistant Read Org" }],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "Assistant Read Community" }],
    // Still on UTC while its address implies another zone: the page shows the time zone notice.
    [
      "microgrids",
      { id: MICROGRID, community_id: COMMUNITY, name: "Synthetic site", currency: "UGX", timezone: "UTC", address_country: COUNTRY, lat: 0.3, lng: 32.6 },
    ],
    ["edges", { id: EDGE, microgrid_id: MICROGRID, name: "Synthetic edge", openems_edge_id: `SYNTHETIC-EDGE-${MICROGRID}` }],
    ["devices", { edge_id: EDGE, name: `${DEVICE}-battery`, device_type: "battery", openems_component_id: "ess0" }],
    ["devices", { edge_id: EDGE, name: `${DEVICE}-grid`, device_type: "grid_meter", openems_component_id: "meter0" }],
    ["devices", { edge_id: EDGE, name: `${DEVICE}-pv`, device_type: "inverter", openems_component_id: "meter2" }],
    ["devices", { id: HOUSE_METER, edge_id: EDGE, name: `${DEVICE}-house`, device_type: "consumption_meter", openems_component_id: "meter1" }],
    ["tenants", { id: TENANT, microgrid_id: MICROGRID, display_name: TENANT_NAME, primary_phone: "+256700000001" }],
    ["tenant_devices", { tenant_id: TENANT, device_id: HOUSE_METER, role: "primary_consumption_meter", effective_from: "2026-10-01", effective_to: null }],
  ];
  for (const [table, row] of rows) {
    const { error } = await svc.from(table).insert(row);
    if (error) throw new Error(`[assistant-read.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  vi.unstubAllEnvs();
  manager = null;
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
}, 60_000);

describe.skipIf(shouldSkip())("readForAssistant: metering.site-day against a database", () => {
  async function read(href: string) {
    const client = manager!.client;
    const host = hostContext(await getCurrentUserAccess(client), new Headers({ "accept-language": "en-GB" }), {
      newClient: async () => client,
      makeFmt: (locale) => createFmt({ locale }),
      caller: BROWSER,
    });
    if (!host.ok) throw new Error(`[assistant-read.db] context refused: ${host.code}`);
    return readForAssistant(host.ctx, { type: "view", href, org: ORG });
  }

  it("serves the day with the houses' evening figure, and no device name, tenant name or country", async () => {
    const out = await read(`/microgrids/${MICROGRID}/operations?date=2026-11-01`);
    if (!out.ok) throw new Error(`[assistant-read.db] refused: ${out.code}`);
    expect(out.value).toMatchObject({ view: "metering.site-day", org: ORG, cost: "vendor", ext: "metering.site-day@2" });
    expect(out.value.model.ext?.data).toMatchObject({ state: "day", synthetic: true, timezoneNotice: null, sources: { houses: true } });
    expect(out.value.withheld).toContainEqual({ what: "field", path: "ext.data.timezoneNotice", note: WITHHELD_NOTE });

    expect(out.value.model.kind).toBe("metrics");
    const tiles = out.value.model.kind === "metrics" ? out.value.model.body.tiles : [];
    const houses = tiles.find((t) => t.key === "houses-evening");
    expect(houses?.value.t).toBe("energy");

    const json = JSON.stringify(out);
    expect(json).not.toContain(DEVICE);
    expect(json).not.toContain(TENANT_NAME);
    expect(json).not.toContain(COUNTRY);
    expect(json).not.toContain("Billing timezone is still UTC");
    expect(json).not.toContain("metering.set-timezone");
  });
});
