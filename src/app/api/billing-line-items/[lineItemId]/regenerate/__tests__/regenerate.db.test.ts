/**
 * POST /api/billing-line-items/[lineItemId]/regenerate against a live
 * database: the route reads the bill through the person's own client,
 * composes billing for the bill's organization and regenerates that one
 * bill through the capability's audit-aware write. In a period with several
 * bills only the one asked for changes, and its audit row is written;
 * another organization's manager finds nothing (404); a refunded bill is
 * refused (409); and a paid bill is refused without the acknowledgement its
 * prepare asks for (428), with nothing written.
 *
 * Manual readings throughout, so no metering provider is read.
 *
 * Self-fixturing. Requires a running local Supabase (same harness as
 * rls.test.ts).
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
    if (!caller) throw new Error("[regenerate.db] no caller");
    return caller.client;
  },
}));

import { REGENERATE_PAID_ACKNOWLEDGEMENT } from "@/lib/billing/schemas";
import { POST } from "../route";

const ORG = "e7900000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7900000-0000-4000-8000-000000000002";
const COMMUNITY = "e7900000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7900000-0000-4000-8001-000000000002";
const MICROGRID = "e7900000-0000-4000-8002-000000000001";
const SCHEDULE = "e7900000-0000-4000-8006-000000000001";
const DRAFT = "e7900000-0000-4000-8003-000000000001";
const tenant = (n: number) => `e7900000-0000-4000-8004-00000000000${n}`;
const bill = (n: number) => `e7900000-0000-4000-8005-00000000000${n}`;
const EMAIL = "regenerate-db-manager@test.local";
const OTHER_EMAIL = "regenerate-db-other@test.local";

let manager: TestUser;
let other: TestUser;

const regenerate = (id: string, body: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/billing-line-items/${id}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "accept-language": "en" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ lineItemId: id }) },
  );

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL] });
}

/** A manual bill of 50 kWh totalling 30,000, as stored: regeneration recomputes it from the readings. */
const row = (n: number, o: Record<string, unknown> = {}) => ({
  id: bill(n),
  billing_period_id: DRAFT,
  tenant_id: tenant(n),
  start_kwh: 100,
  end_kwh: 150,
  usage_kwh: 50,
  tier_breakdown: [
    { label: "Lifeline", kwh: 15, amount: 3750 },
    { label: "Standard", kwh: 35, amount: 26250 },
  ],
  total_amount: 30000,
  reading_source: "manual",
  payment_status: "unpaid",
  paid_at: null,
  ...o,
});

type BillRow = { id: string; start_kwh: number; end_kwh: number; usage_kwh: number; total_amount: number; payment_status: string; reading_source: string };

async function bills(): Promise<Map<string, BillRow>> {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("id, start_kwh, end_kwh, usage_kwh, total_amount, payment_status, reading_source")
    .eq("billing_period_id", DRAFT);
  if (error) throw new Error(`[regenerate.db] bills: ${error.message}`);
  return new Map(((data ?? []) as BillRow[]).map((b) => [b.id, { ...b, start_kwh: Number(b.start_kwh), end_kwh: Number(b.end_kwh), usage_kwh: Number(b.usage_kwh), total_amount: Number(b.total_amount) }]));
}

