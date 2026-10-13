import { describe, expect, it, vi } from "vitest";

vi.mock("../review-seeds", () => ({
  resolveReviewOnlySeedReadings: vi.fn(async () => []),
}));

import { composeBillingReview } from "../billing-review";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("Cordis billing-review composition", () => {
  it("registers the fixture provider only when explicitly configured and disposes it", async () => {
    const composition = await composeBillingReview({
      supabase: {} as never,
      organizationId: ORG_ID,
      fixtureReadings: [],
    });

    // An empty target short-circuits generation before touching Supabase, but
    // still proves the same billing consumer resolves the fixture provider.
    await expect(
      composition.billingReview.preview({
        periodId: "period-1",
        householdIds: [],
        provider: "fixture",
      })
    ).resolves.toEqual({ results: [] });

    await composition.dispose();

    await expect(
      composition.billingReview.preview({
        periodId: "period-1",
        householdIds: [],
        provider: "fixture",
      })
    ).resolves.toEqual({
      kind: "fatal",
      status: 503,
      body: { error: "Metering provider is not available", code: "METERING_CONFIGURATION" },
    });
  });

  it("does not silently fall back when a requested provider is absent", async () => {
    const composition = await composeBillingReview({ supabase: {} as never, organizationId: ORG_ID });
    try {
      await expect(
        composition.billingReview.preview({
          periodId: "period-1",
          householdIds: [],
          provider: "fixture",
        })
      ).resolves.toEqual({
        kind: "fatal",
        status: 503,
        body: { error: "Metering provider is not available", code: "METERING_CONFIGURATION" },
      });
    } finally {
      await composition.dispose();
    }
  });
});
