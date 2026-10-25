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
 *     enforcement is capability-owned. Plugin gating is not: the
 *     capability's generation checks plugin state only in write mode, and
 *     previewBills runs it in preview mode, so the route's gate below is
 *     the only plugin check on this path (revisit if runGeneration starts
 *     gating preview).
 *   - 404 when the period is missing; composition failures map through.
 *   - gated as a billing write: preview can re-pin an empty draft's tariff,
 *     so a disabled plugin (409) or unreadable plugin state (503) stops the
 *     request before the capability runs, and the scope is still disposed.
 *   - organization access (the composer's 401/403) is decided before the
 *     gate, so a caller without access never learns the plugin's state.
 *   - 404 when the gate resolves the period to a different organization (or
 *     none) than the one the scope was authorized for.
 *
 * The "no DB write" assertion is an integration concern owned by the
 * live-DB suite at `src/lib/supabase/__tests__/billing_audit_log.test.ts`
 * — here we only verify the route shape and dispatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type GateDecision =
  | { ok: true; organizationId: string | null }
  | { ok: false; status: 409 | 503; code: string; message: string };
let gateDecision: GateDecision = { ok: true, organizationId: null };
const checkGate = vi.fn(async (...args: unknown[]) => { void args; return gateDecision; });

vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  gateResponse: (decision: { status: number; code: string; message: string }) =>
    NextResponse.json({ error: decision.message, code: decision.code }, { status: decision.status }),
}));

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
const previewBills = vi.fn(async (input: {
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
});
const dispose = vi.fn(async () => {});

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
        billing: { previewBills: (...args: Parameters<typeof previewBills>) => previewBills(...args) },
        dispose: () => dispose(),
      },
    };
  }),
}));

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const HH_A = "660e8400-e29b-41d4-a716-446655442001";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_ORG_ID = "550e8400-e29b-41d4-a716-446655440999";

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
    gateDecision = { ok: true, organizationId: ORG_ID };
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
    expect(dispose).toHaveBeenCalledTimes(1);
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

  it("maps a composition failure; neither the gate nor the capability runs", async () => {
    composeResult = {
      ok: false,
      status: 500,
      code: "billing_composition_failed",
      message: "Could not compose billing.",
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("billing_composition_failed");
    expect(checkGate).not.toHaveBeenCalled();
    expect(lastCapabilityCall).toBeNull();
  });

  it("gates the preview as a billing write on the period", async () => {
    const { composeBilling } = await import("@/lib/billing/compose");
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);
    expect(checkGate).toHaveBeenCalledWith(expect.anything(), {
      plugin: "billing",
      target: { kind: "billingPeriod", id: PERIOD_ID },
      method: "POST",
    });
    expect(composeBilling).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, readOnly: true })
    );
  });

  it("authorizes the organization, then gates, then runs the capability", async () => {
    const { composeBilling } = await import("@/lib/billing/compose");
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);
    const composedAt = vi.mocked(composeBilling).mock.invocationCallOrder[0];
    const gatedAt = checkGate.mock.invocationCallOrder[0];
    const previewedAt = previewBills.mock.invocationCallOrder[0];
    expect(composedAt).toBeLessThan(gatedAt);
    expect(gatedAt).toBeLessThan(previewedAt);
  });

  it.each([
    [403, "billing_forbidden", 409, "billing_disabled"],
    [403, "billing_forbidden", 503, "billing_gate_unavailable"],
    [401, "billing_unauthenticated", 409, "billing_disabled"],
    [401, "billing_unauthenticated", 503, "billing_gate_unavailable"],
  ] as const)(
    "%i %s wins over the gate's %i %s: the plugin state stays hidden",
    async (status, code, gateStatus, gateCode) => {
      composeResult = { ok: false, status, code, message: "Not authorized." };
      gateDecision = { ok: false, status: gateStatus, code: gateCode, message: "gate" };
      const { POST } = await import("../route");
      const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
      expect(res.status).toBe(status);
      expect((await res.json()).code).toBe(code);
      expect(checkGate).not.toHaveBeenCalled();
      expect(lastCapabilityCall).toBeNull();
    }
  );

  it("409 billing_disabled from the gate; the capability never runs", async () => {
    gateDecision = {
      ok: false,
      status: 409,
      code: "billing_disabled",
      message: "Billing is disabled for this organization.",
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("billing_disabled");
    expect(previewBills).not.toHaveBeenCalled();
    expect(lastCapabilityCall).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("503 when plugin state cannot be read (fails closed)", async () => {
    gateDecision = {
      ok: false,
      status: 503,
      code: "billing_gate_unavailable",
      message: "Could not verify whether Billing is enabled. Retry the request.",
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("billing_gate_unavailable");
    expect(previewBills).not.toHaveBeenCalled();
    expect(lastCapabilityCall).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different organization", OTHER_ORG_ID],
    ["no organization", null],
  ])(
    "404 when the gate resolves the period to %s; the capability never runs",
    async (_label, organizationId) => {
      gateDecision = { ok: true, organizationId };
      const { POST } = await import("../route");
      const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("Billing period not found");
      expect(previewBills).not.toHaveBeenCalled();
      expect(lastCapabilityCall).toBeNull();
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  );

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
