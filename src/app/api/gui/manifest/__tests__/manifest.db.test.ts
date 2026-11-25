/**
 * GET /api/gui/manifest against the local database, with the real runtime
 * and its registered navigation: a person whose rows are all tenant rows
 * gets their unit and the tenant entries only, and no organization; a
 * manager gets their organization's manifest with staff entries and no
 * tenant one. Both name the interface this installation renders.
 * src/lib/gui/host/server/__tests__/manifest.db.test.ts covers the builder's
 * reads.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Manifest } from "@/lib/gui/contract";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[manifest.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e8a00000-0000-4000-8000-000000000001";
const COMMUNITY = "e8a00000-0000-4000-8001-000000000001";
const MICROGRID = "e8a00000-0000-4000-8002-000000000001";
const TENANT = "e8a00000-0000-4000-8004-000000000001";
const TENANT_NAME = "Nakato Manifest-Canary";
const EMAIL = "gui-manifest-route-manager@test.local";
const TENANT_EMAIL = "gui-manifest-route-tenant@test.local";

/** The tenant app's navigation entries, the only ones with the tenant audience today. */
const TENANT_NAV = ["tenant.home", "tenant.usage"];

let manager: TestUser;
let tenantUser: TestUser;

async function manifest(query = ""): Promise<Manifest> {
  const res = await GET(new NextRequest(`http://localhost/api/gui/manifest${query}`, { headers: { "accept-language": "en-GB" } }));
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  return JSON.parse(text) as Manifest;
}

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().eq("org_id", ORG);
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL, TENANT_EMAIL] });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  vi.stubEnv("MGM_GUI", "");
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown>][] = [
    ["organizations", { id: ORG, name: "GUI Manifest Route Org" }],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "GUI Manifest Route Community" }],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Manifest route site", currency: "UGX", timezone: "Africa/Kampala" }],
    ["tenants", { id: TENANT, microgrid_id: MICROGRID, display_name: TENANT_NAME, unit_label: "Unit 7", primary_phone: "+256700000921" }],
    // The tenant app is off until an organization turns it on.
    ["mgm_plugins", { org_id: ORG, plugin_name: "tenant-app", version: "0.1.0", enabled: true }],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[manifest.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: TENANT });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
  vi.unstubAllEnvs();
}, 60_000);

describe.skipIf(shouldSkip())("GET /api/gui/manifest against the database", () => {
  it("gives a person whose rows are all tenant rows their unit and tenant entries only, and no organization", async () => {
    caller = tenantUser;
    const body = await manifest();
    expect(body).toMatchObject({ type: "manifest", gui: "gridtop", orgs: [] });
    expect(body.org).toMatchObject({ id: TENANT, name: "Unit 7" });
    expect(body.org.places.map((p) => [p.kind, p.id])).toEqual([["tenant", TENANT]]);
    expect(body.org.nav.map((n) => n.id).sort()).toEqual(TENANT_NAV);
    // Asking for the organization changes nothing: a tenant sees none.
    expect((await manifest(`?org=${ORG}`)).orgs).toEqual([]);
  });

  it("gives a manager their organization's manifest, with staff entries and no tenant one", async () => {
    caller = manager;
    const body = await manifest(`?path=${encodeURIComponent(`/microgrids/${MICROGRID}/billing`)}`);
    expect(body).toMatchObject({ type: "manifest", gui: "gridtop", org: { id: ORG, name: "GUI Manifest Route Org" } });
    expect(body.orgs.map((o) => o.id)).toEqual([ORG]);
    const nav = body.org.nav.map((n) => n.id);
    expect(nav.length).toBeGreaterThan(0);
    for (const id of TENANT_NAV) expect(nav).not.toContain(id);
    expect(body.org.places.map((p) => p.id)).toEqual(expect.arrayContaining([COMMUNITY, MICROGRID]));
    expect(JSON.stringify(body)).not.toContain(TENANT_NAME);
  });
});
