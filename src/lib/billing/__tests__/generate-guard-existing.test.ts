/**
 * generate-guard-existing.test.ts
 *
 * A whole-period run from meter data (`guardExistingBills`, sent by POST
 * /api/billing-periods/[periodId]/generate-from-meters through
 * BillingCapability.generateFromMeters):
 *
 *   - names no tenants and takes no readings, or it is refused before
 *     anything is read;
 *   - refuses a closed period before pinning the tariff or writing;
 *   - keeps manual bills, and leaves invoiced, paid and refunded bills as
 *     they are without reading their meters;
 *   - rewrites every other existing bill through fn_regenerate_bill_with_audit
 *     with that bill as read, and writes nothing for a bill whose figures
 *     are already the ones computed;
 *   - inserts a tenant's first bill through
 *     fn_record_first_line_item_with_audit (insert-only, migration
 *     20261120130100), with fn_record_line_item_with_audit's arguments, and
 *     maps its refusals: a bill another write added after the read
 *     (`bill_exists`) and a period closed after the last status read
 *     (`period_closed`), each for that tenant only;
 *   - reports tenants with no meter, an assignment gap or no meter data with
 *     their codes, as any run does, and says (`hadBill`) which of them had a
 *     bill, which it leaves as it is;
 *   - reads the period's status again after reading the meters, and writes
 *     nothing if it closed meanwhile;
 *   - reads every page of the tenants and bills (PostgREST's max_rows), and
 *     stops, writing nothing, when a page cannot be read;
 *   - reads the prior readings in slices of the period and device lists,
 *     which travel in the read's URL, and stops the same way when a slice
 *     cannot be read.
 *
 * Harness: a mocked Supabase client, as in generate-expected-bill.test.ts.
 * The database side is generate-from-meters.db.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runGenerationFor, isRunGenerationFatal, type RunGenerationParams } from "@/lib/billing/generate";
import { BILL_FROM_READINGS_COPY, GENERATE_FROM_METERS_COPY, REGENERATE_REFUSAL_COPY } from "@/lib/billing/schemas";
import type { MeteringProvider } from "@/lib/metering/types";

const MICROGRID_ID = "dddddddd-dddd-4000-8000-000000000001";
const PERIOD_ID = "dddddddd-dddd-4000-8006-000000000001";
const SCHEDULE_ID = "dddddddd-dddd-4000-8003-000000000001";
const USER = "dddddddd-dddd-4000-8fff-000000000001";
const tenant = (n: number) => `dddddddd-dddd-4000-8005-${String(n).padStart(12, "0")}`;
const device = (n: number) => `dddddddd-dddd-4000-8004-${String(n).padStart(12, "0")}`;
const bill = (n: number) => `dddddddd-dddd-4000-8007-${String(n).padStart(12, "0")}`;

/** A primary link covering the period, on a meter with OpenEMS ids. */
const covering = (n: number) => ({
  role: "primary_consumption_meter",
  effective_from: "2020-01-01",
  effective_to: null,
  devices: { id: device(n), openems_component_id: `meter${n}`, edges: { openems_edge_id: "edge0" } },
});

const TENANTS = [
  // 1: metered, no bill yet.
  { id: tenant(1), display_name: "Unit 1", tenant_devices: [covering(1)] },
  // 2: metered, an unpaid edge bill with other figures.
  { id: tenant(2), display_name: "Unit 2", tenant_devices: [covering(2)] },
  // 3: metered, an unpaid edge bill with the figures the meter gives.
  { id: tenant(3), display_name: "Unit 3", tenant_devices: [covering(3)] },
  // 4: metered, a manual bill.
  { id: tenant(4), display_name: "Unit 4", tenant_devices: [covering(4)] },
  // 5: metered, a paid bill.
  { id: tenant(5), display_name: "Unit 5", tenant_devices: [covering(5)] },
  // 6: metered, an invoiced bill.
  { id: tenant(6), display_name: "Unit 6", tenant_devices: [covering(6)] },
  // 7: metered, a refunded bill.
  { id: tenant(7), display_name: "Unit 7", tenant_devices: [covering(7)] },
  // 8: no meter.
  { id: tenant(8), display_name: "Unit 8", tenant_devices: [] },
  // 9: a meter assigned only after the period.
  { id: tenant(9), display_name: "Unit 9", tenant_devices: [{ ...covering(9), effective_from: "2026-05-15" }] },
  // 10: metered, but the meter has no data for the period.
  { id: tenant(10), display_name: "Unit 10", tenant_devices: [covering(10)] },
];

