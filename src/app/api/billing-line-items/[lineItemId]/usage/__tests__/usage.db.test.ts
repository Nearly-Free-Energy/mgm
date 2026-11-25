/**
 * PATCH /api/billing-line-items/[lineItemId]/usage against a live database
 * (#247): a usage correction is a per-bill regeneration from manual
 * readings, written through fn_regenerate_bill_with_audit with the bill as
 * the route read it. In a period with several bills only the one corrected
 * changes, with one audit row; an invoiced bill, a refunded bill and a bill
 * in a closed period are refused (409), and a paid bill without the
 * regenerate route's acknowledgement (428), with nothing written. A close,
 * a payment or an invoice number landing between the route's read and its
 * write is refused by the write itself, which the route's own checks could
 * not see, and the same correction sent twice is recorded once.
 *
 * Unmetered tenants throughout, so no metering provider is read.
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
/**
 * Runs once, just before the route's write reaches the database: what a
 * close, a Pesapal notification or a PDF download does between the route's
 * read and its write.
 */
let beforeWrite: (() => Promise<void>) | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[usage.db] no caller");
    const client = caller.client;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "rpc") {
          return async (name: string, args?: Record<string, unknown>) => {
            if (name === "fn_regenerate_bill_with_audit" && beforeWrite) {
              const hook = beforeWrite;
              beforeWrite = null;
              await hook();
            }
            return target.rpc(name, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
}));

import { REGENERATE_PAID_ACKNOWLEDGEMENT, USAGE_REFUSAL_COPY } from "@/lib/billing/schemas";
import { PATCH } from "../route";

const ORG = "e8470000-0000-4000-8000-000000000001";
const COMMUNITY = "e8470000-0000-4000-8001-000000000001";
const MICROGRID = "e8470000-0000-4000-8002-000000000001";
const SCHEDULE = "e8470000-0000-4000-8006-000000000001";
const DRAFT = "e8470000-0000-4000-8003-000000000001";
const CLOSED = "e8470000-0000-4000-8003-000000000002";
/** A draft that closes between the route's read and its write. */
const CLOSES = "e8470000-0000-4000-8003-000000000003";
const tenant = (n: number) => `e8470000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const bill = (n: number) => `e8470000-0000-4000-8005-${String(n).padStart(12, "0")}`;
const EMAIL = "usage-db-manager@test.local";

let manager: TestUser;

const correct = (id: string, body: unknown) =>
  PATCH(
    new NextRequest(`http://localhost/api/billing-line-items/${id}/usage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ lineItemId: id }) },
  );

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().eq("org_id", ORG);
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
}

/** A manual bill of 50 kWh totalling 30,000, as stored: a correction recomputes it from the readings. */
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
  invoice_number: null,
  ...o,
});

type BillRow = { id: string; end_kwh: number; usage_kwh: number; total_amount: number; payment_status: string; invoice_number: string | null };

async function bills(periodId = DRAFT): Promise<Map<string, BillRow>> {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("id, end_kwh, usage_kwh, total_amount, payment_status, invoice_number")
    .eq("billing_period_id", periodId);
  if (error) throw new Error(`[usage.db] bills: ${error.message}`);
  return new Map(
    ((data ?? []) as BillRow[]).map((b) => [b.id, { ...b, end_kwh: Number(b.end_kwh), usage_kwh: Number(b.usage_kwh), total_amount: Number(b.total_amount) }]),
  );
}

