import { describe, expect, it, vi } from "vitest";

vi.mock("../review-seeds", () => ({
  resolveReviewOnlySeedReadings: vi.fn(async () => []),
}));

import { composeBillingReview } from "../billing-review";

describe("Cordis billing-review composition", () => {
  it("registers the fixture provider only when explicitly configured and disposes it", async () => {
    const composition = await composeBillingReview({
      supabase: {} as never,
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
    const composition = await composeBillingReview({ supabase: {} as never });
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