/** An edge bill of 42 kWh at 100 a kWh, as the usage-only path writes it. */
const edgeBill = (n: number, o: Record<string, unknown> = {}) => ({
  id: bill(n),
  tenant_id: tenant(n),
  // NUMERIC columns as PostgREST may send them.
  total_amount: "4200",
  payment_status: "unpaid",
  reading_source: "edge",
  start_kwh: null,
  end_kwh: null,
  usage_kwh: "42.000",
  device_id: device(n),
  tier_breakdown: [{ label: "T1", kwh: 42, amount: 4200 }],
  entered_by_user_id: null,
  entered_at: null,
  manual_reason: null,
  invoice_number: null,
  ...o,
});

const BILLS = [
  edgeBill(2, { usage_kwh: 30, total_amount: 3000, tier_breakdown: [{ label: "T1", kwh: 30, amount: 3000 }] }),
  edgeBill(3),
  edgeBill(4, { reading_source: "manual", start_kwh: 10, end_kwh: 20, usage_kwh: 10, total_amount: 1000, entered_by_user_id: USER }),
  edgeBill(5, { payment_status: "paid" }),
  edgeBill(6, { invoice_number: "EXS-2026-0006" }),
  edgeBill(7, { payment_status: "refunded" }),
];

function harness(
  o: {
    status?: string;
    bills?: Record<string, unknown>[];
    billsError?: { message: string } | null;
    writeError?: (name: string, tenantId: unknown) => { code: string; message: string } | null;
    /** As PostgREST's max_rows: at most this many rows a read, with the exact count of what is left. */
    maxRows?: number;
    /** The read of a table's list that fails, counted from 1. */
    failRead?: { table: string; n: number };
    /** Closes the period while the meters are read. */
    closeDuringRead?: boolean;
    /** The second read of the period's status fails. */
    statusReadError?: boolean;
    tenants?: Record<string, unknown>[];
    /** The microgrid's earlier periods, and their bills' end readings. */
    priorPeriods?: { id: string; end_date: string }[];
    priorItems?: { id: string; device_id: string; end_kwh: number; billing_period_id: string }[];
    /** As a gateway's request-line limit: a read whose `.in()` lists hold more ids in all fails. */
    maxInIds?: number;
  } = {},
) {
  const period = { status: o.status ?? "draft" };
  const listReads: Record<string, number> = {};
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "fn_pin_billing_period_rate_schedule") return { data: SCHEDULE_ID, error: null };
    if (name === "fn_record_line_item_with_audit" || name === "fn_record_first_line_item_with_audit" || name === "fn_regenerate_bill_with_audit") {
      const err = o.writeError?.(name, args?._tenant_id) ?? null;
      if (err) return { data: null, error: err };
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
      list: { data: o.priorPeriods ?? [], error: null },
    },
    rate_schedules: {
      maybeSingle: {
        data: { microgrid_id: MICROGRID_ID, tiers: [{ label: "T1", min_kwh: 1, max_kwh: null, rate_per_kwh: 100 }], service_charge: 0, tax_rate: 0 },
        error: null,
      },
    },
    tenants: { list: { data: o.tenants ?? TENANTS, error: null } },
    billing_line_items: { list: o.billsError ? { data: null, error: o.billsError } : { data: o.bills ?? BILLS, error: null } },
  };
  // A list read answers as PostgREST would: the rows after the `gt("id", …)`
  // keyset, at most maxRows of them, with the exact count of all that match.
  // A read with `.in()` lists is the prior readings' read: it answers from
  // priorItems, filtered by those lists.
  const inLists: Record<string, string[]>[] = [];
  function listRead(table: string, after: string | null, ins: Record<string, string[]>) {
    const n = (listReads[table] = (listReads[table] ?? 0) + 1);
    if (o.failRead?.table === table && o.failRead.n === n) return { data: null, error: { message: "canceling statement due to statement timeout" }, count: null };
    const filtered = Object.keys(ins).length > 0;
    if (filtered) {
      inLists.push(ins);
      const ids = Object.values(ins).reduce((sum, v) => sum + v.length, 0);
      if (o.maxInIds !== undefined && ids > o.maxInIds) return { data: null, error: { message: "414 Request-URI Too Large" }, count: null };
    }
    const resp = (
      filtered
        ? { data: (o.priorItems ?? []).filter((r) => Object.entries(ins).every(([c, v]) => v.includes(String((r as Record<string, unknown>)[c])))), error: null }
        : (responses[table]?.list ?? { data: [], error: null })
    ) as { data: unknown; error: unknown };
    if (resp.error || !Array.isArray(resp.data) || o.maxRows === undefined) return resp;
    const rows = (resp.data as { id: string }[]).filter((r) => after === null || r.id > after).sort((a, b) => (a.id < b.id ? -1 : 1));
    return { data: rows.slice(0, o.maxRows), error: null, count: rows.length };
  }
  function builder(table: string) {
    const resp = responses[table] ?? { list: { data: [], error: null } };
    const b: Record<string, unknown> = {};
    let after: string | null = null;
    const ins: Record<string, string[]> = {};
    const chain = () => b;
    for (const m of ["select", "eq", "neq", "lte", "gte", "lt", "not", "order", "limit", "is"]) b[m] = chain;
    b.in = (column: string, values: string[]) => {
      ins[column] = values;
      return b;
    };
    b.gt = (_column: string, value: string) => {
      after = value;
      return b;
    };
    b.single = async () => resp.single ?? { data: null, error: null };
    // The period's status, read again before the first write.
    b.maybeSingle = async () =>
      table === "billing_periods"
        ? o.statusReadError
          ? { data: null, error: { message: "permission denied" } }
          : { data: { status: period.status }, error: null }
        : (resp.maybeSingle ?? { data: null, error: null });
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(listRead(table, after, ins)).then(onFulfilled, onRejected);
    return b;
  }
  const supabase = { from: (table: string) => builder(table), rpc } as unknown as SupabaseClient;
  const getReadings = vi.fn(async ({ devices }: { devices: Array<{ id: string }> }) => {
    if (o.closeDuringRead) period.status = "closed";
    return devices.map((d) => ({ deviceId: d.id, usageKwh: d.id === device(10) ? null : 42, startDate: "2026-04-01", endDate: "2026-04-30" }));
  });
  const meteringProvider = { getReadings } as unknown as MeteringProvider;
  return { supabase, rpc, getReadings, meteringProvider, listReads, inLists };
}

