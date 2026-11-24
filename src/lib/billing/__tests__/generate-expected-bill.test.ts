/**
 * generate-expected-bill.test.ts
 *
 * A per-bill regeneration (`expectedBill`, sent by POST
 * /api/billing-line-items/[lineItemId]/regenerate and PATCH
 * /api/billing-line-items/[lineItemId]/usage):
 *
 *   - names its bill's one tenant, or the run is refused before anything is
 *     read or written;
 *   - writes through fn_regenerate_bill_with_audit with the bill as the
 *     caller read it, which refuses when the bill changed in between; those
 *     refusals come back as fixed copy with their own codes;
 *   - writes nothing, and reports `unchanged`, when the bill already has the
 *     figures it computed, so a repeated submit adds no audit row.
 *
 * A write without `expectedBill`, `guardExistingBills` or `newBillOnly` is
 * refused before anything is read (#247): no write upserts over a bill.
 *
 * Harness: a mocked Supabase client, as in generate-keeps-manual.test.ts.
 * The database side is regenerate.db.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runGenerationFor, isRunGenerationFatal, type ExpectedBill, type RunGenerationParams } from "@/lib/billing/generate";
import { REGENERATE_REFUSAL_COPY } from "@/lib/billing/schemas";
import type { MeteringProvider } from "@/lib/metering/types";

const MICROGRID_ID = "cccccccc-cccc-4000-8000-000000000001";
const PERIOD_ID = "cccccccc-cccc-4000-8006-000000000001";
const SCHEDULE_ID = "cccccccc-cccc-4000-8003-000000000001";
const TENANT = "cccccccc-cccc-4000-8005-000000000001";
const OTHER_TENANT = "cccccccc-cccc-4000-8005-000000000002";
const DEVICE = "cccccccc-cccc-4000-8004-000000000001";
const LINE_ITEM = "cccccccc-cccc-4000-8007-000000000001";
const USER = "cccccccc-cccc-4000-8fff-000000000001";

type Prior = Record<string, unknown>;

/** A manual bill of 100 → 160 kWh at 100 a kWh, entered by USER with a reason. */
const manualPrior = (o: Prior = {}): Prior => ({
  id: LINE_ITEM,
  tenant_id: TENANT,
  total_amount: 6000,
  payment_status: "paid",
  reading_source: "manual",
  start_kwh: 100,
  end_kwh: 160,
  usage_kwh: 60,
  device_id: DEVICE,
  tier_breakdown: [{ label: "T1", kwh: 60, amount: 6000 }],
  entered_by_user_id: USER,
  entered_at: "2026-04-30T10:00:00Z",
  manual_reason: "dial photo",
  ...o,
});

/** An edge bill as the usage-only path writes 42 kWh: no dial readings. */
const edgePrior = (o: Prior = {}): Prior => ({
  id: LINE_ITEM,
  tenant_id: TENANT,
  // NUMERIC columns as PostgREST may send them.
  total_amount: "4200",
  payment_status: "unpaid",
  reading_source: "edge",
  start_kwh: null,
  end_kwh: null,
  usage_kwh: "42.000",
  device_id: DEVICE,
  tier_breakdown: [{ label: "T1", kwh: 42, amount: 4200 }],
  entered_by_user_id: null,
  entered_at: null,
  manual_reason: null,
  ...o,
});

