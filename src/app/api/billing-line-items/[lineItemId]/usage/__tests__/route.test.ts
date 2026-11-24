/**
 * PATCH /api/billing-line-items/[lineItemId]/usage — route tests (#158).
 *
 * Coverage:
 *   - 400: invalid UUID, invalid JSON, missing body keys, negative number,
 *          non-numeric value, end_kwh < start_kwh derivation underflow
 *   - 403: caller cannot access microgrid
 *   - 404: line item not found / RLS-hidden
 *   - 409: device_linked — line item still has a device_id (metered)
 *   - 409: device_linked — tenant has a primary_consumption_meter link
 *   - 409: period_closed — billing period is closed
 *   - 409: invoiced, refunded — as the regenerate route refuses them (#247)
 *   - 428: a paid bill without the acknowledgement (#247)
 *   - 409: the write's refusals of a bill that changed after the read
 *   - 200: happy path with usage_kwh only — server recomputes tier_breakdown
 *   - 200: happy path with end_kwh only — server derives usage_kwh
 *   - 200: tier_breakdown + total_amount math is correct against a fixture
 *   - 200: the bill as read, when the engine finds nothing to write
 *   - the run is a per-bill regeneration: the bill as read is its expectedBill
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { calculateTieredCost } from "@/lib/billing/calculations";

// ── Mocks ─────────────────────────────────────────────────────────────────

let canAccessMicrogridReturn = true;

const mockLineItemMaybeSingle = vi.fn();
const mockMeterLinks = vi.fn();
const mockRateScheduleMaybeSingle = vi.fn();
// BC1 (#173): the route now delegates to runGenerationFor instead of doing
// its own UPDATE. We capture the call args (so the existing assertions on
// the resulting tier_breakdown / total_amount / usage_kwh stay meaningful)
// and synthesize a written-result row whose calc mirrors the route's
// derivation (manualReading.endKwh - startKwh → calculateTieredCost).
let capturedUpdatePayload: Record<string, unknown> | null = null;
// The engine's answer for the tenant, when a test replaces the written row.
const engine = vi.hoisted(() => ({ result: null as Record<string, unknown> | null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFromImpl(): any {
  return (table: string) => {
    if (table === "billing_line_items") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => mockLineItemMaybeSingle(),
          }),
        }),
      };
    }
    if (table === "tenant_devices") {
      const query = {
        select: () => ({
          eq: () => ({
            eq: () => ({
              then: (
                onFulfilled: (value: unknown) => unknown,
                onRejected?: (reason: unknown) => unknown
              ) => Promise.resolve(mockMeterLinks()).then(onFulfilled, onRejected),
            }),
          }),
        }),
      };
      return query;
    }
    if (table === "rate_schedules") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () => mockRateScheduleMaybeSingle(),
              }),
            }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

const mockFrom = vi.fn(makeFromImpl());

// Stub runGenerationFor so the route's pre-flight assertions can be tested
// without spinning up the full generate-engine mock surface (which would
// duplicate the integration test in src/lib/billing/__tests__/generate.test.ts).
// The stub captures the call args, runs `calculateTieredCost` against the
// fixture rate schedule for fidelity with the historical assertions, and
// returns a synthesized written line item.
//
// Note: vi.mock factory is hoisted; references inside use only top-level
// imports (calculateTieredCost) and module-scope `let` (capturedUpdatePayload,
// capturedRunGenerationCall) — the constants LI_UUID / FIXTURE_RATE_SCHEDULE
// are inlined verbatim because hoisting evaluates the factory before the
// const declarations.
vi.mock("@/lib/billing/generate", async () => {
  return {
    isRunGenerationFatal: (out: { kind?: string }) =>
      Boolean(out && out.kind === "fatal"),
    runGenerationFor: vi.fn(async (params: {
      periodId: string;
      tenantIds?: string[];
      manualReadings?: Array<{ tenantId: string; startKwh: number; endKwh: number; reason?: string }>;
    }) => {
      const m = params.manualReadings?.[0];
      if (!m) {
        return { results: [] };
      }
      if (engine.result) return { results: [{ tenantId: m.tenantId, tenantName: "Stub HH", ...engine.result }] };
      // Two-tier schedule: 0–50 kWh at 500/kWh, 51+ at 800/kWh — kept in
      // sync with FIXTURE_RATE_SCHEDULE below.
      const tiers = [
        { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
        { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 800 },
      ];
      const calc = calculateTieredCost(
        m.endKwh - m.startKwh,
        tiers as never,
        0,
        0,
      );
      // Synthesized "written" line item — populates the captured update
      // payload that the historical assertions inspect (usage_kwh,
      // tier_breakdown, total_amount, end_kwh).
      capturedUpdatePayload = {
        usage_kwh: m.endKwh - m.startKwh,
        end_kwh: m.endKwh,
        tier_breakdown: calc.tierBreakdown,
        total_amount: calc.totalAmount,
      };
      return {
        results: [
          {
            kind: "written" as const,
            tenantId: m.tenantId,
            tenantName: "Stub HH",
            lineItem: {
              id: "660e8400-e29b-41d4-a716-446655440111",
              device_id: null,
              ...capturedUpdatePayload,
            },
            previousTotalAmount: null,
            previousPaymentStatus: null,
            previousReadingSource: null,
          },
        ],
      };
    }),
  };
});

const session = vi.hoisted(() => ({
  user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    // BC1 (#173) added an explicit auth gate at the top of the route. Tests
    // mock the session as a stable test user — RLS isn't exercised by the
    // unit suite (covered by RLS tests against live Supabase).
    auth: {
      getUser: async () => ({ data: { user: session.user }, error: null }),
    },
    rpc: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

vi.mock("@/lib/runtime/gate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/runtime/gate")>(),
  gateRoute: async () => null,
}));

const LI_UUID = "660e8400-e29b-41d4-a716-446655440111";
const HH_UUID = "660e8400-e29b-41d4-a716-446655440222";
const PERIOD_UUID = "660e8400-e29b-41d4-a716-446655440333";
const MG_UUID = "660e8400-e29b-41d4-a716-446655440444";
const DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544aaaa";
const BAD_ID = "not-a-uuid";

function makePatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-line-items/${id}/usage`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  );
}

const FIXTURE_RATE_SCHEDULE = {
  id: "rs-1",
  microgrid_id: MG_UUID,
  // Two-tier schedule: 0–50 kWh at 500/kWh, 51+ at 800/kWh.
  tiers: [
    { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
    { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 800 },
  ],
  service_charge: 0,
  tax_rate: 0,
  created_at: "2026-01-01T00:00:00Z",
};

/** The default bill's columns, as `select("*")` reads them: an unpaid manual bill with no invoice number. */
const BILL_COLUMNS = {
  id: LI_UUID,
  device_id: null,
  start_kwh: 0,
  end_kwh: null,
  usage_kwh: null,
  tenant_id: HH_UUID,
  billing_period_id: PERIOD_UUID,
  payment_status: "unpaid",
  invoice_number: null,
  // NUMERIC, which can arrive as a string.
  total_amount: "0",
  reading_source: "manual",
  tier_breakdown: [],
  entered_by_user_id: "11111111-1111-4111-8111-111111111111",
  manual_reason: null,
};
const DRAFT = {
  id: PERIOD_UUID,
  microgrid_id: MG_UUID,
  status: "draft",
  start_date: "2026-04-01",
  end_date: "2026-04-30",
};
/** The default bill with `o` over it, in the draft period. */
const billRow = (o: Record<string, unknown> = {}) => ({ data: { ...BILL_COLUMNS, ...o, billing_periods: DRAFT }, error: null });