async function auditRows(periodId = DRAFT): Promise<{ billing_line_item_id: string | null; event_type: string; details: Record<string, unknown> }[]> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_audit_log").select("billing_line_item_id, event_type, details").eq("billing_period_id", periodId);
  if (error) throw new Error(`[usage.db] billing_audit_log: ${error.message}`);
  return (data ?? []) as { billing_line_item_id: string | null; event_type: string; details: Record<string, unknown> }[];
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const paidAt = new Date().toISOString();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", { id: ORG, name: "Usage DB Org" }],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "Usage DB Community", invoice_prefix: "USG" }],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Usage site", currency: "UGX", timezone: "Africa/Kampala" }],
    [
      "rate_schedules",
      {
        id: SCHEDULE,
        microgrid_id: MICROGRID,
        // Lifeline holds 15 kWh (calculateTieredCost gives a tier max - min + 1).
        tiers: [
          { label: "Lifeline", min_kwh: 1, max_kwh: 15, rate_per_kwh: 250 },
          { label: "Standard", min_kwh: 16, max_kwh: null, rate_per_kwh: 750 },
        ],
        service_charge: 0,
        tax_rate: 0,
      },
    ],
    // No tenant has a meter, so every bill is one the usage route corrects.
    ["tenants", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+25670000091${n}` }))],
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
          closed_at: paidAt,
          rate_schedule_id: SCHEDULE,
        },
        { id: CLOSES, microgrid_id: MICROGRID, start_date: "2026-11-01", end_date: "2026-11-30", timezone: "Africa/Kampala", status: "draft", rate_schedule_id: SCHEDULE },
      ],
    ],
    [
      "billing_line_items",
      [
        row(1),
        row(2),
        row(3, { payment_status: "refunded", paid_at: paidAt }),
        row(4, { payment_status: "paid", paid_at: paidAt }),
        row(5, { billing_period_id: CLOSED }),
        // Invoiced: its PDF was downloaded, which allocates the number.
        row(6, { invoice_number: "USG-2025-00001" }),
        // For the races and the repeated submit.
        row(7),
        row(8),
        row(9, { billing_period_id: CLOSES }),
        row(10),
      ],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[usage.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  beforeWrite = null;
  await cleanup();
}, 60_000);

describe.skipIf(shouldSkip())("PATCH /api/billing-line-items/[lineItemId]/usage (live database)", () => {
  it("corrects only the bill asked for, in a period with several, and writes its audit row", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();

    const res = await correct(bill(1), { usage_kwh: 60 });
    expect(res.status).toBe(200);
    // 60 kWh from 100: 15 at 250 (3,750) and 45 at 750 (33,750).
    expect((await res.json()).lineItem).toMatchObject({ id: bill(1), end_kwh: 160, usage_kwh: 60, total_amount: 37500, reading_source: "manual" });

    const after = await bills();
    expect(after.get(bill(1))).toMatchObject({ end_kwh: 160, usage_kwh: 60, total_amount: 37500, payment_status: "unpaid" });
    for (const n of [2, 3, 4, 6]) expect(after.get(bill(n)), `bill ${n} is unchanged`).toEqual(before.get(bill(n)));

    const auditAfter = await auditRows();
    expect(auditAfter).toHaveLength(auditBefore.length + 1);
    const mine = auditAfter.filter((a) => a.billing_line_item_id === bill(1));
    expect(mine).toEqual([expect.objectContaining({ event_type: "line_item_regenerated" })]);
    expect(mine[0].details).toMatchObject({ previous_total_amount: 30000, new_total_amount: 37500 });
  });

  it.each([
    [3, DRAFT, "refunded", USAGE_REFUSAL_COPY.refunded],
    [5, CLOSED, "period_closed", USAGE_REFUSAL_COPY.closed],
    [6, DRAFT, "invoiced", USAGE_REFUSAL_COPY.invoiced],
  ])("refuses bill %i (in %s) as %s, and writes nothing", async (n, periodId, reason, error) => {
    caller = manager;
    const before = await bills(periodId);
    const auditBefore = await auditRows(periodId);
    const res = await correct(bill(n), { usage_kwh: 70, confirmation: { acknowledged: [REGENERATE_PAID_ACKNOWLEDGEMENT] } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error, reason });
    expect(await bills(periodId)).toEqual(before);
    expect(await auditRows(periodId)).toHaveLength(auditBefore.length);
  });

  it("refuses a paid bill without the acknowledgement, and corrects it with one, keeping its payment", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();
    const refused = await correct(bill(4), { usage_kwh: 70 });
    expect(refused.status).toBe(428);
    expect((await refused.json()).reason).toBe("paid_acknowledgement_required");
    expect(await bills()).toEqual(before);
    expect(await auditRows()).toHaveLength(auditBefore.length);

    const res = await correct(bill(4), { usage_kwh: 70, confirmation: { acknowledged: [REGENERATE_PAID_ACKNOWLEDGEMENT] } });
    expect(res.status).toBe(200);
    // 70 kWh: 15 at 250 (3,750) and 55 at 750 (41,250).
    expect((await bills()).get(bill(4))).toMatchObject({ usage_kwh: 70, total_amount: 45000, payment_status: "paid" });
    expect(await auditRows()).toHaveLength(auditBefore.length + 1);
  });

  it("refuses, and writes nothing, when the period closes between the route's read and its write", async () => {
    caller = manager;
    const auditBefore = await auditRows(CLOSES);
    beforeWrite = async () => {
      const svc = await serviceClient();
      const { error } = await svc.from("billing_periods").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", CLOSES);
      if (error) throw new Error(`[usage.db] close: ${error.message}`);
    };
    const res = await correct(bill(9), { usage_kwh: 80 });
    expect(beforeWrite).toBeNull();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: USAGE_REFUSAL_COPY.closed, reason: "period_closed" });
    expect((await bills(CLOSES)).get(bill(9))).toMatchObject({ usage_kwh: 50, total_amount: 30000 });
    expect(await auditRows(CLOSES)).toHaveLength(auditBefore.length);
  });

  it("refuses, and writes nothing, when a payment lands between the route's read and its write", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    // A Pesapal notification marks the bill paid after the route read it
    // unpaid, so no acknowledgement was asked for.
    beforeWrite = async () => {
      const svc = await serviceClient();
      const { error } = await svc.rpc("fn_apply_payment_event", {
        _line_item_id: bill(7),
        _to_status: "paid",
        _source: "ipn",
        _actor_user_id: null,
        _raw_payload: null,
        _actor_kind: "system",
        _actor_ref: "pesapal_ipn",
      });
      if (error) throw new Error(`[usage.db] fn_apply_payment_event: ${error.message}`);
    };
    const res = await correct(bill(7), { usage_kwh: 80 });
    expect(beforeWrite).toBeNull();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: USAGE_REFUSAL_COPY.changed, reason: "bill_changed" });
    expect((await bills()).get(bill(7))).toMatchObject({ usage_kwh: 50, total_amount: 30000, payment_status: "paid" });
    expect(await auditRows()).toHaveLength(auditBefore.length);
  });

  it("refuses, and writes nothing, when the bill is invoiced between the route's read and its write", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    beforeWrite = async () => {
      const svc = await serviceClient();
      const { error } = await svc.from("billing_line_items").update({ invoice_number: "USG-2025-00002" }).eq("id", bill(8)).is("invoice_number", null);
      if (error) throw new Error(`[usage.db] invoice_number: ${error.message}`);
    };
    const res = await correct(bill(8), { usage_kwh: 80 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: USAGE_REFUSAL_COPY.invoiced, reason: "invoiced" });
    expect((await bills()).get(bill(8))).toMatchObject({ usage_kwh: 50, total_amount: 30000, invoice_number: "USG-2025-00002" });
    expect(await auditRows()).toHaveLength(auditBefore.length);
  });

  it("records the same correction once when it is sent twice", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    const first = await correct(bill(10), { end_kwh: 190 });
    expect(first.status).toBe(200);
    // 90 kWh: 15 at 250 (3,750) and 75 at 750 (56,250).
    expect((await first.json()).lineItem).toMatchObject({ usage_kwh: 90, total_amount: 60000 });
    const second = await correct(bill(10), { end_kwh: 190 });
    expect(second.status).toBe(200);
    expect((await second.json()).lineItem).toMatchObject({ id: bill(10), usage_kwh: 90, total_amount: 60000 });
    expect((await auditRows()).filter((a) => a.billing_line_item_id === bill(10))).toHaveLength(1);
    expect(await auditRows()).toHaveLength(auditBefore.length + 1);
  });
});