function harness(prior: Prior | null, writeError: { code: string; message: string } | null = null) {
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "fn_pin_billing_period_rate_schedule") return { data: SCHEDULE_ID, error: null };
    if (name === "fn_regenerate_bill_with_audit") {
      if (writeError) return { data: null, error: writeError };
      return { data: { id: LINE_ITEM, tenant_id: args?._tenant_id, total_amount: args?._total_amount }, error: null };
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
          status: "draft",
          rate_schedule_id: SCHEDULE_ID,
        },
        error: null,
      },
      list: { data: [], error: null },
    },
    rate_schedules: {
      maybeSingle: {
        data: { microgrid_id: MICROGRID_ID, tiers: [{ label: "T1", min_kwh: 1, max_kwh: null, rate_per_kwh: 100 }], service_charge: 0, tax_rate: 0 },
        error: null,
      },
    },
    tenants: {
      list: {
        data: [
          {
            id: TENANT,
            display_name: "Unit 1",
            tenant_devices: [
              {
                role: "primary_consumption_meter",
                effective_from: "2020-01-01",
                effective_to: null,
                devices: { id: DEVICE, openems_component_id: "meter1", edges: { openems_edge_id: "edge0" } },
              },
            ],
          },
          { id: OTHER_TENANT, display_name: "Unit 2", tenant_devices: [] },
        ],
        error: null,
      },
    },
    billing_line_items: { list: { data: prior ? [prior] : [], error: null } },
  };
  function builder(table: string) {
    const resp = responses[table] ?? { list: { data: [], error: null } };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "eq", "neq", "lte", "gte", "lt", "in", "not", "order", "limit", "is"]) b[m] = chain;
    b.single = async () => resp.single ?? { data: null, error: null };
    b.maybeSingle = async () => resp.maybeSingle ?? { data: null, error: null };
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resp.list ?? { data: [], error: null }).then(onFulfilled, onRejected);
    return b;
  }
  const supabase = { from: (table: string) => builder(table), rpc } as unknown as SupabaseClient;
  const getReadings = vi.fn(async ({ devices }: { devices: Array<{ id: string }> }) =>
    devices.map((device) => ({ deviceId: device.id, usageKwh: 42, startDate: "2026-04-01", endDate: "2026-04-30" })),
  );
  const meteringProvider = { getReadings } as unknown as MeteringProvider;
  return { supabase, rpc, meteringProvider };
}

const writes = (rpc: ReturnType<typeof vi.fn>) =>
  rpc.mock.calls.filter(([name]) => name !== "fn_pin_billing_period_rate_schedule").map(([name, args]) => ({ name, args: args as Record<string, unknown> }));

const EXPECTED: ExpectedBill = {
  lineItemId: LINE_ITEM,
  tenantId: TENANT,
  paymentStatus: "paid",
  totalAmount: 6000,
  usageKwh: 60,
  startKwh: 100,
  endKwh: 160,
  readingSource: "manual",
  deviceId: DEVICE,
  tierBreakdown: [{ label: "T1", kwh: 60, amount: 6000 }],
  enteredByUserId: USER,
  manualReason: "dial photo",
};

function run(h: ReturnType<typeof harness>, o: Partial<RunGenerationParams> = {}) {
  return runGenerationFor({
    supabase: h.supabase,
    periodId: PERIOD_ID,
    actorUserId: USER,
    mode: "write",
    meteringProvider: h.meteringProvider,
    requireEffectiveDatedAssignments: true,
    allowUsageOnlyReadings: true,
    tenantIds: [TENANT],
    ...o,
  });
}
const manual = (endKwh = 170, reason: string | null = "dial photo") => ({
  manualReadings: [{ tenantId: TENANT, startKwh: 100, endKwh, ...(reason === null ? {} : { reason }) }],
});

