/**
 * GET /api/gui/view serves the Operations day, `metering.site-day`, for a
 * microgrid whose edge carries a reserved `SYNTHETIC-EDGE-` id, with
 * MGM_METERING_FIXTURES on: the route checks the session, the host resolves
 * the microgrid through the person's own client, and the loader reads the
 * generated day through the metering capability.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
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
    if (!manager) throw new Error("[site-day.db] no caller");
    return manager.client;
  },
}));

import { SYNTHETIC_NOTICE } from "@/lib/gui/host/server/view";
import { SITE_DAY_KEYS } from "@/lib/metering/surface/site-day-model";
import { GET } from "../route";

const ORG = "e7600000-0000-4000-8000-000000000001";
const COMMUNITY = "e7600000-0000-4000-8001-000000000001";
const MICROGRID = "e7600000-0000-4000-8002-000000000001";
const EDGE = "e7600000-0000-4000-8003-000000000001";
const EMAIL = "gui-site-day-manager@test.local";

const view = (href: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(href)}`));

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Read when the root loads its platform plugins, on the first request below.
  vi.stubEnv("MGM_METERING_FIXTURES", "1");
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown>][] = [
    ["organizations", { id: ORG, name: "GUI Site Day Org" }],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "GUI Site Day Community" }],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Synthetic site", currency: "UGX", timezone: "Africa/Kampala" }],
    ["edges", { id: EDGE, microgrid_id: MICROGRID, name: "Synthetic edge", openems_edge_id: `SYNTHETIC-EDGE-${MICROGRID}` }],
    ["devices", { edge_id: EDGE, name: "Battery", device_type: "battery", openems_component_id: "ess0" }],
    ["devices", { edge_id: EDGE, name: "Grid meter", device_type: "grid_meter", openems_component_id: "meter0" }],
  ];
  for (const [table, row] of rows) {
    const { error } = await svc.from(table).insert(row);
    if (error) throw new Error(`[site-day.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  vi.unstubAllEnvs();
  manager = null;
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
}, 60_000);

describe.skipIf(shouldSkip())("GET /api/gui/view: the Operations day", () => {
  it("returns the generated day's model, marked synthetic", async () => {
    const res = await view(`/microgrids/${MICROGRID}/operations?date=2026-11-01`);
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model).toMatchObject({
      type: "view",
      view: "metering.site-day",
      kind: "metrics",
      org: ORG,
      title: "Operations",
      entity: { kind: "microgrid", id: MICROGRID, label: "Synthetic site" },
      notice: SYNTHETIC_NOTICE,
      ext: { schema: "metering.site-day@1", data: { state: "day", date: "2026-11-01", synthetic: true } },
    });
    const tiles = model.body.tiles as { key: string; value: { synthetic?: true } }[];
    expect(tiles.map((t) => t.key)).toEqual(SITE_DAY_KEYS.filter((k) => k !== "soc" && k !== "setup"));
    expect(tiles.every((t) => t.value.synthetic === true)).toBe(true);
    expect(model.body.series.map((s: { key: string }) => s.key)).toEqual(["soc"]);
    const ops = `/microgrids/${MICROGRID}/operations`;
    expect(model.links.map((l: { href: string }) => l.href)).toEqual(
      expect.arrayContaining([`${ops}?date=2026-10-31`, `${ops}?date=2026-11-02`]),
    );
  });

  it("shows yesterday in the microgrid's zone when the date is not one it can show", async () => {
    const yesterday = new Date(Date.now() + 3 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
    const res = await view(`/microgrids/${MICROGRID}/operations?date=2999-01-01`);
    expect(res.status).toBe(200);
    expect((await res.json()).ext.data.date).toBe(yesterday);
  });
});