async function patch(body: unknown) {
  const { PATCH } = await import("../route");
  return PATCH(makePatchRequest(LI_UUID, body), { params: Promise.resolve({ lineItemId: LI_UUID }) });
}

async function engineCall() {
  const { runGenerationFor } = await import("@/lib/billing/generate");
  return vi.mocked(runGenerationFor).mock.calls;
}

describe("PATCH /api/billing-line-items/[lineItemId]/usage (#158)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessMicrogridReturn = true;
    capturedUpdatePayload = null;
    engine.result = null;
    mockFrom.mockImplementation(makeFromImpl());

    // Default un-metered line item (device_id null), draft period, no
    // tenant meter link, fresh rate schedule.
    mockLineItemMaybeSingle.mockResolvedValue({
      data: {
        ...BILL_COLUMNS,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "draft",
          start_date: "2026-04-01",
          end_date: "2026-04-30",
        },
      },
      error: null,
    });
    mockMeterLinks.mockResolvedValue({ data: [], error: null });
    mockRateScheduleMaybeSingle.mockResolvedValue({
      data: FIXTURE_RATE_SCHEDULE,
      error: null,
    });
  });

  it("checks the body before the session: a malformed body is 400 even signed out", async () => {
    session.user = null;
    try {
      const { PATCH } = await import("../route");
      const bad = await PATCH(makePatchRequest(LI_UUID, { usage_kwh: "a" as unknown as number }), {
        params: Promise.resolve({ lineItemId: LI_UUID }),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { code: string }).code).toBe("invalid_body");
      const good = await PATCH(makePatchRequest(LI_UUID, { usage_kwh: 10 }), {
        params: Promise.resolve({ lineItemId: LI_UUID }),
      });
      expect(good.status).toBe(401);
    } finally {
      session.user = { id: "11111111-1111-4111-8111-111111111111" };
    }
  });

  it("400: invalid UUID", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(BAD_ID, { usage_kwh: 10 }), {
      params: Promise.resolve({ lineItemId: BAD_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: invalid JSON", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(LI_UUID, "{not json"), {
      params: Promise.resolve({ lineItemId: LI_UUID }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "invalid_body" });
  });

  it("400: missing both keys", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(LI_UUID, {}), {
      params: Promise.resolve({ lineItemId: LI_UUID }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({
      error: "At least one of usage_kwh or end_kwh is required",
      code: "invalid_body",
    });
  });

  it("400: unknown key rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10, note: "x" }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown field: note", code: "invalid_body" });
    expect(capturedUpdatePayload).toBeNull();
  });

  it("400: negative number rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: -5 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "usage_kwh must be a non-negative number",
      field: "usage_kwh",
      code: "invalid_body",
    });
  });

  it("400: non-numeric usage_kwh rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: "lots" as unknown as number }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "usage_kwh must be a finite number",
      field: "usage_kwh",
      code: "invalid_body",
    });
  });

  it("403: caller cannot access microgrid", async () => {
    canAccessMicrogridReturn = false;
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(403);
  });

  it("404: line item not found", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(404);
  });

  it("409: device_linked — line item already has a device_id", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: {
        ...BILL_COLUMNS,
        id: LI_UUID,
        device_id: DEVICE_UUID, // metered row — must reject manual edit
        start_kwh: 0,
        end_kwh: 100,
        usage_kwh: 100,
        tenant_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "draft",
        },
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_linked");
  });

  it("409: device_linked — tenant has primary_consumption_meter link (line item device_id null)", async () => {
    // Belt-and-braces: even when the line item itself has no device_id,
    // a tenant-level meter link blocks manual edit. The meter link
    // would be filled in on the next Refresh Readings.
    mockMeterLinks.mockResolvedValueOnce({
      data: [{ device_id: DEVICE_UUID, effective_from: "2026-01-01", effective_to: null }],
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_linked");
  });

  it("200: historical replacement links outside the period do not block a manual correction", async () => {
    mockMeterLinks.mockResolvedValueOnce({
      data: [
        { device_id: DEVICE_UUID, effective_from: "2025-01-01", effective_to: "2025-02-01" },
        { device_id: "660e8400-e29b-41d4-a716-44665544bbbb", effective_from: "2027-01-01", effective_to: null },
      ],
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );

    expect(res.status).toBe(200);
  });

  it("409: period_closed — closed period rejects", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: {
        ...BILL_COLUMNS,
        id: LI_UUID,
        device_id: null,
        start_kwh: 0,
        end_kwh: null,
        usage_kwh: null,
        tenant_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "closed",
        },
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("period_closed");
  });

  it("200: happy path with usage_kwh only — recomputes tier_breakdown via calculateTieredCost", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 80 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(200);

    // 80 kWh on the fixture schedule:
    //   tier 1: 50 kWh × 500 = 25000
    //   tier 2: 30 kWh × 800 = 24000
    //   total: 49000
    expect(capturedUpdatePayload).not.toBeNull();
    const payload = capturedUpdatePayload as Record<string, unknown>;
    expect(payload.usage_kwh).toBe(80);
    expect(payload.total_amount).toBe(49000);
    const breakdown = payload.tier_breakdown as {
      label: string;
      kwh: number;
      amount: number;
    }[];
    expect(breakdown.length).toBe(2);
    expect(breakdown[0]).toEqual({ label: "Tier 1", kwh: 50, amount: 25000 });
    expect(breakdown[1]).toEqual({ label: "Tier 2", kwh: 30, amount: 24000 });
  });

  it("200: happy path with end_kwh only — derives usage_kwh = end_kwh - start_kwh", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { end_kwh: 80 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(200);

    expect(capturedUpdatePayload).not.toBeNull();
    const payload = capturedUpdatePayload as Record<string, unknown>;
    expect(payload.usage_kwh).toBe(80);
    expect(payload.end_kwh).toBe(80);
    expect(payload.total_amount).toBe(49000);
  });

  it("400: end_kwh < start_kwh derivation underflow rejected", async () => {
    // Override start_kwh = 100, send end_kwh = 50 → derived usage = -50 → 400.
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: {
        ...BILL_COLUMNS,
        id: LI_UUID,
        device_id: null,
        start_kwh: 100,
        end_kwh: null,
        usage_kwh: null,
        tenant_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "draft",
        },
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { end_kwh: 50 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(400);
    // Checked after the database lookup, so it keeps the route's own shape.
    expect(await res.json()).toEqual({
      error: "end_kwh must be greater than or equal to start_kwh",
      reason: "invalid_body",
    });
  });

  it.each([
    ["an invoiced bill", { invoice_number: "INV-0001" }, "invoiced", "This bill has been invoiced, so its usage cannot be corrected: its invoice number is already issued."],
    ["a refunded bill", { payment_status: "refunded" }, "refunded", "A refunded bill's usage cannot be corrected."],
  ])("409: refuses %s, as the regenerate route does, and writes nothing", async (_label, o, reason, error) => {
    mockLineItemMaybeSingle.mockResolvedValueOnce(billRow(o));
    const res = await patch({ usage_kwh: 10, confirmation: { acknowledged: ["regenerate-paid-bill"] } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error, reason });
    expect(await engineCall()).toEqual([]);
  });

  it("refuses a closed period before an invoiced or refunded bill, and those before a metered one", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: { ...BILL_COLUMNS, invoice_number: "INV-0001", payment_status: "refunded", device_id: DEVICE_UUID, billing_periods: { ...DRAFT, status: "closed" } },
      error: null,
    });
    expect((await (await patch({ usage_kwh: 10 })).json()).reason).toBe("period_closed");
    mockLineItemMaybeSingle.mockResolvedValueOnce(billRow({ invoice_number: "INV-0001", payment_status: "refunded", device_id: DEVICE_UUID }));
    expect((await (await patch({ usage_kwh: 10 })).json()).reason).toBe("invoiced");
    mockLineItemMaybeSingle.mockResolvedValueOnce(billRow({ payment_status: "refunded", device_id: DEVICE_UUID }));
    expect((await (await patch({ usage_kwh: 10 })).json()).reason).toBe("refunded");
  });

  it("428: a paid bill needs the regenerate route's acknowledgement, and nothing is written without it", async () => {
    mockLineItemMaybeSingle.mockResolvedValue(billRow({ payment_status: "paid" }));
    for (const confirmation of [undefined, { acknowledged: [] }, { acknowledged: ["something-else"] }]) {
      const res = await patch({ usage_kwh: 10, ...(confirmation ? { confirmation } : {}) });
      expect(res.status).toBe(428);
      expect(await res.json()).toEqual({
        error: "This bill is marked paid. Confirm that you want to correct its usage anyway.",
        reason: "paid_acknowledgement_required",
      });
    }
    expect(await engineCall()).toEqual([]);

    const res = await patch({ usage_kwh: 10, confirmation: { acknowledged: ["regenerate-paid-bill"] } });
    expect(res.status).toBe(200);
    expect(await engineCall()).toHaveLength(1);
  });

  it("asks a paid bill for the acknowledgement only after the refusals, so a refused correction is not confirmed first", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce(billRow({ payment_status: "paid", start_kwh: null }));
    expect((await (await patch({ usage_kwh: 10 })).json()).reason).toBe("missing_start_reading");
    mockLineItemMaybeSingle.mockResolvedValueOnce(billRow({ payment_status: "paid", start_kwh: 100 }));
    expect((await patch({ end_kwh: 50 })).status).toBe(400);
  });

  it("runs a per-bill regeneration for the bill's one tenant, with the bill as read as its expectedBill", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce(
      billRow({
        start_kwh: "100",
        end_kwh: "130.5",
        usage_kwh: "30.5",
        total_amount: "15250",
        tier_breakdown: [{ label: "Tier 1", kwh: 30.5, amount: 15250 }],
        manual_reason: "dial photo",
      }),
    );
    expect((await patch({ usage_kwh: 40 })).status).toBe(200);
    const [[params]] = await engineCall();
    expect(params).toMatchObject({
      periodId: PERIOD_UUID,
      tenantIds: [HH_UUID],
      manualReadings: [{ tenantId: HH_UUID, startKwh: 100, endKwh: 140 }],
      mode: "write",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      expectedBill: {
        lineItemId: LI_UUID,
        tenantId: HH_UUID,
        paymentStatus: "unpaid",
        totalAmount: 15250,
        usageKwh: 30.5,
        startKwh: 100,
        endKwh: 130.5,
        readingSource: "manual",
        deviceId: null,
        tierBreakdown: [{ label: "Tier 1", kwh: 30.5, amount: 15250 }],
        enteredByUserId: "11111111-1111-4111-8111-111111111111",
        manualReason: "dial photo",
      },
    });
  });

  it.each([
    ["period_closed", "Cannot edit a closed period"],
    ["invoiced", "This bill has been invoiced, so its usage cannot be corrected: its invoice number is already issued."],
    ["bill_changed", "This bill changed while its usage was being corrected. Refresh it and try again."],
  ])("409: the write's refusal %s, when the bill changed after the read, in the route's copy", async (code, error) => {
    engine.result = { kind: "error", code, error: "the engine's copy" };
    const res = await patch({ usage_kwh: 10 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error, reason: code });
  });

  it("500 for any other write failure", async () => {
    engine.result = { kind: "error", code: "line_item_write_failed", error: "Failed to write line item: boom" };
    const res = await patch({ usage_kwh: 10 });
    expect(res.status).toBe(500);
    expect((await res.json()).reason).toBe("unknown_error");
  });

  it("200 with the bill as read when it already has these figures, and nothing was written", async () => {
    engine.result = { kind: "unchanged", lineItemId: LI_UUID, totalAmount: 0 };
    const res = await patch({ usage_kwh: 0 });
    expect(res.status).toBe(200);
    const { billing_periods, ...asRead } = billRow().data;
    void billing_periods;
    expect(await res.json()).toEqual({ lineItem: asRead });
  });

  it("409: missing start register never becomes zero consumption baseline", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: {
        ...BILL_COLUMNS,
        id: LI_UUID,
        device_id: null,
        start_kwh: null,
        end_kwh: null,
        usage_kwh: null,
        tenant_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "draft",
          start_date: "2026-04-01",
          end_date: "2026-04-30",
        },
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(LI_UUID, { usage_kwh: 10 }), {
      params: Promise.resolve({ lineItemId: LI_UUID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("missing_start_reading");
    expect(capturedUpdatePayload).toBeNull();
  });
});
