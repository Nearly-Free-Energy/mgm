/**
 * generate-new-bill-only.test.ts
 *
 * A first bill for one tenant from readings typed by hand (`newBillOnly`,
 * sent by POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings
 * through BillingCapability.billFromReadings):
 *
 *   - names one tenant and that tenant's readings only, or it is refused
 *     before anything is read;
 *   - refuses a closed period before pinning the tariff;
 *   - reads every page of the period's tenants and bills (PostgREST's
 *     max_rows), and stops, writing nothing, when a page cannot be read;
 *   - refuses a tenant who already has a bill (`bill_exists`) and writes
 *     nothing, wherever in the pages that bill is;
 *   - reads the period's status again just before the insert, and writes
 *     nothing if it closed meanwhile;
 *   - otherwise runs the manual path unchanged: one
 *     fn_record_first_line_item_with_audit call (the insert-only write,
 *     migration 20261120130100) with fn_record_line_item_with_audit's
 *     arguments: the readings rounded, the pinned tariff's tiers and total,
 *     and no metering read;
 *   - maps that function's refusals to fixed copy: a bill another write
 *     added after the read (`bill_exists`), a period closed after the last
 *     status read (`period_closed`), a period deleted before the insert
 *     (`period_not_found`), a moved tariff (`tariff_changed`).
 *
 * Harness: a mocked Supabase client, as in generate-guard-existing.test.ts.
 * The database side is bill-from-readings.db.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateTieredCost } from "@/lib/billing/calculations";
import { runGenerationFor, isRunGenerationFatal, type RunGenerationParams } from "@/lib/billing/generate";
import { BILL_FROM_READINGS_COPY } from "@/lib/billing/schemas";
import type { MeteringProvider } from "@/lib/metering/types";

const MICROGRID_ID = "eeeeeeee-eeee-4000-8000-000000000001";
const PERIOD_ID = "eeeeeeee-eeee-4000-8006-000000000001";
const SCHEDULE_ID = "eeeeeeee-eeee-4000-8003-000000000001";
const USER = "eeeeeeee-eeee-4000-8fff-000000000001";
const OTHER_TENANT = "eeeeeeee-eeee-4000-8005-999999999999";
const tenant = (n: number) => `eeeeeeee-eeee-4000-8005-${String(n).padStart(12, "0")}`;
const device = (n: number) => `eeeeeeee-eeee-4000-8004-${String(n).padStart(12, "0")}`;

const TIERS = [
  { label: "Lifeline", min_kwh: 0, max_kwh: 15, rate_per_kwh: 250 },
  { label: "Standard", min_kwh: 15, max_kwh: null, rate_per_kwh: 750 },
];

const link = (n: number, o: Record<string, unknown> = {}) => ({
  role: "primary_consumption_meter",
  effective_from: "2020-01-01",
  effective_to: null,
  devices: { id: device(n), openems_component_id: `meter${n}`, edges: { openems_edge_id: "edge0" } },
  ...o,
});

const TENANTS = [
  // 1: no meter.
  { id: tenant(1), display_name: "Unit 1", tenant_devices: [] },
  // 2: a meter assigned only after the period (an assignment gap).
  { id: tenant(2), display_name: "Unit 2", tenant_devices: [link(2, { effective_from: "2026-05-15" })] },
  // 3: metered for the whole period.
  { id: tenant(3), display_name: "Unit 3", tenant_devices: [link(3)] },
  // 4: two meters, the second assigned on the period's last day (an assignment gap, a meter at its end).
  {
    id: tenant(4),
    display_name: "Unit 4",
    tenant_devices: [link(40, { effective_to: "2026-04-30" }), link(41, { effective_from: "2026-04-30" })],
  },
];

const billOf = (n: number, o: Record<string, unknown> = {}) => ({
  id: `eeeeeeee-eeee-4000-8007-${String(n).padStart(12, "0")}`,
  tenant_id: tenant(n),
  total_amount: "4200",
  payment_status: "unpaid",
  reading_source: "edge",
  start_kwh: null,
  end_kwh: null,
  usage_kwh: "42.000",
  device_id: device(n),
  tier_breakdown: [],
  entered_by_user_id: null,
  entered_at: null,
  manual_reason: null,
  invoice_number: null,
  ...o,
});

function harness(
  o: {
    status?: string;
    bills?: Record<string, unknown>[];
    billsError?: { message: string } | null;
    writeError?: { code: string; message: string } | null;
    /** As PostgREST's max_rows: at most this many rows a read, with the exact count of what is left. */
    maxRows?: number;
    /** The read of a table's list that fails, counted from 1. */
    failRead?: { table: string; n: number };
    /** Closes the period as the period's bills are read. */
    closeDuringBillsRead?: boolean;
    /** The second read of the period's status fails. */
    statusReadError?: boolean;
  } = {},
) {
  const period = { status: o.status ?? "draft" };
  const listReads: Record<string, number> = {};
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "fn_pin_billing_period_rate_schedule") return { data: SCHEDULE_ID, error: null };
    if (name === "fn_record_line_item_with_audit" || name === "fn_record_first_line_item_with_audit" || name === "fn_regenerate_bill_with_audit") {
      if (o.writeError) return { data: null, error: o.writeError };
      return { data: { id: "written", tenant_id: args?._tenant_id, total_amount: args?._total_amount }, error: null };
    }
    return { data: null, error: null };
  });
  const responses: Record<string, { single?: unknown; maybeSingle?: unknown; list?: unknown }> = {
    billing_periods: {
      single: {
        data: {
          id: PERIOD_ID,
          microgrid_id: MICROGRID_ID,
          start_date: "2026-04-01",
          end_date: "2026-04-30",
          timezone: "Africa/Kampala",
          status: o.status ?? "draft",
          rate_schedule_id: SCHEDULE_ID,
        },
        error: null,
      },
      list: { data: [], error: null },
    },
    rate_schedules: {
      maybeSingle: { data: { microgrid_id: MICROGRID_ID, tiers: TIERS, service_charge: 1000, tax_rate: 0.18 }, error: null },
    },
    tenants: { list: { data: TENANTS, error: null } },
    billing_line_items: { list: o.billsError ? { data: null, error: o.billsError } : { data: o.bills ?? [], error: null } },
  };
  // A list read answers as PostgREST would: the rows after the `gt("id", …)`
  // keyset, at most maxRows of them, with the exact count of all that match.
  function listRead(table: string, after: string | null) {
    const n = (listReads[table] = (listReads[table] ?? 0) + 1);
    if (table === "billing_line_items" && o.closeDuringBillsRead) period.status = "closed";
    if (o.failRead?.table === table && o.failRead.n === n) return { data: null, error: { message: "canceling statement due to statement timeout" }, count: null };
    const resp = (responses[table]?.list ?? { data: [], error: null }) as { data: unknown; error: unknown };
    if (resp.error || !Array.isArray(resp.data) || o.maxRows === undefined) return resp;
    const rows = (resp.data as { id: string }[]).filter((r) => after === null || r.id > after).sort((a, b) => (a.id < b.id ? -1 : 1));
    return { data: rows.slice(0, o.maxRows), error: null, count: rows.length };
  }
  const from = vi.fn((table: string) => {
    const resp = responses[table] ?? { list: { data: [], error: null } };
    const b: Record<string, unknown> = {};
    let after: string | null = null;
    const chain = () => b;
    for (const m of ["select", "eq", "neq", "lte", "gte", "lt", "in", "not", "order", "limit", "is"]) b[m] = chain;
    b.gt = (_column: string, value: string) => {
      after = value;
      return b;
    };
    b.single = async () => resp.single ?? { data: null, error: null };
    // The period's status, read again just before the insert.
    b.maybeSingle = async () =>
      table === "billing_periods"
        ? o.statusReadError
          ? { data: null, error: { message: "permission denied" } }
          : { data: { status: period.status }, error: null }
        : (resp.maybeSingle ?? { data: null, error: null });
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(listRead(table, after)).then(onFulfilled, onRejected);
    return b;
  });
  const supabase = { from, rpc } as unknown as SupabaseClient;
  const getReadings = vi.fn(async () => []);
  const meteringProvider = { getReadings } as unknown as MeteringProvider;
  return { supabase, from, rpc, getReadings, meteringProvider, listReads };
}