const writes = (rpc: ReturnType<typeof vi.fn>) =>
  rpc.mock.calls.filter(([name]) => name !== "fn_pin_billing_period_rate_schedule").map(([name, args]) => ({ name, args: args as Record<string, unknown> }));

function run(h: ReturnType<typeof harness>, o: Partial<RunGenerationParams> = {}) {
  return runGenerationFor({
    supabase: h.supabase,
    periodId: PERIOD_ID,
    actorUserId: USER,
    mode: "write",
    meteringProvider: h.meteringProvider,
    requireEffectiveDatedAssignments: true,
    allowUsageOnlyReadings: true,
    guardExistingBills: true,
    ...o,
  });
}

async function results(h: ReturnType<typeof harness>, o: Partial<RunGenerationParams> = {}) {
  const out = await run(h, o);
  if (isRunGenerationFatal(out)) throw new Error(out.body.error);
  return new Map(out.results.map((r) => [r.tenantId, r]));
}

describe("runGenerationFor with guardExistingBills", () => {
  it.each([
    ["tenantIds", { tenantIds: [tenant(1)] }],
    ["an empty tenantIds", { tenantIds: [] }],
    ["manual readings", { manualReadings: [{ tenantId: tenant(8), startKwh: 0, endKwh: 1 }] }],
    ["reverts", { revertToEdgeTenantIds: [tenant(4)] }],
    ["seed readings", { seedReadings: [{ deviceId: device(1), dialReadingKwh: 10, readAt: "2026-04-01T00:00:00Z", startKwh: 10 }] }],
    [
      "an expectedBill",
      {
        expectedBill: {
          lineItemId: bill(2),
          tenantId: tenant(2),
          paymentStatus: "unpaid" as const,
          totalAmount: 3000,
          usageKwh: 30,
          startKwh: null,
          endKwh: null,
          readingSource: "edge" as const,
          deviceId: device(2),
          tierBreakdown: [],
          enteredByUserId: null,
          manualReason: null,
        },
      },
    ],
    ["preview mode", { mode: "preview" as const }],
  ])("refuses a run with %s, before reading anything", async (_label, o) => {
    const h = harness();
    const from = vi.spyOn(h.supabase, "from");
    const out = await run(h, o);
    expect(out).toEqual({
      kind: "fatal",
      status: 400,
      body: { error: "A whole-period run from meter data names no tenants and takes no readings.", code: "guard_existing_bills_mismatch" },
    });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("refuses a closed period before pinning the tariff, reading meters or writing", async () => {
    const h = harness({ status: "closed" });
    const out = await run(h);
    expect(out).toEqual({ kind: "fatal", status: 409, body: { error: GENERATE_FROM_METERS_COPY.closed, code: "billing_period_closed" } });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.getReadings).not.toHaveBeenCalled();
  });

  it("stops when the period's bills cannot be read, before reading meters or writing", async () => {
    const h = harness({ billsError: { message: "relation billing_line_items: permission denied" } });
    const out = await run(h);
    expect(out).toEqual({ kind: "fatal", status: 500, body: { error: GENERATE_FROM_METERS_COPY.failed, code: "billing_bills_unreadable" } });
    expect(writes(h.rpc)).toEqual([]);
    expect(h.getReadings).not.toHaveBeenCalled();
  });

  it("refuses a period that closed while the meters were read, and writes nothing", async () => {
    const h = harness({ closeDuringRead: true });
    const out = await run(h);
    expect(out).toEqual({ kind: "fatal", status: 409, body: { error: GENERATE_FROM_METERS_COPY.closed, code: "billing_period_closed" } });
    expect(h.getReadings).toHaveBeenCalledTimes(1);
    expect(writes(h.rpc)).toEqual([]);
  });

  it("stops when the period's status cannot be read again before writing", async () => {
    const h = harness({ statusReadError: true });
    const out = await run(h);
    expect(out).toEqual({ kind: "fatal", status: 500, body: { error: GENERATE_FROM_METERS_COPY.failed, code: "billing_period_unreadable" } });
    expect(writes(h.rpc)).toEqual([]);
  });

  it("reads every page of the tenants and bills, as PostgREST's max_rows cuts them", async () => {
    const h = harness({ maxRows: 2 });
    const by = await results(h);
    // Ten tenants and six bills, two a page: every page read, the last one short.
    expect(h.listReads).toMatchObject({ tenants: 5, billing_line_items: 3 });
    expect(by.size).toBe(10);
    // The bills of the later pages are seen: kept, left, or rewritten only as read.
    expect(by.get(tenant(4))).toMatchObject({ kind: "kept" });
    for (const [n, code] of [
      [5, "paid"],
      [6, "invoiced"],
      [7, "refunded"],
    ] as const) {
      expect(by.get(tenant(n))).toMatchObject({ kind: "error", code, hadBill: true });
    }
    expect(writes(h.rpc).map((w) => [w.name, w.args._tenant_id])).toEqual([
      ["fn_record_first_line_item_with_audit", tenant(1)],
      ["fn_regenerate_bill_with_audit", tenant(2)],
    ]);
  });

  it.each([
    ["tenants", "billing_tenants_unreadable"],
    ["billing_line_items", "billing_bills_unreadable"],
  ])("stops when a later page of %s cannot be read, before reading meters or writing", async (table, code) => {
    const h = harness({ maxRows: 2, failRead: { table, n: 2 } });
    const out = await run(h);
    expect(out).toEqual({ kind: "fatal", status: 500, body: { error: GENERATE_FROM_METERS_COPY.failed, code } });
    expect(writes(h.rpc)).toEqual([]);
    expect(h.getReadings).not.toHaveBeenCalled();
  });

  it("pages and stops the same way without it, in fixed copy", async () => {
    // Every page read: the manual bill on a later page is kept, not overwritten from the meter.
    const paged = harness({ maxRows: 2 });
    const by = await results(paged, { guardExistingBills: undefined });
    expect(by.get(tenant(4))).toMatchObject({ kind: "kept" });
    expect(writes(paged.rpc).map((w) => w.args._tenant_id)).not.toContain(tenant(4));
    // A page that cannot be read stops the run, with no database text.
    const failing = harness({ maxRows: 2, failRead: { table: "billing_line_items", n: 2 } });
    const out = await run(failing, { guardExistingBills: undefined });
    expect(out).toEqual({
      kind: "fatal",
      status: 500,
      body: { error: "The period's tenants and bills could not be read. Nothing was written; try again.", code: "billing_bills_unreadable" },
    });
    expect(writes(failing.rpc)).toEqual([]);
  });

  it("reads the prior readings in slices of the period and device lists, latest period first", async () => {
    // 170 metered tenants and 100 earlier periods: more than one slice of each.
    const tenants = Array.from({ length: 170 }, (_, i) => ({ id: tenant(i + 1), display_name: `Unit ${i + 1}`, tenant_devices: [covering(i + 1)] }));
    const priorPeriod = (n: number) => `dddddddd-dddd-4000-8008-${String(n).padStart(12, "0")}`;
    // Ids that sort against the dates: the latest period has the lowest id.
    const priorPeriods = Array.from({ length: 100 }, (_, i) => ({
      id: priorPeriod(100 - i),
      end_date: new Date(Date.UTC(2025, 11, 1 + i)).toISOString().slice(0, 10),
    }));
    const latest = priorPeriods[99].id;
    const oldest = priorPeriods[0].id;
    const item = (n: number, d: number, period: string, endKwh: number) => ({ id: bill(1000 + n), device_id: device(d), end_kwh: endKwh, billing_period_id: period });
    const priorItems = [
      item(1, 1, oldest, 100),
      item(2, 1, latest, 500), // the latest wins
      item(3, 2, oldest, 200), // only in the oldest slice of periods
      item(4, 170, priorPeriods[50].id, 300), // the last slice of devices
    ];
    const h = harness({ tenants, bills: [], priorPeriods, priorItems, maxRows: 2, maxInIds: 200 });
    await results(h);
    const start = new Map(writes(h.rpc).map((w) => [w.args._tenant_id, w.args._start_kwh]));
    expect(start.get(tenant(1))).toBe(500);
    expect(start.get(tenant(2))).toBe(200);
    expect(start.get(tenant(170))).toBe(300);
    expect(start.get(tenant(3))).toBeNull();
    for (const ins of h.inLists) {
      expect(ins.billing_period_id.length).toBeLessThanOrEqual(80);
      expect(ins.device_id.length).toBeLessThanOrEqual(80);
    }
    // The second slice of periods asks only for the devices not yet found.
    const second = h.inLists.filter((ins) => ins.billing_period_id.includes(oldest));
    expect(second.flatMap((ins) => ins.device_id)).not.toContain(device(1));
    expect(second.flatMap((ins) => ins.device_id)).not.toContain(device(170));
    expect(second.flatMap((ins) => ins.device_id)).toContain(device(2));
  });

  it("stops when a slice of the prior readings cannot be read, writing nothing", async () => {
    const tenants = Array.from({ length: 170 }, (_, i) => ({ id: tenant(i + 1), display_name: `Unit ${i + 1}`, tenant_devices: [covering(i + 1)] }));
    const priorPeriods = [{ id: "dddddddd-dddd-4000-8008-000000000001", end_date: "2026-03-31" }];
    // The period's bills are the first billing_line_items read; the second slice of devices is the third.
    const h = harness({ tenants, bills: [], priorPeriods, failRead: { table: "billing_line_items", n: 3 } });
    const out = await run(h);
    expect(out).toEqual({ kind: "fatal", status: 500, body: { error: GENERATE_FROM_METERS_COPY.failed, code: "billing_readings_unreadable" } });
    expect(writes(h.rpc)).toEqual([]);
    expect(h.getReadings).not.toHaveBeenCalled();
  });

  it("reads only the meters of tenants it may bill", async () => {
    const h = harness();
    await results(h);
    expect(h.getReadings).toHaveBeenCalledTimes(1);
    const read = (h.getReadings.mock.calls[0][0] as { devices: { id: string }[] }).devices.map((d) => d.id).sort();
    expect(read).toEqual([device(1), device(2), device(3), device(10)].sort());
  });

  it("reports each tenant: written, unchanged, kept, left or not billed", async () => {
    const h = harness();
    const by = await results(h);
    expect(by.get(tenant(1))).toMatchObject({ kind: "written", previousTotalAmount: null });
    expect(by.get(tenant(2))).toMatchObject({ kind: "written", previousTotalAmount: 3000 });
    expect(by.get(tenant(3))).toEqual({ kind: "unchanged", tenantId: tenant(3), tenantName: "Unit 3", lineItemId: bill(3), totalAmount: 4200 });
    expect(by.get(tenant(4))).toMatchObject({ kind: "kept" });
    expect(by.get(tenant(5))).toEqual({ kind: "error", tenantId: tenant(5), tenantName: "Unit 5", code: "paid", error: REGENERATE_REFUSAL_COPY.paid, hadBill: true });
    expect(by.get(tenant(6))).toEqual({ kind: "error", tenantId: tenant(6), tenantName: "Unit 6", code: "invoiced", error: REGENERATE_REFUSAL_COPY.invoiced, hadBill: true });
    expect(by.get(tenant(7))).toEqual({ kind: "error", tenantId: tenant(7), tenantName: "Unit 7", code: "refunded", error: REGENERATE_REFUSAL_COPY.refunded, hadBill: true });
    // No bill to keep: not billed.
    for (const [n, code] of [
      [8, "unmetered_no_manual"],
      [9, "meter_assignment_continuity"],
      [10, "no_meter_reading"],
    ] as const) {
      expect(by.get(tenant(n))).toMatchObject({ kind: "error", code });
      expect(by.get(tenant(n))).not.toHaveProperty("hadBill");
    }
    expect(by.size).toBe(10);
  });

  it("leaves a bill whose meter cannot be read as it is, and says the tenant had one", async () => {
    const h = harness({ bills: [...BILLS, edgeBill(8, { device_id: null }), edgeBill(9), edgeBill(10)] });
    const by = await results(h);
    expect(by.get(tenant(8))).toMatchObject({ kind: "error", code: "unmetered_no_manual", hadBill: true });
    expect(by.get(tenant(9))).toMatchObject({ kind: "error", code: "meter_assignment_continuity", hadBill: true });
    expect(by.get(tenant(10))).toMatchObject({ kind: "error", code: "no_meter_reading", hadBill: true });
    // Nothing written for them: only unit 1's first bill and unit 2's new figures.
    expect(writes(h.rpc).map((x) => x.args._tenant_id)).toEqual([tenant(1), tenant(2)]);
  });

  it("says nothing of a bill on a run that does not guard existing bills", async () => {
    const h = harness({ bills: [...BILLS, edgeBill(8, { device_id: null })] });
    const by = await results(h, { guardExistingBills: false });
    expect(by.get(tenant(8))).toMatchObject({ kind: "error", code: "unmetered_no_manual" });
    expect(by.get(tenant(8))).not.toHaveProperty("hadBill");
  });

  it("inserts a first bill through fn_record_first_line_item_with_audit and rewrites an existing one only as it was read", async () => {
    const h = harness();
    await results(h);
    const w = writes(h.rpc);
    expect(w.map((x) => [x.name, x.args._tenant_id])).toEqual([
      ["fn_record_first_line_item_with_audit", tenant(1)],
      ["fn_regenerate_bill_with_audit", tenant(2)],
    ]);
    expect(w[1].args._expected).toEqual({
      line_item_id: bill(2),
      payment_status: "unpaid",
      total_amount: 3000,
      usage_kwh: 30,
      start_kwh: null,
      end_kwh: null,
      reading_source: "edge",
      device_id: device(2),
      tier_breakdown: [{ label: "T1", kwh: 30, amount: 3000 }],
      entered_by_user_id: null,
      manual_reason: null,
    });
    expect(w[1].args).toMatchObject({ _usage_kwh: 42, _total_amount: 4200, _reading_source: "edge", _start_kwh: null, _end_kwh: null });
    // Exactly the first bill's arguments (fn_record_line_item_with_audit's),
    // and _expected.
    const recordArgs = { ...w[1].args };
    delete recordArgs._expected;
    expect(Object.keys(recordArgs).sort()).toEqual(Object.keys(w[0].args).sort());
  });

  it.each([
    ["billing_line_item_changed: the bill changed after it was read", "bill_changed", REGENERATE_REFUSAL_COPY.changed],
    ["billing_line_item_invoiced: an invoiced bill is not regenerated here", "invoiced", REGENERATE_REFUSAL_COPY.invoiced],
    ["billing_period_closed: a bill in a closed billing period is not regenerated here", "period_closed", REGENERATE_REFUSAL_COPY.closed],
  ])("reports the conditional write's refusal %j as fixed copy, and writes the other bills", async (message, code, error) => {
    const h = harness({ writeError: (name) => (name === "fn_regenerate_bill_with_audit" ? { code: "23514", message } : null) });
    const by = await results(h);
    expect(by.get(tenant(2))).toEqual({ kind: "error", tenantId: tenant(2), tenantName: "Unit 2", code, error, hadBill: true });
    expect(by.get(tenant(1))).toMatchObject({ kind: "written" });
  });

  it.each([
    ["billing_line_item_exists: the tenant already has a bill for this billing period", "bill_exists", "hasBill"],
    ["billing_period_closed: a first bill is not added to a closed billing period", "period_closed", "closed"],
  ] as const)("reports the first bill's refusal %j as fixed copy, for that tenant only", async (message, code, copy) => {
    const h = harness({ writeError: (name) => (name === "fn_record_first_line_item_with_audit" ? { code: "23514", message } : null) });
    const by = await results(h);
    const error = copy === "closed" ? GENERATE_FROM_METERS_COPY.closed : BILL_FROM_READINGS_COPY.hasBill;
    // The tenant had no bill as read, so no hadBill.
    expect(by.get(tenant(1))).toEqual({ kind: "error", tenantId: tenant(1), tenantName: "Unit 1", code, error });
    expect(by.get(tenant(2))).toMatchObject({ kind: "written" });
  });

  it("keeps a manual bill whatever its payment status", async () => {
    const h = harness({ bills: [edgeBill(4, { reading_source: "manual", payment_status: "paid", invoice_number: "EXS-1" })] });
    const by = await results(h);
    expect(by.get(tenant(4))).toMatchObject({ kind: "kept" });
  });

  it("writes nothing for bills a first run left with the meter's figures", async () => {
    const h = harness({ bills: [edgeBill(1), edgeBill(2), edgeBill(3)] });
    const by = await results(h);
    for (const n of [1, 2, 3]) expect(by.get(tenant(n))?.kind).toBe("unchanged");
    // Only the metered tenants with no bill here are written: inserts.
    expect(writes(h.rpc).map((w) => [w.name, w.args._tenant_id])).toEqual(
      [4, 5, 6, 7].map((n) => ["fn_record_first_line_item_with_audit", tenant(n)]),
    );
  });

  it("changes nothing without it: a paid or invoiced bill is rewritten through fn_record_line_item_with_audit, as POST /api/billing/generate does", async () => {
    const h = harness();
    const by = await results(h, { guardExistingBills: undefined });
    for (const n of [5, 6, 7]) expect(by.get(tenant(n))?.kind).toBe("written");
    expect(writes(h.rpc).every((w) => w.name === "fn_record_line_item_with_audit")).toBe(true);
  });
});
