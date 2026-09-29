/**
 * Generation wiring test (issue #5, review P1).
 *
 * The UI's generation and preview endpoints route through the billing
 * capability, whose generation delegate always sets
 * `requireEffectiveDatedAssignments: true`. This pins that contract: a
 * mid-period meter replacement without explicit reconciliation must surface
 * as `meter_assignment_continuity` instead of billing a partial-coverage
 * assignment for the whole period. The flag must never be switchable
 * per-call from the route layer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeBilling } from "../compose";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "770e8400-e29b-41d4-a716-446655440000";

let capturedParams: Record<string, unknown> | null = null;

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => [
    {
      user_id: "user-1",
      role: "org_manager",
      scope_type: "org",
      scope_id: ORG_ID,
    },
  ],
}));

vi.mock("@/lib/plugins/state", () => ({
  isBillingEnabled: async () => true,
}));

vi.mock("@/lib/billing/generate", () => ({
  isRunGenerationFatal: (out: { kind?: string }) =>
    Boolean(out && out.kind === "fatal"),
  runGenerationFor: vi.fn(async (params: Record<string, unknown>) => {
    capturedParams = params;
    return { results: [] };
  }),
}));

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: () => ({ provider: "openems-stub" }),
}));

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
          maybeSingle: async () => {
            if (table === "billing_periods") {
              return {
                data: { id: PERIOD_ID, microgrid_id: MG_ID },
                error: null,
              };
            }
            if (table === "microgrids") {
              return {
                data: { id: MG_ID, community_id: "comm-1" },
                error: null,
              };
            }
            if (table === "communities") {
              return { data: { id: "comm-1", org_id: ORG_ID }, error: null };
            }
            return { data: null, error: null };
          },
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  } as never;
}

describe("billing generation wiring (assignment-date enforcement)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedParams = null;
  });

  it("generateBills reaches the engine with effective-dated assignments required", async () => {
    const composed = await composeBilling({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    if (!composed.ok) throw new Error("expected composition");

    try {
      const result = await composed.data.billing.generateBills({
        billingPeriodId: PERIOD_ID,
      });
      expect(result).toMatchObject({ ok: true });
    } finally {
      await composed.data.dispose();
    }

    expect(capturedParams).toMatchObject({
      periodId: PERIOD_ID,
      mode: "write",
      requireEffectiveDatedAssignments: true,
    });
  });

  it("previewBills reaches the engine with effective-dated assignments required", async () => {
    const composed = await composeBilling({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    if (!composed.ok) throw new Error("expected composition");

    try {
      const result = await composed.data.billing.previewBills({
        billingPeriodId: PERIOD_ID,
      });
      expect(result).toMatchObject({ ok: true });
    } finally {
      await composed.data.dispose();
    }

    expect(capturedParams).toMatchObject({
      periodId: PERIOD_ID,
      mode: "preview",
      requireEffectiveDatedAssignments: true,
    });
  });
});
