/**
 * GET /api/gui/view serves the tenants with no bill for a period,
 * `billing.not-billed`, a section of the period review: the host resolves
 * the microgrid and the period through the person's own client, and the
 * loader reads the period, its bills and the microgrid's tenants with their
 * primary meter links through that client. Each tenant with no bill is
 * listed with why, a billed tenant is left out, and Bill from readings is
 * offered on each row of a draft, not of a closed period, which also leaves
 * out a tenant who joined after it. While billing is
 * off the section still loads, with the gate's notice and the action
 * disabled, and the review still lists it. Another organization's manager
 * and a tenant get nothing.
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
    if (!caller) throw new Error("[not-billed.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e7d10000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7d10000-0000-4000-8000-000000000002";
const COMMUNITY = "e7d10000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7d10000-0000-4000-8001-000000000002";
const MICROGRID = "e7d10000-0000-4000-8002-000000000001";
const SECOND = "e7d10000-0000-4000-8002-000000000002";
const EDGE = "e7d10000-0000-4000-8009-000000000001";
const SCHEDULE = "e7d10000-0000-4000-8006-000000000001";
const DRAFT = "e7d10000-0000-4000-8003-000000000001";
const CLOSED = "e7d10000-0000-4000-8003-000000000002";
const tenant = (n: number) => `e7d10000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const device = (n: number) => `e7d10000-0000-4000-8007-${String(n).padStart(12, "0")}`;
const EMAIL = "gui-not-billed-manager@test.local";
const OTHER_EMAIL = "gui-not-billed-other@test.local";
const TENANT_EMAIL = "gui-not-billed-tenant@test.local";

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;

const href = (periodId = DRAFT, microgridId = MICROGRID) => `/microgrids/${microgridId}/billing/${periodId}/not-billed`;
const view = (path: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(path)}`, { headers: { "accept-language": "en-GB" } }));

type Action = { action: string; params: Record<string, string>; label: string; enabled: boolean; reason?: string };
type Row = { id: string; entity: { kind: string; id: string; href?: string }; cells: { reason: { text: string } }; actions: Action[] };
type Model = {
  view: string;
  kind: string;
  org: string;
  title: string;
  notice?: { tone: string; text: string };
  attached: { view: string; title: string; href: string; hint: string }[];
  body: { rows: Row[]; empty: { title: string } };
};
const loaded = async (path: string): Promise<Model> => {
  const res = await view(path);
  expect(res.status).toBe(200);
  return (await res.json()) as Model;
};

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[not-billed.db] mgm_plugins: ${error.message}`);
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
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Not Billed Org" }, { id: OTHER_ORG, name: "GUI Not Billed Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Not Billed Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Not Billed Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Not billed site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: SECOND, community_id: COMMUNITY, name: "Second not billed site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    ["rate_schedules", { id: SCHEDULE, microgrid_id: MICROGRID, tiers: [{ label: "Lifeline", min_kwh: 1, max_kwh: null, rate_per_kwh: 250 }], service_charge: 0, tax_rate: 0 }],
    ["edges", { id: EDGE, microgrid_id: MICROGRID, name: "Not billed edge", openems_edge_id: "not-billed-edge" }],
    [
      "devices",
      [1, 3, 4].map((n) => ({ id: device(n), edge_id: EDGE, name: `Meter ${n}`, device_type: "consumption_meter", openems_component_id: `meter${n}` })),
    ],
    // 1 metered, no bill; 2 no meter; 3 a meter assigned after the period began; 4 metered, billed; 5 on the second microgrid;
    // 6 no meter, recorded in October, after the closed September period. All but 6 recorded in January.
    [
      "tenants",
      [
        ...[1, 2, 3, 4].map((n) => ({
          id: tenant(n),
          microgrid_id: MICROGRID,
          display_name: `Unit ${n}`,
          primary_phone: `+2567000007${String(n).padStart(2, "0")}`,
          created_at: "2026-01-01T06:00:00+00:00",
        })),
        { id: tenant(5), microgrid_id: SECOND, display_name: "Unit 5", primary_phone: "+256700000705", created_at: "2026-01-01T06:00:00+00:00" },
        { id: tenant(6), microgrid_id: MICROGRID, display_name: "Unit 6", primary_phone: "+256700000706", created_at: "2026-10-10T06:00:00+00:00" },
      ],
    ],
    [
      "tenant_devices",
      [
        { tenant_id: tenant(1), device_id: device(1), role: "primary_consumption_meter", effective_from: "2026-01-01" },
        { tenant_id: tenant(3), device_id: device(3), role: "primary_consumption_meter", effective_from: "2026-10-15" },
        { tenant_id: tenant(4), device_id: device(4), role: "primary_consumption_meter", effective_from: "2026-01-01" },
      ],
    ],
    [
      "billing_periods",
      [
        { id: DRAFT, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft", rate_schedule_id: SCHEDULE },
        {
          id: CLOSED,
          microgrid_id: MICROGRID,
          start_date: "2026-09-01",
          end_date: "2026-09-30",
          timezone: "Africa/Kampala",
          status: "closed",
          closed_at: new Date().toISOString(),
          rate_schedule_id: SCHEDULE,
        },
      ],
    ],
    [
      "billing_line_items",
      [DRAFT, CLOSED].map((periodId) => ({
        billing_period_id: periodId,
        tenant_id: tenant(4),
        device_id: device(4),
        usage_kwh: 10,
        tier_breakdown: [{ label: "Lifeline", kwh: 10, amount: 2500 }],
        total_amount: 2500,
        reading_source: "edge",
        payment_status: "unpaid",
      })),
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[not-billed.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
  await setBilling(true);
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
}, 60_000);

describe.skipIf(shouldSkip())("GET /api/gui/view: the tenants not billed for a period", () => {
  it("lists each tenant with no bill and why, leaves billed tenants out, and offers Bill from readings on a draft", async () => {
    caller = manager;
    const model = await loaded(href());
    expect(model).toMatchObject({ view: "billing.not-billed", kind: "collection", org: ORG, title: "Tenants not billed" });
    expect(model).not.toHaveProperty("notice");
    expect(model.body.rows.map((r) => [r.id, r.cells.reason.text])).toEqual([
      [tenant(1), "No bill from its meter yet"],
      [tenant(2), "No meter for this period"],
      [tenant(3), "Meter assignment gap in this period"],
      [tenant(6), "No meter for this period"],
    ]);
    expect(model.body.rows[0].entity).toMatchObject({ kind: "tenant", id: tenant(1), href: `/microgrids/${MICROGRID}/setup/tenants/${tenant(1)}` });
    for (const row of model.body.rows) {
      expect(row.actions).toEqual([
        { action: "billing.bill-from-readings", params: { periodId: DRAFT, tenantId: row.id }, label: "Bill from readings", enabled: true },
      ]);
    }
  });

  it("lists a closed period's tenants not billed with no action, leaving out a tenant who joined after it", async () => {
    caller = manager;
    const model = await loaded(href(CLOSED));
    expect(model.body.rows.map((r) => [r.id, r.cells.reason.text])).toEqual([
      [tenant(1), "No bill from its meter for this period"],
      [tenant(2), "No meter for this period"],
      [tenant(3), "Meter assignment gap in this period"],
    ]);
    for (const row of model.body.rows) expect(row.actions).toEqual([]);
  });

  it("is listed on the period review as a section", async () => {
    caller = manager;
    const review = await loaded(`/microgrids/${MICROGRID}/billing/${DRAFT}`);
    expect(review.attached).toContainEqual({ view: "billing.not-billed", title: "Tenants not billed", href: href(), hint: "section" });
  });

  it("still loads while billing is off, with the gate's notice and the action disabled, and stays listed on the review", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const model = await loaded(href());
      expect(model.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("Billing is disabled") });
      expect(model.body.rows).toHaveLength(4);
      for (const row of model.body.rows) expect(row.actions).toEqual([expect.objectContaining({ action: "billing.bill-from-readings", enabled: false })]);
      const review = await loaded(`/microgrids/${MICROGRID}/billing/${DRAFT}`);
      expect(review.attached).toContainEqual({ view: "billing.not-billed", title: "Tenants not billed", href: href(), hint: "section" });
    } finally {
      await setBilling(true);
    }
  });

  it("finds no period under another microgrid", async () => {
    caller = manager;
    expect((await view(href(DRAFT, SECOND))).status).toBe(404);
  });

  it.each([
    ["another organization's manager", () => other],
    ["a tenant of the microgrid", () => tenantUser],
  ])("gives %s nothing", async (_label, who) => {
    caller = who();
    const res = await view(href());
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Unit 1");
    expect(text).not.toContain("Not billed site");
  });
});
