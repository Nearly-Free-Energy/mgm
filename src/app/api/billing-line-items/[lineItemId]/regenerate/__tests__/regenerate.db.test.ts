/**
 * POST /api/billing-line-items/[lineItemId]/regenerate against a live
 * database: the route reads the bill through the person's own client,
 * composes billing for the bill's organization and regenerates that one
 * bill through the capability's audit-aware write. In a period with several
 * bills only the one asked for changes, and its audit row is written;
 * another organization's manager finds nothing (404), and so does a
 * tenant-only account of the same organization (404, before billing is
 * composed; composing would refuse it with 403); a refunded bill, a
 * bill in a closed period and an invoiced bill are refused (409); and a paid
 * bill is refused without the acknowledgement its prepare asks for (428),
 * with nothing written. A payment or an invoice number landing between the
 * route's read and its write is refused by the write itself
 * (fn_regenerate_bill_with_audit), and the same regeneration sent twice,
 * one after the other or at once, is recorded once, also when the two
 * copies change only the reason or who entered the reading. A bill's first
 * PDF download that read the bill before a regeneration wrote it stores its
 * invoice number on the regenerated bill and shows that bill.
 *
 * Manual readings throughout, so no metering provider is read.
 *
 * Self-fixturing. Requires a running local Supabase (same harness as
 * rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  serviceClient,
  shouldSkip,
  testAnonKey,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let caller: TestUser | null = null;
/**
 * Runs once, just before the route's write reaches the database: what a
 * Pesapal notification, a PDF download or another request does between the
 * route's read and its write.
 */
let beforeWrite: (() => Promise<void>) | null = null;
/**
 * Runs once, just before the PDF route allocates an invoice number: after it
 * read the bill, before it stores the number.
 */
let beforeInvoiceNumber: (() => Promise<void>) | null = null;
const { renderInvoicePdf } = vi.hoisted(() => ({ renderInvoicePdf: vi.fn(async () => Buffer.from("%PDF-1.4 stub", "utf8")) }));
// What the PDF route renders, not how.
vi.mock("@/lib/invoices/render", () => ({ renderInvoicePdf }));
// No payment link: these organizations have no payment account.
vi.mock("@/lib/mgm/released-routes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mgm/released-routes")>();
  return { ...actual, isReleasedRoute: (path: string) => !path.endsWith("/pay") && actual.isReleasedRoute(path) };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[regenerate.db] no caller");
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
            if (name === "fn_next_invoice_number" && beforeInvoiceNumber) {
              const hook = beforeInvoiceNumber;
              beforeInvoiceNumber = null;
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

import { composeBilling } from "@/lib/billing/compose";
import { REGENERATE_PAID_ACKNOWLEDGEMENT, REGENERATE_REFUSAL_COPY } from "@/lib/billing/schemas";
import { POST } from "../route";
import { GET as downloadPdfRoute } from "../../pdf/route";

const ORG = "e7900000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7900000-0000-4000-8000-000000000002";
const COMMUNITY = "e7900000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7900000-0000-4000-8001-000000000002";
const MICROGRID = "e7900000-0000-4000-8002-000000000001";
const SCHEDULE = "e7900000-0000-4000-8006-000000000001";
const DRAFT = "e7900000-0000-4000-8003-000000000001";
const CLOSED = "e7900000-0000-4000-8003-000000000002";
const tenant = (n: number) => `e7900000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const bill = (n: number) => `e7900000-0000-4000-8005-${String(n).padStart(12, "0")}`;
const EMAIL = "regenerate-db-manager@test.local";
const SECOND_EMAIL = "regenerate-db-second-manager@test.local";
const OTHER_EMAIL = "regenerate-db-other@test.local";
const TENANT_EMAIL = "regenerate-db-tenant@test.local";

let manager: TestUser;
/** Another manager of the same organization. */
let secondManager: TestUser;
let other: TestUser;
let tenantUser: TestUser;

const downloadPdf = (id: string) =>
  downloadPdfRoute(new NextRequest(`http://localhost/api/billing-line-items/${id}/pdf`, { method: "GET" }), {
    params: Promise.resolve({ lineItemId: id }),
  });

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
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, SECOND_EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
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
  invoice_number: null,
  ...o,
});