describe("runGenerationFor with expectedBill", () => {
  it.each([
    ["no tenantIds", { tenantIds: undefined }],
    ["another tenant", { tenantIds: [OTHER_TENANT] }],
    ["two tenants", { tenantIds: [TENANT, OTHER_TENANT] }],
    ["another tenant's manual reading", { manualReadings: [{ tenantId: OTHER_TENANT, startKwh: 0, endKwh: 1 }] }],
    ["another tenant switched back to edge data", { revertToEdgeTenantIds: [OTHER_TENANT] }],
    ["its tenant and another switched back to edge data", { revertToEdgeTenantIds: [TENANT, OTHER_TENANT] }],
    ["seed readings", { seedReadings: [{ deviceId: DEVICE, dialReadingKwh: 10, readAt: "2026-04-01T00:00:00Z", startKwh: 10 }] }],
  ])("refuses a run that does not name its bill's one tenant (%s), before reading anything", async (_label, o) => {
    const h = harness(manualPrior());
    const from = vi.spyOn(h.supabase, "from");
    const out = await run(h, { ...o, expectedBill: EXPECTED });
    expect(out).toEqual({
      kind: "fatal",
      status: 400,
      body: { error: "A per-bill regeneration names its bill's one tenant.", code: "expected_bill_mismatch" },
    });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("writes through fn_regenerate_bill_with_audit with the bill as read, and the same arguments", async () => {
    const h = harness(manualPrior());
    const out = await run(h, { ...manual(), expectedBill: EXPECTED });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results).toEqual([expect.objectContaining({ kind: "written", tenantId: TENANT, previousTotalAmount: 6000 })]);
    const [write] = writes(h.rpc);
    expect(writes(h.rpc)).toHaveLength(1);
    expect(write.name).toBe("fn_regenerate_bill_with_audit");
    expect(write.args).toMatchObject({
      _expected: {
        line_item_id: LINE_ITEM,
        payment_status: "paid",
        total_amount: 6000,
        usage_kwh: 60,
        start_kwh: 100,
        end_kwh: 160,
        reading_source: "manual",
        device_id: DEVICE,
        tier_breakdown: [{ label: "T1", kwh: 60, amount: 6000 }],
        entered_by_user_id: USER,
        manual_reason: "dial photo",
      },
      _billing_period_id: PERIOD_ID,
      _tenant_id: TENANT,
      _usage_kwh: 70,
      _total_amount: 7000,
      _reading_source: "manual",
      _manual_reason: "dial photo",
      _rate_schedule_id: SCHEDULE_ID,
    });
    // Every key fn_regenerate_bill_with_audit requires, and no other.
    expect(Object.keys(write.args._expected as object).sort()).toEqual(
      ["device_id", "end_kwh", "entered_by_user_id", "line_item_id", "manual_reason", "payment_status", "reading_source", "start_kwh", "tier_breakdown", "total_amount", "usage_kwh"],
    );
    // Exactly fn_regenerate_bill_with_audit's parameters (database.gen.ts):
    // fn_record_line_item_with_audit's, which it passes on, and _expected.
    expect(Object.keys(write.args).sort()).toEqual([
      "_actor_kind",
      "_actor_ref",
      "_actor_user_id",
      "_audit_details",
      "_billing_period_id",
      "_device_id",
      "_end_kwh",
      "_entered_by_user_id",
      "_expected",
      "_manual_reason",
      "_rate_schedule_id",
      "_reading_source",
      "_start_kwh",
      "_tenant_id",
      "_tier_breakdown",
      "_total_amount",
      "_usage_kwh",
    ]);
  });

  it.each([
    ["billing_period_closed: a bill in a closed billing period is not regenerated here", "period_closed", REGENERATE_REFUSAL_COPY.closed],
    ["billing_line_item_invoiced: an invoiced bill is not regenerated here", "invoiced", REGENERATE_REFUSAL_COPY.invoiced],
    ["billing_line_item_changed: the bill changed after it was read", "bill_changed", REGENERATE_REFUSAL_COPY.changed],
  ])("answers the conditional write's refusal %j as fixed copy", async (message, code, error) => {
    const h = harness(manualPrior(), { code: "23514", message });
    const out = await run(h, { ...manual(), expectedBill: EXPECTED });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results).toEqual([{ kind: "error", tenantId: TENANT, tenantName: "Unit 1", code, error }]);
  });

  it("leaves other write failures as they were", async () => {
    const h = harness(manualPrior(), { code: "23514", message: "Billing period tariff changed; recalculate before writing bill" });
    const out = await run(h, { ...manual(), expectedBill: EXPECTED });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results).toEqual([expect.objectContaining({ kind: "error", code: "tariff_changed" })]);
    // A token the function does not raise is an ordinary failure, not a refusal.
    const other = harness(manualPrior(), { code: "23514", message: "billing_line_item_exists: x" });
    const outOther = await run(other, { ...manual(), expectedBill: EXPECTED });
    if (isRunGenerationFatal(outOther)) throw new Error(outOther.body.error);
    expect(outOther.results).toEqual([expect.objectContaining({ kind: "error", code: "line_item_write_failed" })]);
  });

  it("writes nothing when the manual readings, reason and person are the ones the bill has", async () => {
    const h = harness(manualPrior());
    const out = await run(h, { ...manual(160), expectedBill: EXPECTED });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results).toEqual([{ kind: "unchanged", tenantId: TENANT, tenantName: "Unit 1", lineItemId: LINE_ITEM, totalAmount: 6000 }]);
    expect(writes(h.rpc)).toEqual([]);
  });

  it.each([
    ["another reason", manual(160, "second visit"), {}],
    ["no reason", manual(160, null), {}],
    ["another person", manual(160), { entered_by_user_id: "cccccccc-cccc-4000-8fff-000000000002" }],
    ["other readings with the same usage", { manualReadings: [{ tenantId: TENANT, startKwh: 200, endKwh: 260, reason: "dial photo" }] }, {}],
    ["a stored breakdown under another tier label", manual(160), { tier_breakdown: [{ label: "Lifeline", kwh: 60, amount: 6000 }] }],
  ])("writes when the manual figures differ in %s", async (_label, readings, prior) => {
    const h = harness(manualPrior(prior));
    const out = await run(h, { ...readings, expectedBill: EXPECTED });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results[0]?.kind).toBe("written");
    expect(writes(h.rpc).map((w) => w.name)).toEqual(["fn_regenerate_bill_with_audit"]);
  });

  it("writes nothing when the meter gives the figures the edge bill has", async () => {
    const h = harness(edgePrior());
    const expectedBill: ExpectedBill = { ...EXPECTED, paymentStatus: "unpaid", totalAmount: 4200, usageKwh: 42, startKwh: null, endKwh: null, readingSource: "edge" };
    const out = await run(h, { expectedBill });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results).toEqual([{ kind: "unchanged", tenantId: TENANT, tenantName: "Unit 1", lineItemId: LINE_ITEM, totalAmount: 4200 }]);
    expect(writes(h.rpc)).toEqual([]);
    // A different reading is written.
    const changed = harness(edgePrior({ usage_kwh: 41, total_amount: 4100, tier_breakdown: [{ label: "T1", kwh: 41, amount: 4100 }] }));
    const out2 = await run(changed, { expectedBill });
    if (isRunGenerationFatal(out2)) throw new Error(out2.body.error);
    expect(out2.results[0]?.kind).toBe("written");
  });

  it("writes a bill that does not exist yet", async () => {
    const h = harness(null);
    const out = await run(h, { ...manual(160), expectedBill: EXPECTED });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results[0]?.kind).toBe("written");
    expect(writes(h.rpc).map((w) => w.name)).toEqual(["fn_regenerate_bill_with_audit"]);
  });

  it.each([
    ["one tenant's readings", manual(160)],
    ["every tenant", { tenantIds: undefined }],
  ])("refuses a write without expectedBill (%s), before reading or writing anything", async (_label, o) => {
    const h = harness(manualPrior());
    const from = vi.spyOn(h.supabase, "from");
    expect(await run(h, o)).toEqual({
      kind: "fatal",
      status: 500,
      body: { error: "A bill is written only as it was read, or as a tenant's first bill.", code: "unguarded_write" },
    });
    expect(from).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("is ignored by a preview", async () => {
    const h = harness(manualPrior());
    const out = await run(h, { ...manual(160), mode: "preview", tenantIds: undefined, expectedBill: EXPECTED });
    if (isRunGenerationFatal(out)) throw new Error(out.body.error);
    expect(out.results.map((r) => r.kind)).toEqual(expect.arrayContaining(["preview"]));
    expect(writes(h.rpc)).toEqual([]);
  });
});
