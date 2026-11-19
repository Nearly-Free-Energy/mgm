/**
 * GET /api/gui/view serves a microgrid's billing periods, `billing.periods`:
 * the route checks the session, the host resolves the microgrid through the
 * person's own client, and the loader reads the periods and their bills
 * through that client. Another organization's manager gets nothing, and
 * while billing is off the list still loads, with the gate's notice and
 * create disabled.
 *
 * The legacy page still serves /microgrids/[id]/billing in the browser; this
 * reaches the view only through the host's API.
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

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[periods.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";
import { DELETE } from "../../../billing-periods/[periodId]/route";

const ORG = "e7700000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7700000-0000-4000-8000-000000000002";
const COMMUNITY = "e7700000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7700000-0000-4000-8001-000000000002";
const MICROGRID = "e7700000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e7700000-0000-4000-8002-000000000002";
const TENANT = "e7700000-0000-4000-8004-000000000001";
const OCTOBER = "e7700000-0000-4000-8003-000000000001";
const NOVEMBER = "e7700000-0000-4000-8003-000000000002";
const EMAIL = "gui-periods-manager@test.local";
const OTHER_EMAIL = "gui-periods-other@test.local";
const TENANT_EMAIL = "gui-periods-tenant@test.local";

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;

const view = (href: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(href)}`));

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[periods.db] mgm_plugins: ${error.message}`);
}

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown>][] = [
    ["organizations", { id: ORG, name: "GUI Periods Org" }],
    ["organizations", { id: OTHER_ORG, name: "GUI Periods Other Org" }],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "GUI Periods Community" }],
    ["communities", { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Periods Other Community" }],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Periods site", currency: "UGX", timezone: "Africa/Kampala" }],
    ["microgrids", { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other site", currency: "UGX", timezone: "Africa/Kampala" }],
    ["tenants", { id: TENANT, microgrid_id: MICROGRID, display_name: "Unit 1", primary_phone: "+256700000001" }],
    // Both drafts, so the organization's delete in cleanup removes them.
    ["billing_periods", { id: OCTOBER, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala" }],
    ["billing_periods", { id: NOVEMBER, microgrid_id: MICROGRID, start_date: "2026-11-01", end_date: "2026-11-30", timezone: "Africa/Kampala" }],
    [
      "billing_line_items",
      { billing_period_id: OCTOBER, tenant_id: TENANT, usage_kwh: 120.5, total_amount: 300000 },
    ],
  ];
  for (const [table, row] of rows) {
    const { error } = await svc.from(table).insert(row);
    if (error) throw new Error(`[periods.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: TENANT });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
}, 60_000);

describe.skipIf(shouldSkip())("GET /api/gui/view: the billing periods", () => {
  it("returns the microgrid's periods, newest first, with their totals and actions", async () => {
    caller = manager;
    await setBilling(true);
    const res = await view(`/microgrids/${MICROGRID}/billing`);
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model).toMatchObject({
      type: "view",
      view: "billing.periods",
      kind: "collection",
      org: ORG,
      title: "Billing periods",
      entity: { kind: "microgrid", id: MICROGRID, label: "Periods site" },
    });
    expect(model).not.toHaveProperty("notice");
    expect(model.actions).toMatchObject([{ action: "billing.create-period", params: { microgrid_id: MICROGRID }, enabled: true }]);
    const rows = model.body.rows as { id: string; href: string; cells: Record<string, { t: string; v?: number }>; actions: { action: string; enabled: boolean }[] }[];
    expect(rows.map((r) => r.id)).toEqual([NOVEMBER, OCTOBER]);
    expect(rows[1].href).toBe(`/microgrids/${MICROGRID}/billing/${OCTOBER}`);
    expect(rows[1].cells.energy).toMatchObject({ t: "energy", v: 120.5 });
    expect(rows[1].cells.total).toMatchObject({ t: "money", v: 300000, currency: "UGX" });
    expect(rows[0].cells.total.t).toBe("empty");
    for (const row of rows) expect(row.actions).toMatchObject([{ action: "billing.delete-period", enabled: true }]);
  });

  it("gives another organization's manager nothing", async () => {
    caller = other;
    const res = await view(`/microgrids/${MICROGRID}/billing`);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("Periods site");
  });

  it("still loads while billing is off, with the gate's notice and create and delete disabled", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const res = await view(`/microgrids/${MICROGRID}/billing`);
      expect(res.status).toBe(200);
      const model = await res.json();
      expect(model.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("Billing is disabled") });
      expect(model.actions).toMatchObject([{ action: "billing.create-period", enabled: false, reason: model.notice.text }]);
      expect(model.body.rows).toHaveLength(2);
      for (const row of model.body.rows) expect(row.actions).toMatchObject([{ action: "billing.delete-period", enabled: false }]);
    } finally {
      await setBilling(true);
    }
  });

  // Who may delete is composeBilling's authorizeOrganization: a super admin or
  // the organization's own org manager. A tenant of the same microgrid is the
  // one other role that reaches these rows' microgrid, and is refused.
  it("refuses a tenant of the same microgrid the delete, by the route and directly", async () => {
    caller = tenantUser;
    const res = await DELETE(
      new NextRequest(`http://localhost/api/billing-periods/${NOVEMBER}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: { acknowledged: [], typed: "November 2026" } }),
      }),
      { params: Promise.resolve({ periodId: NOVEMBER }) },
    );
    expect([403, 404]).toContain(res.status);
    const { data: direct } = await tenantUser.client.from("billing_periods").delete().eq("id", NOVEMBER).select("id");
    expect(direct ?? []).toEqual([]);
    const svc = await serviceClient();
    const { data } = await svc.from("billing_periods").select("id").eq("id", NOVEMBER);
    expect(data).toEqual([{ id: NOVEMBER }]);
  });
});
