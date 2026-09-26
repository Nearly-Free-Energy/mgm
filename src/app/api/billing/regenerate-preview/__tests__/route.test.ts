/**
 * POST /api/billing/regenerate-preview — route tests (#173 BC1).
 *
 * Coverage:
 *   - 401 unauthorized when no auth user.
 *   - 400 invalid_body when manualReadings.endKwh < startKwh.
 *   - 200 returns shaped { preview, errors } with previousTotalAmount /
 *     previousPaymentStatus passthrough from the capability's preview
 *     results.
 *   - delegates to the billing capability (previewBills); assignment-date
 *     enforcement and plugin gating are capability-owned.
 *   - 404 when the period is missing; 409 when billing is disabled.
 *
 * The "no DB write" assertion is an integration concern owned by the
 * live-DB suite at `src/lib/supabase/__tests__/billing_audit_log.test.ts`
 * — here we only verify the route shape and dispatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let mockUserOverride: { id: string } | null = {
  id: "11111111-1111-4111-8111-111111111111",
};
let mockCapabilityResult: { ok: boolean; status?: number; code?: string; message?: string; data?: { results: unknown[] } } = {
  ok: true,
  data: { results: [] },
};
let lastCapabilityCall: {
  billingPeriodId?: string;
  householdIds?: string[];
  manualReadings?: unknown[];
} | null = null;
let periodRow: { id: string; microgrid_id: string } | null = {
  id: "660e8400-e29b-41d4-a716-446655441000",
  microgrid_id: "660e8400-e29b-41d4-a716-446655440000",
};
let microgridRow: { id: string; communities: { org_id: string } } | null = {
  id: "660e8400-e29b-41d4-a716-446655440000",
  communities: { org_id: "550e8400-e29b-41d4-a716-446655440000" },
};
let composeResult: { ok: boolean; status?: number; code?: string; message?: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === "billing_periods" ? periodRow : microgridRow,
            error: null,
          }),
        }),
      }),
    }),
    auth: {
      getUser: async () => ({
        data: { user: mockUserOverride },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/billing/compose", () => ({
  composeBilling: vi.fn(async () => {
    if (composeResult) return composeResult;
    return {
      ok: true,
      data: {
        billing: {
          previewBills: vi.fn(async (input: {
            billingPeriodId: string;
            householdIds?: string[];
            manualReadings?: unknown[];
          }) => {
            lastCapabilityCall = {
              billingPeriodId: input.billingPeriodId,
              householdIds: input.householdIds,
              manualReadings: input.manualReadings,
            };
            return mockCapabilityResult;
          }),
        },
        dispose: async () => {},
      },
    };
  }),
}));

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const HH_A = "660e8400-e29b-41d4-a716-446655442001";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/billing/regenerate-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/billing/regenerate-preview (#173 BC1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserOverride = { id: "11111111-1111-4111-8111-111111111111" };
    mockCapabilityResult = { ok: true, data: { results: [] } };
    lastCapabilityCall = null;
    periodRow = {
      id: "660e8400-e29b-41d4-a716-446655441000",
      microgrid_id: "660e8400-e29b-41d4-a716-446655440000",
    };
    microgridRow = {
      id: "660e8400-e29b-41d4-a716-446655440000",
      communities: { org_id: "550e8400-e29b-41d4-a716-446655440000" },
    };
    composeResult = null;
  });

  it("401 when no auth user", async () => {
    mockUserOverride = null;
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(401);
  });

  it("400 invalid_body when manualReadings.endKwh < startKwh", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          { householdId: HH_A, startKwh: 100, endKwh: 50 },
        ],
      })
    );
    expect(res.status).toBe(400);
  });

  it("delegates to the billing capability for preview (mode owned by capability)", async () => {
    mockCapabilityResult = {
      ok: true,
      data: {
        results: [
          {
            kind: "preview",
            householdId: HH_A,
            householdName: "HH A",
            startKwh: 100,
            endKwh: 200,
            usageKwh: 100,
            tierBreakdown: [{ label: "Tier 1", kwh: 50, amount: 25000 }],
            totalAmount: 49000,
            previousTotalAmount: 12000,
            previousPaymentStatus: "paid",
          },
        ],
      },
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        householdIds: [HH_A],
      })
    );
    expect(res.status).toBe(200);
    // previewBills implies mode='preview' with assignment-date enforcement —
    // the route cannot switch it off per-call.
    expect(lastCapabilityCall?.billingPeriodId).toBe(PERIOD_ID);
    expect(lastCapabilityCall?.householdIds).toEqual([HH_A]);
    const json = await res.json();
    expect(json.preview).toHaveLength(1);
    expect(json.preview[0]).toMatchObject({
      householdId: HH_A,
      householdName: "HH A",
      previousTotalAmount: 12000,
      previousPaymentStatus: "paid",
      totalAmount: 49000,
    });
    expect(json.errors).toEqual([]);
  });

  it("preview shape includes previous* fields when prior line item exists", async () => {
    mockCapabilityResult = {
      ok: true,
      data: {
        results: [
          {
            kind: "preview",
            householdId: HH_A,
            householdName: "HH A",
            startKwh: 0,
            endKwh: 0,
            usageKwh: 0,
            tierBreakdown: [],
            totalAmount: 0,
            previousTotalAmount: null,
            previousPaymentStatus: null,
          },
        ],
      },
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preview[0].previousTotalAmount).toBeNull();
    expect(json.preview[0].previousPaymentStatus).toBeNull();
  });

  it("propagates capability failures (engine fatal mapped by the capability)", async () => {
    mockCapabilityResult = {
      ok: false,
      status: 400,
      code: "billing_generation_failed",
      message: "No rate schedule found for this microgrid",
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(400);
  });

  it("404 when the period is RLS-hidden or missing", async () => {
    periodRow = null;
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(404);
    expect(lastCapabilityCall).toBeNull();
  });

  it("409 when billing is disabled (composition fails closed)", async () => {
    composeResult = {
      ok: false,
      status: 409,
      code: "billing_disabled",
      message: "Billing is disabled for this organization.",
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("billing_disabled");
    expect(lastCapabilityCall).toBeNull();
  });

  it("response splits errors with code field", async () => {
    mockCapabilityResult = {
      ok: true,
      data: {
        results: [
          {
            kind: "error",
            householdId: HH_A,
            householdName: "HH A",
            error: "Currently set to manual entry — use per-row regenerate to change.",
            code: "currently_manual",
          },
        ],
      },
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ billingPeriodId: PERIOD_ID, householdIds: [HH_A] })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preview).toEqual([]);
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0].code).toBe("currently_manual");
  });
});