const writes = (rpc: ReturnType<typeof vi.fn>) =>
  rpc.mock.calls.filter(([name]) => name !== "fn_pin_billing_period_rate_schedule").map(([name, args]) => ({ name, args: args as Record<string, unknown> }));

const reading = (n: number, startKwh = 100.1234, endKwh = 150.5, reason?: string) => ({
  tenantId: tenant(n),
  startKwh,
  endKwh,
  ...(reason ? { reason } : {}),
});

function run(h: ReturnType<typeof harness>, n: number, o: Partial<RunGenerationParams> = {}) {
  return runGenerationFor({
    supabase: h.supabase,
    periodId: PERIOD_ID,
    actorUserId: USER,
    mode: "write",
    meteringProvider: h.meteringProvider,
    requireEffectiveDatedAssignments: true,
    allowUsageOnlyReadings: true,
    newBillOnly: true,
    tenantIds: [tenant(n)],
    manualReadings: [reading(n)],
    ...o,
  });
}

async function only(h: ReturnType<typeof harness>, n: number, o: Partial<RunGenerationParams> = {}) {
  const out = await run(h, n, o);
  if (isRunGenerationFatal(out)) throw new Error(out.body.error);
  expect(out.results).toHaveLength(1);
  return out.results[0];
}

const MISMATCH = {
  kind: "fatal",
  status: 400,
  body: { error: "A first bill from readings names one tenant and that tenant's readings only.", code: "new_bill_only_mismatch" },
};

