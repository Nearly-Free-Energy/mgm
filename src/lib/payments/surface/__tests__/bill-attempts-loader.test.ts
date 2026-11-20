/**
 * The `payments.bill-attempts` loader: the period, the microgrid and the
 * bills through the person's own client; one bill's history only through
 * the Payments capability's listHistory, composed after the loader's own
 * reads and always disposed; and refusals with fixed copy, never a
 * database or capability message.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";

const composePayments = vi.fn();
vi.mock("@/lib/payments/compose", () => ({ composePayments: (...args: unknown[]) => composePayments(...args) }));

import { BILL_ATTEMPTS_MAX_BILLS, BILL_ATTEMPTS_REFUSALS, loadBillAttempts } from "../bill-attempts";

const ORG = "e8300000-0000-4000-8000-000000000001";
const MG = "e8300000-0000-4000-8000-0000000000a1";
const PERIOD = "e8300000-0000-4000-8000-0000000000b1";
const B1 = "e8300000-0000-4000-8000-0000000000d1";
const B2 = "e8300000-0000-4000-8000-0000000000d2";
const A1 = "e8300000-0000-4000-8000-0000000000e1";
const SECRET = "permission denied for table billing_line_items";
const fmt = createFmt({ locale: "en-GB" });

const PERIOD_ROW = { id: PERIOD, microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31", timezone: null };
const MICROGRID = { id: MG, name: "North site", currency: "UGX", timezone: "Africa/Kampala" };
const BILLS = [
  { id: B2, total_amount: "3000", payment_status: "paid", tenants: { display_name: "Kato" } },
  { id: B1, total_amount: 5000, payment_status: "unpaid", tenants: [{ display_name: " Akello " }] },
];
const HISTORY = {
  attempts: [
    {
      id: A1,
      org_id: ORG,
      line_item_id: B1,
      community_id: null,
      merchant_account_id: "acct",
      merchant_account_version: 1,
      amount: 5000,
      currency: "UGX",
      bill_revision_total: 5000,
      bill_revision_updated_at: null,
      merchant_reference: `MGM-${A1}`,
      provider_tracking_id: "track",
      provider: "pesapal",
      status: "needs_reconciliation",
      checkout_url: "https://pay.example/checkout",
      failure_code: "balance_mismatch",
      failure_message: "raw provider text",
      created_at: "2026-10-03T09:15:00Z",
    },
  ],
  receipts: [],
  currentTotal: 5000,
  currency: "UGX",
  received: 0,
  difference: -5000,
};

type Fixture = { period?: unknown; microgrid?: unknown; bills?: unknown; periodError?: boolean; billsError?: boolean };
function fixture(o: Fixture = {}) {
  return tableClient({
    billing_periods: o.periodError ? { data: null, error: { message: SECRET } } : { data: o.period === undefined ? [PERIOD_ROW] : o.period },
    microgrids: { data: o.microgrid === undefined ? [MICROGRID] : o.microgrid },
    billing_line_items: o.billsError ? { data: null, error: { message: SECRET } } : { data: o.bills === undefined ? BILLS : o.bills },
  });
}

const req = (client: SupabaseClient, bill?: string): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e8300000-0000-4000-8fff-000000000001" } as User,
    roles: [managerOf(ORG)],
    organizationId: ORG,
    params: { id: MG, periodId: PERIOD },
    search: new URLSearchParams(bill === undefined ? {} : { bill }),
    fmt,
  }) as unknown as SurfaceRequest;

const dispose = vi.fn(async () => {});
const listHistory = vi.fn();
let order: string[];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  listHistory.mockImplementation(async () => ({ ok: true, data: structuredClone(HISTORY) }));
  composePayments.mockImplementation(async () => {
    order.push("compose");
    return { ok: true, data: { payments: { listHistory }, dispose } };
  });
});

describe("the index", () => {
  it("lists the period's bills in tenant name order, composing nothing", async () => {
    const { client, calls } = fixture();
    const out = await loadBillAttempts(req(client));
    expect(out.ok && out.model.body.rows.map((r) => [r.id, r.cells.tenant.text])).toEqual([
      [B1, "Akello"],
      [B2, "Kato"],
    ]);
    expect(composePayments).not.toHaveBeenCalled();
    const bills = calls.find((c) => c.table === "billing_line_items")!;
    expect(bills.ops).toContainEqual(["eq", ["billing_period_id", PERIOD]]);
    expect(bills.ops).toContainEqual(["limit", [BILL_ATTEMPTS_MAX_BILLS + 1]]);
  });

  it("refuses a period with more bills than it shows", async () => {
    const many = Array.from({ length: BILL_ATTEMPTS_MAX_BILLS + 1 }, (_, n) => ({ ...BILLS[1], id: `${n}` }));
    expect(await loadBillAttempts(req(fixture({ bills: many }).client))).toEqual(BILL_ATTEMPTS_REFUSALS.tooLarge);
  });

  it("refuses with fixed copy when the bills cannot be read", async () => {
    const out = await loadBillAttempts(req(fixture({ billsError: true }).client));
    expect(out).toEqual(BILL_ATTEMPTS_REFUSALS.unavailable);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("the period", () => {
  it("is not found when it is not under the microgrid, or the microgrid is not seen", async () => {
    const { client, calls } = fixture({ period: [] });
    expect(await loadBillAttempts(req(client))).toEqual(BILL_ATTEMPTS_REFUSALS.periodNotFound);
    expect(calls.find((c) => c.table === "billing_periods")!.ops).toContainEqual(["eq", ["microgrid_id", MG]]);
    expect(await loadBillAttempts(req(fixture({ microgrid: [] }).client))).toEqual(BILL_ATTEMPTS_REFUSALS.periodNotFound);
  });

  it("is unavailable, with fixed copy, when it cannot be read", async () => {
    const out = await loadBillAttempts(req(fixture({ periodError: true }).client, B1));
    expect(out).toEqual(BILL_ATTEMPTS_REFUSALS.unavailable);
    expect(composePayments).not.toHaveBeenCalled();
  });
});

describe("one bill", () => {
  it("reads the bill in this period, then its history through the capability, and disposes", async () => {
    const { client, calls } = fixture({ bills: [BILLS[1]] });
    const out = await loadBillAttempts(req(client, B1));
    expect(out.ok && out.model.title).toBe("Payments: Akello");
    expect(out.ok && out.model.body.rows.map((r) => r.id)).toEqual([A1]);
    const bill = calls.find((c) => c.table === "billing_line_items")!;
    expect(bill.ops).toContainEqual(["eq", ["id", B1]]);
    expect(bill.ops).toContainEqual(["eq", ["billing_period_id", PERIOD]]);
    expect(composePayments).toHaveBeenCalledWith({ supabase: client, organizationId: ORG, allowDisabled: true });
    expect(listHistory).toHaveBeenCalledWith(B1);
    expect(dispose).toHaveBeenCalledTimes(1);
    // Times in the microgrid's zone when the period has none.
    expect(out.ok && out.model.body.rows[0].cells.created).toMatchObject({ t: "datetime", tz: "Africa/Kampala" });
  });

  it("composes only after its own reads", async () => {
    const { client, calls } = fixture({ bills: [BILLS[1]] });
    const from = client.from.bind(client);
    (client as unknown as { from: (t: string) => unknown }).from = (t: string) => (order.push(t), from(t));
    await loadBillAttempts(req(client, B1));
    expect(order).toEqual(["billing_periods", "microgrids", "billing_line_items", "compose"]);
    expect(calls.map((c) => c.table)).not.toContain("payment_attempts");
  });

  it("reads no payment table itself, and enumerates every column it selects", async () => {
    const { client, calls } = fixture({ bills: [BILLS[1]] });
    await loadBillAttempts(req(client, B1));
    expect(calls.map((c) => c.table).filter((t) => t.startsWith("payment"))).toEqual([]);
    for (const c of calls) for (const [op, args] of c.ops) if (op === "select") expect(String(args[0])).not.toContain("*");
  });

  it.each([["not-a-uuid"], [""]])("is not found for a bill id %j, before any read of bills", async (bill) => {
    const { client, calls } = fixture();
    expect(await loadBillAttempts(req(client, bill))).toEqual(BILL_ATTEMPTS_REFUSALS.billNotFound);
    expect(calls.map((c) => c.table)).not.toContain("billing_line_items");
  });

  it("is not found for a bill of another period", async () => {
    expect(await loadBillAttempts(req(fixture({ bills: [] }).client, B1))).toEqual(BILL_ATTEMPTS_REFUSALS.billNotFound);
    expect(composePayments).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, status: 403, code: "payments_forbidden", message: "secret" }, BILL_ATTEMPTS_REFUSALS.forbidden],
    [{ ok: false, status: 401, code: "payments_unauthenticated", message: "secret" }, BILL_ATTEMPTS_REFUSALS.forbidden],
    [{ ok: false, status: 500, code: "payments_composition_failed", message: "Could not compose payments: secret" }, BILL_ATTEMPTS_REFUSALS.unavailable],
  ])("answers a composition that fails (%o) with fixed copy", async (failure, refusal) => {
    composePayments.mockResolvedValue(failure);
    expect(await loadBillAttempts(req(fixture({ bills: [BILLS[1]] }).client, B1))).toEqual(refusal);
  });

  it.each([
    [403, BILL_ATTEMPTS_REFUSALS.billNotFound],
    [404, BILL_ATTEMPTS_REFUSALS.billNotFound],
    [500, BILL_ATTEMPTS_REFUSALS.unavailable],
  ])("answers listHistory's %i with fixed copy, and disposes", async (status, refusal) => {
    listHistory.mockResolvedValue({ ok: false, status, code: "x", message: "secret" });
    expect(await loadBillAttempts(req(fixture({ bills: [BILLS[1]] }).client, B1))).toEqual(refusal);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when listHistory throws, and still disposes", async () => {
    listHistory.mockRejectedValue(new Error("Could not load payment history"));
    expect(await loadBillAttempts(req(fixture({ bills: [BILLS[1]] }).client, B1))).toEqual(BILL_ATTEMPTS_REFUSALS.unavailable);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("carries none of the capability's raw attempt fields", async () => {
    const out = await loadBillAttempts(req(fixture({ bills: [BILLS[1]] }).client, B1));
    const text = JSON.stringify(out);
    for (const s of ["https://pay.example/checkout", "raw provider text", '"track"', "acct"]) expect(text).not.toContain(s);
  });
});