async function auditRows(): Promise<{ billing_line_item_id: string | null; event_type: string; details: Record<string, unknown> }[]> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_audit_log").select("billing_line_item_id, event_type, details").eq("billing_period_id", DRAFT);
  if (error) throw new Error(`[regenerate.db] billing_audit_log: ${error.message}`);
  return (data ?? []) as { billing_line_item_id: string | null; event_type: string; details: Record<string, unknown> }[];
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const paidAt = new Date().toISOString();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "Regenerate DB Org" }, { id: OTHER_ORG, name: "Regenerate DB Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "Regenerate DB Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "Regenerate DB Other Community" },
      ],
    ],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Regenerate site", currency: "UGX", timezone: "Africa/Kampala" }],
    [
      "rate_schedules",
      {
        id: SCHEDULE,
        microgrid_id: MICROGRID,
        // As the tariff routes take tiers (tariffsTierFault in src/lib/billing/schemas.ts):
        // whole kWh from 1, each tier's bounds inclusive, each min one more than the
        // previous max. calculateTieredCost gives a tier max - min + 1 kWh, so
        // Lifeline holds 15 kWh, as the stored breakdowns below have it.
        tiers: [
          { label: "Lifeline", min_kwh: 1, max_kwh: 15, rate_per_kwh: 250 },
          { label: "Standard", min_kwh: 16, max_kwh: null, rate_per_kwh: 750 },
        ],
        service_charge: 0,
        tax_rate: 0,
      },
    ],
    ["tenants", [1, 2, 3, 4].map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+25670000090${n}` }))],
    [
      "billing_periods",
      { id: DRAFT, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft", rate_schedule_id: SCHEDULE },
    ],
    [
      "billing_line_items",
      [row(1), row(2), row(3, { payment_status: "refunded", paid_at: paidAt }), row(4, { payment_status: "paid", paid_at: paidAt })],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[regenerate.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
}, 60_000);

describe.skipIf(shouldSkip())("POST /api/billing-line-items/[lineItemId]/regenerate (live database)", () => {
  it("regenerates only the bill asked for, in a period with several, and writes its audit row", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();

    const res = await regenerate(bill(1), { readings: "manual", start_kwh: 100, end_kwh: 160, reason: "dial photo" });
    expect(res.status).toBe(200);
    // 60 kWh: 15 at 250 (3,750) and 45 at 750 (33,750).
    expect(await res.json()).toMatchObject({
      lineItemId: bill(1),
      totalAmount: 37500,
      previousTotalAmount: 30000,
      message: expect.stringMatching(/^Regenerated the bill\. Its total was .*30,000 and is now .*37,500\.$/),
    });

    const after = await bills();
    expect(after.get(bill(1))).toMatchObject({ start_kwh: 100, end_kwh: 160, usage_kwh: 60, total_amount: 37500, reading_source: "manual", payment_status: "unpaid" });
    for (const n of [2, 3, 4]) expect(after.get(bill(n)), `bill ${n} is unchanged`).toEqual(before.get(bill(n)));

    // One audit row was added, for that bill.
    const auditAfter = await auditRows();
    expect(auditAfter).toHaveLength(auditBefore.length + 1);
    const mine = auditAfter.filter((a) => a.billing_line_item_id === bill(1));
    expect(mine).toEqual([expect.objectContaining({ event_type: "line_item_regenerated" })]);
    expect(mine[0].details).toMatchObject({ previous_total_amount: 30000, new_total_amount: 37500, manual_reason: "dial photo" });
  });

  it("finds nothing for another organization's manager, and writes nothing", async () => {
    caller = other;
    const before = await bills();
    const res = await regenerate(bill(2), { readings: "manual", start_kwh: 100, end_kwh: 170 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Billing line item not found.", reason: "not_found" });
    expect(await bills()).toEqual(before);
  });

  it("refuses a refunded bill, and writes nothing", async () => {
    caller = manager;
    const before = await bills();
    const res = await regenerate(bill(3), { readings: "manual", start_kwh: 100, end_kwh: 170 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A refunded bill cannot be regenerated.", reason: "refunded" });
    expect(await bills()).toEqual(before);
  });

  it("refuses a paid bill without the acknowledgement, and regenerates it with one", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();
    const refused = await regenerate(bill(4), { readings: "manual", start_kwh: 100, end_kwh: 170 });
    expect(refused.status).toBe(428);
    expect((await refused.json()).reason).toBe("paid_acknowledgement_required");
    expect(await bills()).toEqual(before);
    expect(await auditRows()).toHaveLength(auditBefore.length);

    const res = await regenerate(bill(4), {
      readings: "manual",
      start_kwh: 100,
      end_kwh: 170,
      confirmation: { acknowledged: [REGENERATE_PAID_ACKNOWLEDGEMENT] },
    });
    expect(res.status).toBe(200);
    // 70 kWh: 15 at 250 (3,750) and 55 at 750 (41,250). The payment record is kept.
    expect((await bills()).get(bill(4))).toMatchObject({ usage_kwh: 70, total_amount: 45000, payment_status: "paid" });
  });
});
