import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const preview = vi.fn();
const dispose = vi.fn();

vi.mock("@/lib/cordis/billing-review", () => ({
  composeBillingReview: vi.fn(async () => ({ billingReview: { preview }, dispose })),
  isRunGenerationFatal: (value: { kind?: string }) => value.kind === "fatal",
}));

const maybeSingle = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "reviewer@test.local" } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
    }),
  })),
}));

const PERIOD_ID = "550e8400-e29b-41d4-a716-446655440100";
const HOUSEHOLD_ID = "550e8400-e29b-41d4-a716-446655440200";

describe("POST /api/billing-review/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingle.mockResolvedValue({
      data: {
        id: PERIOD_ID,
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        timezone: "Africa/Kampala",
      },
      error: null,
    });
    preview.mockResolvedValue({
      results: [
        {
          kind: "preview",
          householdId: HOUSEHOLD_ID,
          householdName: "Source name must not be returned",
          usageKwh: 25,
          totalAmount: 5000,
          previousUsageKwh: null,
          previousTotalAmount: null,
        },
      ],
    });
  });

  it("uses the server-selected OpenEMS provider, exposes no source name, and disposes the context", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("http://localhost/api/billing-review/preview", {
        method: "POST",
        body: JSON.stringify({ periodId: PERIOD_ID, householdIds: [HOUSEHOLD_ID] }),
      })
    );

    expect(response.status).toBe(200);
    expect(preview).toHaveBeenCalledWith({
      periodId: PERIOD_ID,
      householdIds: [HOUSEHOLD_ID],
      provider: "openems",
    });
    expect(dispose).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      rows: [
        {
          householdId: HOUSEHOLD_ID,
          label: "Household 550e8400",
          status: "excluded",
          exceptions: [{ code: "missing_saved_bill" }],
        },
      ],
    });
  });
});
