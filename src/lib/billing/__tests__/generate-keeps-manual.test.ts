/**
 * generate-keeps-manual.test.ts
 *
 * A tenant whose line item in the period already has
 * `reading_source='manual'` keeps that row unless the request re-enters it
 * (`manualReadings`) or names it in `revertToEdgeTenantIds`:
 *
 *   - a whole-period run from meter data (`guardExistingBills`, what
 *     generate-from-meters sends), or a preview of every tenant, reports it
 *     as `kind: 'kept'`, writes nothing for it and does not read its meter
 *     — paid or unpaid;
 *   - `revertToEdgeTenantIds` switches it back to an OpenEMS reading, on a
 *     per-bill regeneration (`expectedBill`) or a preview;
 *   - a per-bill regeneration naming it without a revert is still refused
 *     with `currently_manual`.
 *
 * Harness: a mocked Supabase client, like `generate-unmetered-skip.test.ts`,
 * so the suite runs under `SKIP_RLS_TESTS=1`. Writes are observed through
 * the `supabase.rpc` spy.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runGenerationFor, isRunGenerationFatal, type ExpectedBill } from "@/lib/billing/generate";
import type { MeteringProvider } from "@/lib/metering/types";

const MICROGRID_ID = "bbbbbbbb-bbbb-4000-8000-000000000001";
const PERIOD_ID = "bbbbbbbb-bbbb-4000-8006-000000000001";
const SCHEDULE_ID = "bbbbbbbb-bbbb-4000-8003-000000000001";
const HH_MANUAL = "bbbbbbbb-bbbb-4000-8005-000000000001";
const HH_EDGE = "bbbbbbbb-bbbb-4000-8005-000000000002";
const DEV_MANUAL = "bbbbbbbb-bbbb-4000-8004-000000000001";
const DEV_EDGE = "bbbbbbbb-bbbb-4000-8004-000000000002";

function meter(deviceId: string, componentId: string) {
  return {
    role: "primary_consumption_meter",
    effective_from: "2020-01-01",
    effective_to: null,
    devices: {
      id: deviceId,
      openems_component_id: componentId,
      edges: { openems_edge_id: "edge0" },
    },
  };
}

function priorItem(
  tenantId: string,
  deviceId: string,
  readingSource: "manual" | "edge",
  paymentStatus: "paid" | "unpaid"
) {
  return {
    tenant_id: tenantId,
    total_amount: 5000,
    payment_status: paymentStatus,
    reading_source: readingSource,
    start_kwh: 100,
    end_kwh: 150,
    usage_kwh: 50,
    device_id: deviceId,
    tier_breakdown: [],
    entered_by_user_id: readingSource === "manual" ? "user-1" : null,
    entered_at: readingSource === "manual" ? "2026-04-30T10:00:00Z" : null,
    manual_reason: readingSource === "manual" ? "Read on site" : null,
  };
}

function makeSupabase(manualPaymentStatus: "paid" | "unpaid") {
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === "fn_pin_billing_period_rate_schedule") {
      return { data: SCHEDULE_ID, error: null };
    }
    if (WRITES.includes(name)) {
      return {
        data: { id: `li-${String(args?._tenant_id)}`, ...args },
        error: null,
      };
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
      // A whole-period run reads the status again before writing.
      maybeSingle: { data: { status: "draft" }, error: null },
      // No earlier periods, so start_kwh comes from the usage-only path.
      list: { data: [], error: null },
    },
    rate_schedules: {
      maybeSingle: {
        data: {
          microgrid_id: MICROGRID_ID,
          tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 100 }],
          service_charge: 0,
          tax_rate: 0,
        },
        error: null,
      },
    },
    tenants: {
      list: {
        data: [
          {
            id: HH_MANUAL,
            display_name: "Manual Tenant",
            tenant_devices: [meter(DEV_MANUAL, "meter1")],
          },
          {
            id: HH_EDGE,
            display_name: "Edge Tenant",
            tenant_devices: [meter(DEV_EDGE, "meter2")],
          },
        ],
        error: null,
      },
    },
    billing_line_items: {
      list: {
        data: [
          priorItem(HH_MANUAL, DEV_MANUAL, "manual", manualPaymentStatus),
          priorItem(HH_EDGE, DEV_EDGE, "edge", "unpaid"),
        ],
        error: null,
      },
    },
  };

  function builder(table: string) {
    const resp = responses[table] ?? { list: { data: [], error: null } };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "eq", "neq", "lte", "gte", "in", "not", "order", "limit"]) {
      b[m] = chain;
    }
    b.single = async () => resp.single ?? { data: null, error: null };
    b.maybeSingle = async () => resp.maybeSingle ?? { data: null, error: null };
    b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resp.list ?? { data: [], error: null }).then(onFulfilled, onRejected);
    return b;
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc,
  } as unknown as SupabaseClient;

  const getReadings = vi.fn(async ({ devices }: { devices: Array<{ id: string }> }) =>
    devices.map((device) => ({
      deviceId: device.id,
      usageKwh: 42,
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    }))
  );
  const meteringProvider = { getReadings } as unknown as MeteringProvider;

  return { supabase, rpc, getReadings, meteringProvider };
}

/** The engine's writes: a bill as it was read, or a first bill. */
const WRITES = ["fn_regenerate_bill_with_audit", "fn_record_first_line_item_with_audit"];

function writtenTenants(rpc: ReturnType<typeof vi.fn>) {
  return rpc.mock.calls
    .filter(([name]) => WRITES.includes(name))
    .map(([, args]) => (args as Record<string, unknown>)._tenant_id);
}