describe("runGenerationFor with newBillOnly", () => {
  it.each([
    ["no tenantIds", { tenantIds: undefined }],
    ["two tenants", { tenantIds: [tenant(1), tenant(3)] }],
    ["no reading", { manualReadings: [] }],
    ["two readings", { manualReadings: [reading(1), reading(3)] }],
    ["another tenant's reading", { manualReadings: [reading(3)] }],
    ["reverts", { revertToEdgeTenantIds: [tenant(1)] }],
    ["seed readings", { seedReadings: [{ deviceId: device(3), dialReadingKwh: 10, readAt: "2026-04-01T00:00:00Z", startKwh: 10 }] }],
    ["guardExistingBills", { guardExistingBills: true }],
    [
      "an expectedBill",
      {
        expectedBill: {
          lineItemId: billOf(1).id,
          tenantId: tenant(1),
          paymentStatus: "unpaid" as const,
          totalAmount: 1,
          usageKwh: 1,
          startKwh: null,
          endKwh: null,
          readingSource: "manual" as const,
          deviceId: null,
          tierBreakdown: [],
          enteredByUserId: null,
          manualReason: null,
        },
      },
    ],
    ["preview mode", { mode: "preview" as const }],
  ])("refuses a run with %s, before reading anything", async (_label, o) => {
    const h = harness();
    const out = await run(h, 1, o as Partial<RunGenerationParams>);
    // guardExistingBills' own check refuses the pair first, with its own words.
    if ("guardExistingBills" in o) expect(out).toMatchObject({ kind: "fatal", status: 400, body: { code: "guard_existing_bills_mismatch" } });
    else expect(out).toEqual(MISMATCH);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it("refuses a closed period before pinning the tariff or writing", async () => {
    const h = harness({ status: "closed" });
    const out = await run(h, 1);
    expect(out).toEqual({ kind: "fatal", status: 409, body: { error: BILL_FROM_READINGS_COPY.closed, code: "billing_period_closed" } });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("stops when the period's bills cannot be read, before writing", async () => {
    const h = harness({ billsError: { message: "relation billing_line_items: permission denied" } });
    const out = await run(h, 1);
    expect(out).toEqual({ kind: "fatal", status: 500, body: { error: BILL_FROM_READINGS_COPY.failed, code: "billing_bills_unreadable" } });
    expect(writes(h.rpc)).toEqual([]);
  });

  it.each([
    ["tenants", "billing_tenants_unreadable"],
    ["billing_line_items", "billing_bills_unreadable"],
  ])("stops when a later page of the %s cannot be read, before writing", async (table, code) => {
    const h = harness({ maxRows: 1, bills: [billOf(3), billOf(4)], failRead: { table, n: 2 } });
    const out = await run(h, 1);
    expect(out).toEqual({ kind: "fatal", status: 500, body: { error: BILL_FROM_READINGS_COPY.failed, code } });
    expect(h.listReads[table]).toBe(2);
    expect(writes(h.rpc)).toEqual([]);
  });

  it("finds the tenant's bill on a later page of the period's bills, and writes nothing", async () => {
    // Sorted by id, the tenant's bill comes last, past two pages of one row.
    const late = billOf(1, { id: "eeeeeeee-eeee-4000-8007-999999999999" });
    const h = harness({ maxRows: 1, bills: [billOf(3), billOf(4), late] });
    expect(await only(h, 1)).toMatchObject({ kind: "error", code: "bill_exists", error: BILL_FROM_READINGS_COPY.hasBill });
    expect(h.listReads.billing_line_items).toBe(3);
    expect(writes(h.rpc)).toEqual([]);
  });

  it("reads the period's status again before the insert, and writes nothing if it closed meanwhile", async () => {
    const h = harness({ closeDuringBillsRead: true });
    const out = await run(h, 1);
    expect(out).toEqual({ kind: "fatal", status: 409, body: { error: BILL_FROM_READINGS_COPY.closed, code: "billing_period_closed" } });
    expect(writes(h.rpc)).toEqual([]);
  });

  it("stops when the period's status cannot be read again, before writing", async () => {
    const h = harness({ statusReadError: true });
    const out = await run(h, 1);
    expect(out).toEqual({ kind: "fatal", status: 500, body: { error: BILL_FROM_READINGS_COPY.failed, code: "billing_period_unreadable" } });
    expect(writes(h.rpc)).toEqual([]);
  });

  it.each([
    ["an edge bill", billOf(1)],
    ["a manual bill", billOf(1, { reading_source: "manual", device_id: null, entered_by_user_id: USER })],
    ["a paid bill", billOf(1, { payment_status: "paid" })],
  ])("refuses a tenant who already has %s, and writes nothing", async (_label, existing) => {
    const h = harness({ bills: [existing] });
    const r = await only(h, 1);
    expect(r).toEqual({ kind: "error", tenantId: tenant(1), tenantName: "Unit 1", error: BILL_FROM_READINGS_COPY.hasBill, code: "bill_exists" });
    expect(writes(h.rpc)).toEqual([]);
  });

  it("bills an unmetered tenant through fn_record_first_line_item_with_audit, with the readings rounded and the pinned tariff", async () => {
    const h = harness({ bills: [billOf(3)] });
    const r = await only(h, 1, { manualReadings: [reading(1, 100.1234, 150.5, "Meter read on site")] });
    expect(r).toMatchObject({ kind: "written", tenantId: tenant(1), tenantName: "Unit 1", previousTotalAmount: null, previousReadingSource: null });
    const w = writes(h.rpc);
    expect(w.map((x) => x.name)).toEqual(["fn_record_first_line_item_with_audit"]);
    // Usage is end − start, priced as computed and stored to 3 places, as a
    // per-bill regeneration's manual path does it.
    const usage = 50.377;
    const calc = calculateTieredCost(150.5 - 100.1234, TIERS, 1000, 0.18);
    expect(w[0].args).toEqual({
      _billing_period_id: PERIOD_ID,
      _tenant_id: tenant(1),
      _device_id: null,
      _usage_kwh: usage,
      _start_kwh: 100.123,
      _end_kwh: 150.5,
      _tier_breakdown: calc.tierBreakdown,
      _total_amount: calc.totalAmount,
      _reading_source: "manual",
      _entered_by_user_id: USER,
      _manual_reason: "Meter read on site",
      _actor_user_id: USER,
      // Built by the function (20261124170000).
      _audit_details: null,
      _rate_schedule_id: SCHEDULE_ID,
      _actor_kind: "human",
      _actor_ref: null,
    });
    expect(h.rpc).toHaveBeenCalledWith("fn_pin_billing_period_rate_schedule", { _period_id: PERIOD_ID });
    expect(h.getReadings).not.toHaveBeenCalled();
  });

  it("bills a tenant with an assignment gap, keeping the meter assigned at the period's end", async () => {
    const h = harness();
    expect(await only(h, 2)).toMatchObject({ kind: "written" });
    expect(writes(h.rpc)[0].args).toMatchObject({ _reading_source: "manual", _device_id: null });
    const h4 = harness();
    expect(await only(h4, 4)).toMatchObject({ kind: "written" });
    expect(writes(h4.rpc)[0].args).toMatchObject({ _reading_source: "manual", _device_id: device(41) });
    expect(h.getReadings).not.toHaveBeenCalled();
    expect(h4.getReadings).not.toHaveBeenCalled();
  });

  it("bills a metered tenant from the readings, keeping the covering meter and reading none", async () => {
    const h = harness();
    expect(await only(h, 3)).toMatchObject({ kind: "written" });
    expect(writes(h.rpc)[0].args).toMatchObject({ _reading_source: "manual", _device_id: device(3), _manual_reason: null });
    expect(h.getReadings).not.toHaveBeenCalled();
  });

  it("refuses a tenant of another microgrid as unknown, and writes nothing", async () => {
    const h = harness();
    const out = await run(h, 0, { tenantIds: [OTHER_TENANT], manualReadings: [{ tenantId: OTHER_TENANT, startKwh: 1, endKwh: 2 }] });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results).toEqual([expect.objectContaining({ kind: "error", tenantId: OTHER_TENANT, code: "unknown_tenant" })]);
    expect(writes(h.rpc)).toEqual([]);
  });

  it("refuses readings that go backwards, and writes nothing", async () => {
    const h = harness();
    const r = await only(h, 1, { manualReadings: [reading(1, 20, 10)] });
    expect(r).toMatchObject({ kind: "error", code: "invalid_manual_reading" });
    expect(writes(h.rpc)).toEqual([]);
  });

  it("reports a tariff changed under the write as tariff_changed", async () => {
    const h = harness({ writeError: { code: "23514", message: "Billing period tariff changed; recalculate before writing bill" } });
    expect(await only(h, 1)).toMatchObject({ kind: "error", code: "tariff_changed" });
  });

  it("reports a bill another write added after the read as bill_exists, in fixed copy", async () => {
    const h = harness({
      writeError: { code: "23514", message: "billing_line_item_exists: the tenant already has a bill for this billing period" },
    });
    expect(await only(h, 1)).toEqual({
      kind: "error",
      tenantId: tenant(1),
      tenantName: "Unit 1",
      error: BILL_FROM_READINGS_COPY.hasBill,
      code: "bill_exists",
    });
  });

  it("reports a period closed after the last status read as period_closed, in fixed copy", async () => {
    const h = harness({
      writeError: { code: "23514", message: "billing_period_closed: a first bill is not added to a closed billing period" },
    });
    expect(await only(h, 1)).toEqual({
      kind: "error",
      tenantId: tenant(1),
      tenantName: "Unit 1",
      error: BILL_FROM_READINGS_COPY.closed,
      code: "period_closed",
    });
  });

  it("reports a period deleted before the insert as period_not_found, in fixed copy", async () => {
    const h = harness({
      writeError: { code: "P0002", message: "billing_period_not_found: the billing period does not exist or is not yours to bill" },
    });
    expect(await only(h, 1)).toEqual({
      kind: "error",
      tenantId: tenant(1),
      tenantName: "Unit 1",
      error: BILL_FROM_READINGS_COPY.periodNotFound,
      code: "period_not_found",
    });
  });

  it.each([
    ["another code with that token", { code: "23514", message: "billing_period_not_found: the billing period does not exist" }],
    ["P0002 with another message", { code: "P0002", message: "query returned no rows" }],
    ["a database error", { code: "40001", message: "could not serialize access due to concurrent update" }],
  ])("reports any other write failure (%s) as line_item_write_failed", async (_label, writeError) => {
    const h = harness({ writeError });
    expect(await only(h, 1)).toMatchObject({ kind: "error", code: "line_item_write_failed" });
  });
});