type BillRow = {
  id: string;
  start_kwh: number;
  end_kwh: number;
  usage_kwh: number;
  total_amount: number;
  payment_status: string;
  reading_source: string;
  device_id: string | null;
  tier_breakdown: unknown;
  entered_by_user_id: string | null;
  manual_reason: string | null;
};

async function bills(periodId = DRAFT): Promise<Map<string, BillRow>> {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("id, start_kwh, end_kwh, usage_kwh, total_amount, payment_status, reading_source, device_id, tier_breakdown, entered_by_user_id, manual_reason")
    .eq("billing_period_id", periodId);
  if (error) throw new Error(`[regenerate.db] bills: ${error.message}`);
  return new Map(((data ?? []) as BillRow[]).map((b) => [b.id, { ...b, start_kwh: Number(b.start_kwh), end_kwh: Number(b.end_kwh), usage_kwh: Number(b.usage_kwh), total_amount: Number(b.total_amount) }]));
}

async function auditRows(periodId = DRAFT): Promise<{ billing_line_item_id: string | null; event_type: string; details: Record<string, unknown> }[]> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_audit_log").select("billing_line_item_id, event_type, details").eq("billing_period_id", periodId);
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
        { id: COMMUNITY, org_id: ORG, name: "Regenerate DB Community", invoice_prefix: "RGN" },
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
    ["tenants", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+25670000090${n}` }))],
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
        // Invoiced: its PDF was downloaded, which allocates the number. Last
        // year's, so the PDF download below gets a number nothing holds.
        row(6, { invoice_number: "RGN-2025-00001" }),
        // For the races, the repeated submits and the conditional write itself.
        row(7),
        row(8),
        row(9),
        // For two copies of one regeneration that change only the reason, or who entered it.
        row(10),
        row(11),
        // For a first PDF download that a regeneration overtakes.
        row(12),
      ],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[regenerate.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  secondManager = await createTestUser({ email: SECOND_EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  // A tenant-only account in the same organization: the tenant of unit 1, whose bill it is.
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  beforeWrite = null;
  beforeInvoiceNumber = null;
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
    for (const n of [2, 3, 4, 6]) expect(after.get(bill(n)), `bill ${n} is unchanged`).toEqual(before.get(bill(n)));

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

  it("refuses a bill in a closed period, and writes nothing", async () => {
    caller = manager;
    const before = await bills(CLOSED);
    const auditBefore = await auditRows(CLOSED);
    const res = await regenerate(bill(5), { readings: "manual", start_kwh: 100, end_kwh: 170 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Bills in a closed period cannot be regenerated.", reason: "period_closed" });
    expect(await bills(CLOSED)).toEqual(before);
    expect(await auditRows(CLOSED)).toHaveLength(auditBefore.length);
  });

  it("refuses an invoiced bill, and writes nothing", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();
    const res = await regenerate(bill(6), { readings: "manual", start_kwh: 100, end_kwh: 170 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "invoiced" });
    expect(await bills()).toEqual(before);
    expect(await auditRows()).toHaveLength(auditBefore.length);
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
  it("refuses a tenant-only account in the same organization, its own unit's bill included, and writes nothing", async () => {
    caller = tenantUser;
    const before = await bills();
    const auditBefore = await auditRows();
    // Row security hides every bill from a tenant (no tenant policy on
    // billing_line_items), so the route finds nothing before it composes billing.
    for (const n of [1, 2]) {
      const res = await regenerate(bill(n), { readings: "manual", start_kwh: 100, end_kwh: 999 });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Billing line item not found.", reason: "not_found" });
    }
    expect(await bills()).toEqual(before);
    expect(await auditRows()).toHaveLength(auditBefore.length);
    // Had it got that far, composing billing for the organization refuses a tenant too.
    const composed = await composeBilling({ supabase: tenantUser.client, organizationId: ORG });
    expect(composed.ok).toBe(false);
    if (!composed.ok) expect(composed.status).toBe(403);
  });

  it("refuses, and writes nothing, when a payment lands between the route's read and its write", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    // A Pesapal notification marks the bill paid after the route read it unpaid,
    // so no acknowledgement was asked for.
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
      if (error) throw new Error(`[regenerate.db] fn_apply_payment_event: ${error.message}`);
    };
    const res = await regenerate(bill(7), { readings: "manual", start_kwh: 100, end_kwh: 180 });
    expect(beforeWrite).toBeNull();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: REGENERATE_REFUSAL_COPY.changed, reason: "bill_changed" });
    expect((await bills()).get(bill(7))).toMatchObject({ usage_kwh: 50, total_amount: 30000, payment_status: "paid" });
    expect(await auditRows()).toHaveLength(auditBefore.length);
  });

  it("refuses, and writes nothing, when the bill is invoiced between the route's read and its write", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    // The PDF route allocates the number on the bill's first download.
    beforeWrite = async () => {
      const svc = await serviceClient();
      const { error } = await svc.from("billing_line_items").update({ invoice_number: "RGN-2025-00002" }).eq("id", bill(8)).is("invoice_number", null);
      if (error) throw new Error(`[regenerate.db] invoice_number: ${error.message}`);
    };
    const res = await regenerate(bill(8), { readings: "manual", start_kwh: 100, end_kwh: 180 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: REGENERATE_REFUSAL_COPY.invoiced, reason: "invoiced" });
    expect((await bills()).get(bill(8))).toMatchObject({ usage_kwh: 50, total_amount: 30000 });
    expect(await auditRows()).toHaveLength(auditBefore.length);
  });

  it("records the same regeneration once when it is sent twice, one after the other", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    const body = { readings: "manual", start_kwh: 100, end_kwh: 190, reason: "second visit" };
    const first = await regenerate(bill(9), body);
    expect(first.status).toBe(200);
    // 90 kWh: 15 at 250 (3,750) and 75 at 750 (56,250).
    expect(await first.json()).toMatchObject({ changed: true, totalAmount: 60000, previousTotalAmount: 30000 });
    const second = await regenerate(bill(9), body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      lineItemId: bill(9),
      totalAmount: 60000,
      previousTotalAmount: 60000,
      changed: false,
      message: expect.stringMatching(/^Nothing changed: the bill already has these figures\. Its total is .*60,000\.$/),
    });
    const audit = (await auditRows()).filter((a) => a.billing_line_item_id === bill(9));
    expect(await auditRows()).toHaveLength(auditBefore.length + 1);
    expect(audit).toHaveLength(1);
    // A different reason is a change, and is recorded.
    const third = await regenerate(bill(9), { ...body, reason: "third visit" });
    expect(await third.json()).toMatchObject({ changed: true, totalAmount: 60000, previousTotalAmount: 60000 });
    expect(await auditRows()).toHaveLength(auditBefore.length + 2);
  });

  it("records the same regeneration once when it is sent twice at once", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    const body = { readings: "manual", start_kwh: 100, end_kwh: 200, reason: "double click" };
    const answers = await Promise.all([regenerate(bill(9), body), regenerate(bill(9), body)]);
    const bodies = await Promise.all(answers.map((r) => r.json()));
    // One writes; the other either finds the bill already has these figures
    // or, having read it before the first wrote, is refused by the write.
    const written = bodies.filter((b) => b.changed === true);
    expect(written).toHaveLength(1);
    for (const [n, b] of bodies.entries()) {
      if (b.changed === true) continue;
      if (answers[n].status === 200) expect(b).toMatchObject({ changed: false });
      else expect([answers[n].status, b]).toEqual([409, { error: REGENERATE_REFUSAL_COPY.changed, reason: "bill_changed" }]);
    }
    // 100 kWh: 3,750 and 85 at 750 (63,750).
    expect((await bills()).get(bill(9))).toMatchObject({ usage_kwh: 100, total_amount: 67500 });
    expect(await auditRows()).toHaveLength(auditBefore.length + 1);
  });
});

describe.skipIf(shouldSkip())("two copies of one regeneration that reach the write together (live database)", () => {
  // Both copies read the bill before either writes: the second copy runs
  // whole between the first one's reads and its write, so the first finds
  // the bill needs writing and then reaches a bill the second has written.
  async function bothReadBeforeEitherWrites(n: number, body: Record<string, unknown>) {
    const second: { res?: Response } = {};
    beforeWrite = async () => {
      second.res = await regenerate(bill(n), body);
    };
    const first = await regenerate(bill(n), body);
    expect(beforeWrite).toBeNull();
    return { first, second: second.res! };
  }

  it("records it once when the copies change only the reason", async () => {
    caller = manager;
    const body = { readings: "manual", start_kwh: 100, end_kwh: 190, reason: "second visit" };
    expect((await regenerate(bill(10), body)).status).toBe(200);
    const auditBefore = await auditRows();

    const { first, second } = await bothReadBeforeEitherWrites(10, { ...body, reason: "corrected" });
    expect(second.status).toBe(200);
    // 90 kWh: 15 at 250 (3,750) and 75 at 750 (56,250), as before.
    expect(await second.json()).toMatchObject({ changed: true, totalAmount: 60000, previousTotalAmount: 60000 });
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: REGENERATE_REFUSAL_COPY.changed, reason: "bill_changed" });

    expect((await bills()).get(bill(10))).toMatchObject({ usage_kwh: 90, total_amount: 60000, manual_reason: "corrected", entered_by_user_id: manager.userId });
    expect((await auditRows()).length - auditBefore.length).toBe(1);
  });

  it("records it once when the copies change only who entered the reading", async () => {
    caller = manager;
    const body = { readings: "manual", start_kwh: 100, end_kwh: 190, reason: "second visit" };
    expect((await regenerate(bill(11), body)).status).toBe(200);
    const auditBefore = await auditRows();

    // Another manager sends the same readings and reason, twice.
    caller = secondManager;
    const { first, second } = await bothReadBeforeEitherWrites(11, body);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ changed: true, totalAmount: 60000, previousTotalAmount: 60000 });
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: REGENERATE_REFUSAL_COPY.changed, reason: "bill_changed" });

    expect((await bills()).get(bill(11))).toMatchObject({ manual_reason: "second visit", entered_by_user_id: secondManager.userId });
    expect((await auditRows()).length - auditBefore.length).toBe(1);
  });
});

describe.skipIf(shouldSkip())("a first PDF download that a regeneration overtakes (live database)", () => {
  it("stores the invoice number on the regenerated bill and shows that bill, not the one it read", async () => {
    caller = manager;
    renderInvoicePdf.mockClear();
    // The download reads the bill at 30,000 with no number; a regeneration
    // then finds no number, writes 60,000 and commits; only then does the
    // download store its number.
    beforeInvoiceNumber = async () => {
      const res = await regenerate(bill(12), { readings: "manual", start_kwh: 100, end_kwh: 190, reason: "re-read" });
      expect(res.status).toBe(200);
    };
    const res = await downloadPdf(bill(12));
    expect(beforeInvoiceNumber).toBeNull();
    expect(res.status).toBe(200);

    const svc = await serviceClient();
    const { data: stored, error } = await svc.from("billing_line_items").select("invoice_number, total_amount").eq("id", bill(12)).single();
    if (error) throw new Error(`[regenerate.db] bill 12: ${error.message}`);
    expect(stored.invoice_number).toMatch(/^RGN-\d{4}-\d+$/);
    expect(Number(stored.total_amount)).toBe(60000);
    expect(res.headers.get("Content-Disposition")).toContain(`${stored.invoice_number}.pdf`);

    // The PDF shows the bill stored under that number.
    expect(renderInvoicePdf).toHaveBeenCalledTimes(1);
    const [input] = renderInvoicePdf.mock.calls[0] as unknown as [{ invoiceNumber: string; lineItem: Record<string, unknown> }];
    expect(input.invoiceNumber).toBe(stored.invoice_number);
    expect(input.lineItem.invoice_number).toBe(stored.invoice_number);
    expect(Number(input.lineItem.total_amount)).toBe(60000);
    expect(Number(input.lineItem.usage_kwh)).toBe(90);
    expect(Number(input.lineItem.end_kwh)).toBe(190);
    expect(input.lineItem.manual_reason).toBe("re-read");

    // A later download shows the same bill under the same number.
    const again = await downloadPdf(bill(12));
    expect(again.status).toBe(200);
    expect(again.headers.get("Content-Disposition")).toContain(`${stored.invoice_number}.pdf`);
    const [later] = renderInvoicePdf.mock.calls[1] as unknown as [{ lineItem: Record<string, unknown> }];
    expect(Number(later.lineItem.total_amount)).toBe(60000);
  });
});

describe.skipIf(shouldSkip())("fn_regenerate_bill_with_audit (live database)", () => {
  /** fn_record_line_item_with_audit's arguments for a manual reading on the draft. */
  const args = (n: number, expected: Record<string, unknown>, periodId = DRAFT) => ({
    _expected: expected,
    _billing_period_id: periodId,
    _tenant_id: tenant(n),
    _device_id: null,
    _usage_kwh: 10,
    _start_kwh: 0,
    _end_kwh: 10,
    _tier_breakdown: [{ label: "Lifeline", kwh: 10, amount: 2500 }],
    _total_amount: 2500,
    _reading_source: "manual",
    _entered_by_user_id: manager.userId,
    _manual_reason: null,
    _actor_user_id: manager.userId,
    _audit_details: {},
    _rate_schedule_id: SCHEDULE,
  });
  const asRead = (n: number, o: Record<string, unknown> = {}) => ({
    line_item_id: bill(n),
    payment_status: "unpaid",
    total_amount: 30000,
    usage_kwh: 50,
    start_kwh: 100,
    end_kwh: 150,
    reading_source: "manual",
    device_id: null,
    tier_breakdown: row(n).tier_breakdown,
    entered_by_user_id: null,
    manual_reason: null,
    ...o,
  });

  it.each([
    ["the period is closed", 5, {}, CLOSED, "billing_period_closed"],
    ["the bill is invoiced", 6, {}, DRAFT, "billing_line_item_invoiced"],
    ["the payment status differs", 2, { payment_status: "paid" }, DRAFT, "billing_line_item_changed"],
    ["the total differs", 2, { total_amount: 29999 }, DRAFT, "billing_line_item_changed"],
    ["the reading source differs", 2, { reading_source: "edge" }, DRAFT, "billing_line_item_changed"],
    ["the start reading differs", 2, { start_kwh: null }, DRAFT, "billing_line_item_changed"],
    ["the meter differs", 2, { device_id: "e7900000-0000-4000-8007-000000000001" }, DRAFT, "billing_line_item_changed"],
    ["the tier breakdown differs", 2, { tier_breakdown: [{ label: "Lifeline", kwh: 50, amount: 12500 }] }, DRAFT, "billing_line_item_changed"],
    ["who entered the reading differs", 2, { entered_by_user_id: "e7900000-0000-4000-8007-000000000002" }, DRAFT, "billing_line_item_changed"],
    ["the reason differs", 2, { manual_reason: "dial photo" }, DRAFT, "billing_line_item_changed"],
    ["the bill is another tenant's", 2, { line_item_id: bill(3) }, DRAFT, "billing_line_item_changed"],
  ] as const)("refuses when %s, and writes nothing", async (_label, n, o, periodId, token) => {
    const before = await bills(periodId);
    const auditBefore = await auditRows(periodId);
    const { data, error } = await manager.client.rpc("fn_regenerate_bill_with_audit", args(n, asRead(n, o), periodId));
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: "23514" });
    expect(error!.message.startsWith(`${token}:`)).toBe(true);
    expect(await bills(periodId)).toEqual(before);
    expect(await auditRows(periodId)).toHaveLength(auditBefore.length);
  });

  it("refuses an _expected that does not name every value", async () => {
    const { error } = await manager.client.rpc("fn_regenerate_bill_with_audit", args(2, { line_item_id: bill(2), payment_status: "unpaid" }));
    expect(error).toMatchObject({ code: "22023" });
  });

  it("writes the bill and its audit row while it is as read, the paid one included", async () => {
    const auditBefore = await auditRows();
    const paid = (await bills()).get(bill(4))!;
    const { data, error } = await manager.client.rpc(
      "fn_regenerate_bill_with_audit",
      args(
        4,
        asRead(4, {
          payment_status: "paid",
          total_amount: paid.total_amount,
          usage_kwh: paid.usage_kwh,
          start_kwh: paid.start_kwh,
          end_kwh: paid.end_kwh,
          device_id: paid.device_id,
          tier_breakdown: paid.tier_breakdown,
          entered_by_user_id: paid.entered_by_user_id,
          manual_reason: paid.manual_reason,
        }),
      ),
    );
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: bill(4), usage_kwh: 10, total_amount: 2500, payment_status: "paid" });
    expect(await auditRows()).toHaveLength(auditBefore.length + 1);
  });

  it("is not callable without a session", async () => {
    const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey() ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await anon.rpc("fn_regenerate_bill_with_audit", args(2, asRead(2)));
    expect(error).not.toBeNull();
    expect(error!.code === "42501" || error!.message?.toLowerCase().includes("permission denied") || error!.code === "PGRST202").toBe(true);
  });
});