/** The manual tenant's bill as a per-bill regeneration read it (priorItem). */
const manualBill = (paymentStatus: "paid" | "unpaid"): ExpectedBill => ({
  lineItemId: "li-manual",
  tenantId: HH_MANUAL,
  paymentStatus,
  totalAmount: 5000,
  usageKwh: 50,
  startKwh: 100,
  endKwh: 150,
  readingSource: "manual",
  deviceId: DEV_MANUAL,
  tierBreakdown: [],
  enteredByUserId: "user-1",
  manualReason: "Read on site",
});

const ENGINE_OPTIONS = {
  periodId: PERIOD_ID,
  actorUserId: "user-1",
  requireEffectiveDatedAssignments: true,
  allowUsageOnlyReadings: true,
} as const;

describe("runGenerationFor: manual rows on a bulk run", () => {
  it.each(["paid", "unpaid"] as const)(
    "keeps a %s manual row on a whole-period run and reads only the edge tenants",
    async (paymentStatus) => {
      const { supabase, rpc, getReadings, meteringProvider } = makeSupabase(paymentStatus);

      const out = await runGenerationFor({
        ...ENGINE_OPTIONS,
        supabase,
        mode: "write",
        guardExistingBills: true,
        meteringProvider,
      });

      expect(isRunGenerationFatal(out)).toBe(false);
      if (isRunGenerationFatal(out)) return;
      expect(out.results).toEqual(
        expect.arrayContaining([
          {
            kind: "kept",
            tenantId: HH_MANUAL,
            tenantName: "Manual Tenant",
            readingSource: "manual",
          },
          expect.objectContaining({ kind: "written", tenantId: HH_EDGE }),
        ])
      );
      expect(out.results.some((r) => r.kind === "error")).toBe(false);
      expect(writtenTenants(rpc)).toEqual([HH_EDGE]);
      expect(getReadings).toHaveBeenCalledTimes(1);
      expect(getReadings.mock.calls[0][0].devices.map((d: { id: string }) => d.id)).toEqual([
        DEV_EDGE,
      ]);
    }
  );

  it("keeps a manual row in preview too", async () => {
    const { supabase, meteringProvider } = makeSupabase("unpaid");

    const out = await runGenerationFor({
      ...ENGINE_OPTIONS,
      supabase,
      mode: "preview",
      meteringProvider,
    });

    expect(isRunGenerationFatal(out)).toBe(false);
    if (isRunGenerationFatal(out)) return;
    expect(out.results.find((r) => r.tenantId === HH_MANUAL)?.kind).toBe("kept");
    expect(out.results.find((r) => r.tenantId === HH_EDGE)?.kind).toBe("preview");
  });

  it("switches a manual row back to edge when a per-bill regeneration names it in revertToEdgeTenantIds", async () => {
    const { supabase, rpc, getReadings, meteringProvider } = makeSupabase("paid");

    const out = await runGenerationFor({
      ...ENGINE_OPTIONS,
      supabase,
      mode: "write",
      tenantIds: [HH_MANUAL],
      revertToEdgeTenantIds: [HH_MANUAL],
      expectedBill: manualBill("paid"),
      meteringProvider,
    });

    expect(isRunGenerationFatal(out)).toBe(false);
    if (isRunGenerationFatal(out)) return;
    expect(out.results).toMatchObject([
      {
        kind: "written",
        tenantId: HH_MANUAL,
        previousReadingSource: "manual",
        previousPaymentStatus: "paid",
      },
    ]);
    expect(getReadings.mock.calls[0][0].devices.map((d: { id: string }) => d.id)).toEqual([
      DEV_MANUAL,
    ]);
    expect(rpc).toHaveBeenCalledWith(
      "fn_regenerate_bill_with_audit",
      expect.objectContaining({
        _tenant_id: HH_MANUAL,
        _reading_source: "edge",
        _manual_reason: null,
        _usage_kwh: 42,
      })
    );
  });

  it("lets a preview of every tenant switch back the tenants it names in revertToEdgeTenantIds", async () => {
    const { supabase, rpc, getReadings, meteringProvider } = makeSupabase("unpaid");

    const out = await runGenerationFor({
      ...ENGINE_OPTIONS,
      supabase,
      mode: "preview",
      revertToEdgeTenantIds: [HH_MANUAL],
      meteringProvider,
    });

    expect(isRunGenerationFatal(out)).toBe(false);
    if (isRunGenerationFatal(out)) return;
    expect(out.results.some((r) => r.kind === "kept")).toBe(false);
    expect(out.results.filter((r) => r.kind === "preview").map((r) => r.tenantId).sort()).toEqual([HH_MANUAL, HH_EDGE].sort());
    expect(getReadings.mock.calls[0][0].devices.map((d: { id: string }) => d.id).sort()).toEqual([DEV_MANUAL, DEV_EDGE].sort());
    expect(writtenTenants(rpc)).toEqual([]);
  });

  it("still refuses a manual row a per-bill regeneration names without a revert", async () => {
    const { supabase, rpc, getReadings, meteringProvider } = makeSupabase("unpaid");

    const out = await runGenerationFor({
      ...ENGINE_OPTIONS,
      supabase,
      mode: "write",
      tenantIds: [HH_MANUAL],
      expectedBill: manualBill("unpaid"),
      meteringProvider,
    });

    expect(isRunGenerationFatal(out)).toBe(false);
    if (isRunGenerationFatal(out)) return;
    expect(out.results).toMatchObject([
      { kind: "error", tenantId: HH_MANUAL, code: "currently_manual" },
    ]);
    expect(getReadings).not.toHaveBeenCalled();
    expect(writtenTenants(rpc)).toEqual([]);
  });
});
