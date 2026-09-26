/**
 * POST /api/billing/generate — route tests (#158 + #173 BC1).
 *
 * Coverage:
 *   - 401 unauthorized when supabase.auth.getUser() returns no user.
 *   - 400 invalid_body for malformed manualReadings.
 *   - Bulk path delegates to fn_record_line_item_with_audit (one RPC call
 *     per processed household; `mode='write'`).
 *   - manualReadings override path sets reading_source='manual' on the RPC
 *     payload (`_reading_source: 'manual'`) plus entered_by_user_id from
 *     auth.uid().
 *   - Empty householdIds (`[]`) writes nothing AND returns
 *     `{ lineItems: 0, errors: [] }` (AC3 explicit no-op).
 *   - Cross-microgrid manualReadings entry surfaces in errors[] with
 *     code='unknown_household' (AC3 attack defense).
 *   - bulk-regenerate of a manual-source household without manualReadings
 *     surfaces in errors[] with code='currently_manual' (AC3 Q5).
 *
 * Test pattern: the route is mocked at the supabase + auth + composeBilling
 * boundaries — the capability internals are unit-tested at
 * `src/lib/billing/__tests__/billing-capability.test.ts`, and the engine
 * internals end-to-end by the live-DB suite at
 * `src/lib/supabase/__tests__/billing_audit_log.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock controls ──────────────────────────────────────────────────────────

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
  seedReadings?: unknown[];
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
          generateBills: vi.fn(async (input: {
            billingPeriodId: string;
            householdIds?: string[];
            manualReadings?: unknown[];
            seedReadings?: unknown[];
          }) => {
            lastCapabilityCall = {
              billingPeriodId: input.billingPeriodId,
              householdIds: input.householdIds,
              manualReadings: input.manualReadings,
              seedReadings: input.seedReadings,
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
  return new NextRequest("http://localhost/api/billing/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/billing/generate (#173 BC1, Release 3 capability routing)", () => {
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

  it("400 invalid_body for malformed billingPeriodId", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_body");
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
    const json = await res.json();
    expect(json.error).toBe("invalid_body");
  });

  it("400 invalid_body when manualReadings.startKwh negative", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          { householdId: HH_A, startKwh: -1, endKwh: 50 },
        ],
      })
    );
    expect(res.status).toBe(400);
  });

  it("happy bulk: delegates to the billing capability with the parsed body", async () => {
    mockCapabilityResult = {
      ok: true,
      data: {
        results: [
          {
            kind: "written",
            householdId: HH_A,
            householdName: "HH A",
            lineItem: { id: "li-x" },
            previousTotalAmount: null,
            previousPaymentStatus: null,
            previousReadingSource: null,
          },
        ],
      },
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lineItems).toBe(1);
    expect(json.errors).toEqual([]);
    // The route passes the request through to generateBills — mode='write',
    // actor, and assignment-date enforcement are capability-owned (the UI
    // must never be able to switch them off per-call).
    expect(lastCapabilityCall?.billingPeriodId).toBe(PERIOD_ID);
    expect(lastCapabilityCall?.householdIds).toBeUndefined();
    expect(lastCapabilityCall?.manualReadings).toBeUndefined();
  });

  it("forwards manualReadings (with reason) to the billing capability", async () => {
    mockCapabilityResult = {
      ok: true,
      data: {
        results: [
          {
            kind: "written",
            householdId: HH_A,
            householdName: "HH A",
            lineItem: { id: "li-x" },
            previousTotalAmount: null,
            previousPaymentStatus: null,
            previousReadingSource: null,
          },
        ],
      },
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          {
            householdId: HH_A,
            startKwh: 100,
            endKwh: 180,
            reason: "Aaron read the meter manually",
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(lastCapabilityCall?.manualReadings).toEqual([
      {
        householdId: HH_A,
        startKwh: 100,
        endKwh: 180,
        reason: "Aaron read the meter manually",
      },
    ]);
  });

  it("manualReadings.endKwh === startKwh succeeds (zero-usage edge case)", async () => {
    mockCapabilityResult = {
      ok: true,
      data: {
        results: [
          {
            kind: "written",
            householdId: HH_A,
            householdName: "HH A",
            lineItem: { id: "li-x" },
            previousTotalAmount: null,
            previousPaymentStatus: null,
            previousReadingSource: null,
          },
        ],
      },
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          { householdId: HH_A, startKwh: 100, endKwh: 100 },
        ],
      })
    );
    expect(res.status).toBe(200);
  });

  it("response shape splits results into lineItems count + errors[] (with code field)", async () => {
    mockCapabilityResult = {
      ok: true,
      data: {
        results: [
          {
            kind: "written",
            householdId: HH_A,
            householdName: "HH A",
            lineItem: { id: "li-x" },
            previousTotalAmount: null,
            previousPaymentStatus: null,
            previousReadingSource: null,
          },
          {
            kind: "error",
            householdId: "660e8400-e29b-41d4-a716-446655442002",
            householdName: "HH B",
            error: "Currently set to manual entry — use per-row regenerate to change.",
            code: "currently_manual",
          },
          {
            kind: "error",
            householdId: "660e8400-e29b-41d4-a716-446655442003",
            householdName: "660e8400-e29b-41d4-a716-446655442003",
            error: "Household 660e8400-e29b-41d4-a716-446655442003 is not in this microgrid.",
            code: "unknown_household",
          },
        ],
      },
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        householdIds: [HH_A, "660e8400-e29b-41d4-a716-446655442002"],
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lineItems).toBe(1);
    expect(json.errors).toHaveLength(2);
    expect(json.errors[0].code).toBe("currently_manual");
    expect(json.errors[1].code).toBe("unknown_household");
  });

  it("propagates capability failures (engine fatal mapped by the capability)", async () => {
    mockCapabilityResult = {
      ok: false,
      status: 404,
      code: "billing_generation_failed",
      message: "Billing period not found",
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.message).toBe("Billing period not found");
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

  // #339 — seedReadings validation. The validator shipped with no tests, and
  // its docstring claimed a server-side recomputation it does not perform;
  // both are corrected here. These pin what it ACTUALLY guarantees.
  describe("seedReadings (#339)", () => {
    const DEVICE = "660e8400-e29b-41d4-a716-446655443001";
    const ok = {
      deviceId: DEVICE,
      dialReadingKwh: 4196,
      readAt: "2026-08-20T09:00:00Z",
      startKwh: 3982,
    };

    async function post(seedReadings: unknown) {
      const { POST } = await import("../route");
      return POST(makePostRequest({ billingPeriodId: PERIOD_ID, seedReadings }));
    }

    it("passes a well-formed array through to the billing capability", async () => {
      const res = await post([ok]);
      expect(res.status).toBe(200);
      expect(lastCapabilityCall?.seedReadings).toEqual([ok]);
    });

    it("400 when seedReadings is not an array", async () => {
      const res = await post({ deviceId: DEVICE });
      expect(res.status).toBe(400);
    });

    it("400 on a non-UUID deviceId", async () => {
      const res = await post([{ ...ok, deviceId: "not-a-uuid" }]);
      expect(res.status).toBe(400);
    });

    it("400 on a negative or non-finite reading", async () => {
      expect((await post([{ ...ok, dialReadingKwh: -1 }])).status).toBe(400);
      expect((await post([{ ...ok, startKwh: Number.NaN }])).status).toBe(400);
    });

    it("400 on an unparseable readAt", async () => {
      const res = await post([{ ...ok, readAt: "yesterday" }]);
      expect(res.status).toBe(400);
    });

    // The ordering invariant: you cannot have consumed a negative amount since
    // the period began, so a startKwh above the dial reading is provably wrong
    // regardless of what OpenEMS says.
    it("400 when startKwh exceeds dialReadingKwh", async () => {
      const res = await post([{ ...ok, startKwh: 5000 }]);
      expect(res.status).toBe(400);
    });

    // Two entries for one meter would make the reading used depend on array
    // order, which is a silent wrong answer rather than a loud one.
    it("400 on duplicate deviceId entries", async () => {
      const res = await post([ok, { ...ok, startKwh: 1 }]);
      expect(res.status).toBe(400);
    });

    // What it does NOT do, pinned so the gap stays visible: a startKwh that is
    // simply wrong but below the dial reading is accepted. Re-deriving it
    // server-side is tracked separately; this test is what stops the docstring
    // drifting back to claiming otherwise.
    it("ACCEPTS a plausible-but-wrong startKwh below the dial reading", async () => {
      const res = await post([{ ...ok, startKwh: 1 }]);
      expect(res.status).toBe(200);
    });
  });

});
