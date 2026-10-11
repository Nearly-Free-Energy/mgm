/**
 * Reconciliation matrices for the Payments capability (pure helpers).
 *
 * Covers the plan's checkout / notification / correction acceptance:
 * - Checkout: reuse on repeated clicks, invalidation on amount change,
 *   confirmation-pending on timeout (capability-level, via status), block
 *   while needs_reconciliation.
 * - Notifications: duplicate/out-of-order idempotency is a persistence
 *   property (UNIQUE); here we cover forged identifiers, wrong
 *   amount/currency, and tracking binding.
 * - Corrections: revised draft bills flag verified-but-mismatched payments
 *   instead of settling; difference display; retry backoff.
 */
import { describe, expect, it } from "vitest";
import {
  canReuseAttempt,
  classifyVerification,
  isBlockedForNewCheckout,
  nextRetryDelaySeconds,
  receiptDifference,
  validateReceiptAgainstAttempt,
} from "../reconciliation";
import { mapPesapalStatus } from "../providers/pesapal/status-map";
import { snapshotToAttemptOutcome } from "../providers/types";

describe("checkout reuse", () => {
  it("reuses the active attempt on repeated clicks with an unchanged bill", () => {
    expect(
      canReuseAttempt(
        { amount: 4216800, currency: "UGX", bill_revision_total: 4216800, status: "pending" },
        { amount: 4216800, currency: "UGX" }
      )
    ).toBe(true);
  });

  it("invalidates reuse when a draft bill amount changes", () => {
    expect(
      canReuseAttempt(
        { amount: 4216800, currency: "UGX", bill_revision_total: 4216800, status: "pending" },
        { amount: 4300000, currency: "UGX" }
      )
    ).toBe(false);
  });

  it("never reuses attempts awaiting reconciliation", () => {
    expect(
      canReuseAttempt(
        { amount: 100, currency: "UGX", bill_revision_total: 100, status: "needs_reconciliation" },
        { amount: 100, currency: "UGX" }
      )
    ).toBe(false);
    expect(
      isBlockedForNewCheckout([
        { amount: 100, currency: "UGX", bill_revision_total: 100, status: "pending" },
        { amount: 100, currency: "UGX", bill_revision_total: 100, status: "needs_reconciliation" },
      ])
    ).toBe(true);
  });

  it("allows a revised full-bill checkout before money arrives", () => {
    expect(
      isBlockedForNewCheckout([
        { amount: 100, currency: "UGX", bill_revision_total: 90, status: "pending" },
      ])
    ).toBe(false);
  });
});

describe("provider status mapping", () => {
  it("maps Pesapal descriptions per verification requirements", () => {
    expect(mapPesapalStatus("COMPLETED")).toBe("completed");
    expect(mapPesapalStatus("FAILED")).toBe("failed");
    expect(mapPesapalStatus("REVERSED")).toBe("reversed");
    expect(mapPesapalStatus("PENDING")).toBe("pending");
    expect(mapPesapalStatus("INVALID")).toBe("unknown");
    expect(mapPesapalStatus(null)).toBe("unknown");
  });

  it("maps snapshots to bill outcomes; redirects alone never pay", () => {
    expect(snapshotToAttemptOutcome("completed")).toBe("paid");
    expect(snapshotToAttemptOutcome("failed")).toBe("failed");
    expect(snapshotToAttemptOutcome("reversed")).toBe("refunded");
    expect(snapshotToAttemptOutcome("pending")).toBeNull();
    expect(snapshotToAttemptOutcome("unknown")).toBeNull();
  });
});

describe("notification validation", () => {
  const attempt = {
    merchant_reference: "INV-ABC-123",
    provider_tracking_id: "TRACK-1",
    amount: 5000,
    currency: "UGX",
  };

  it("accepts a matching receipt", () => {
    expect(
      validateReceiptAgainstAttempt({
        attempt,
        notification: { merchantReference: "INV-ABC-123", trackingId: "TRACK-1" },
        verified: { amount: 5000, currency: "UGX" },
      })
    ).toEqual({ ok: true });
  });

  it("rejects forged merchant references", () => {
    expect(
      validateReceiptAgainstAttempt({
        attempt,
        notification: { merchantReference: "INV-FORGED-9", trackingId: "TRACK-1" },
        verified: { amount: 5000, currency: "UGX" },
      })
    ).toEqual({ ok: false, kind: "forged_reference" });
  });

  it("rejects tracking mismatches (stale replay bound to another attempt)", () => {
    expect(
      validateReceiptAgainstAttempt({
        attempt,
        notification: { merchantReference: "INV-ABC-123", trackingId: "TRACK-OTHER" },
        verified: { amount: 5000, currency: "UGX" },
      })
    ).toEqual({ ok: false, kind: "tracking_mismatch" });
  });

  it("rejects wrong amount and wrong currency", () => {
    expect(
      validateReceiptAgainstAttempt({
        attempt,
        notification: { merchantReference: "INV-ABC-123", trackingId: "TRACK-1" },
        verified: { amount: 4999, currency: "UGX" },
      })
    ).toEqual({ ok: false, kind: "amount_mismatch" });
    expect(
      validateReceiptAgainstAttempt({
        attempt,
        notification: { merchantReference: "INV-ABC-123", trackingId: "TRACK-1" },
        verified: { amount: 5000, currency: "KES" },
      })
    ).toEqual({ ok: false, kind: "currency_mismatch" });
  });
});

describe("draft bill corrections", () => {
  it("flags verified payments against an older revision for reconciliation", () => {
    expect(
      classifyVerification({
        attemptAmount: 5000,
        attemptCurrency: "UGX",
        verifiedAmount: 5000,
        verifiedCurrency: "UGX",
        billCurrentTotal: 5500,
      })
    ).toBe("bill_revised");
  });

  it("flags overpayment, shortfall (amount mismatch), and currency drift", () => {
    expect(
      classifyVerification({
        attemptAmount: 5000,
        attemptCurrency: "UGX",
        verifiedAmount: 6000,
        verifiedCurrency: "UGX",
        billCurrentTotal: 5000,
      })
    ).toBe("amount_mismatch");
    expect(
      classifyVerification({
        attemptAmount: 5000,
        attemptCurrency: "UGX",
        verifiedAmount: 5000,
        verifiedCurrency: "KES",
        billCurrentTotal: 5000,
      })
    ).toBe("currency_mismatch");
  });

  it("passes exact settlements and reports signed differences", () => {
    expect(
      classifyVerification({
        attemptAmount: 5000,
        attemptCurrency: "UGX",
        verifiedAmount: 5000,
        verifiedCurrency: "UGX",
        billCurrentTotal: 5000,
      })
    ).toBe("exact");
    expect(receiptDifference(5000, 5500)).toBe(-500);
    expect(receiptDifference(6000, 5000)).toBe(1000);
  });

  it("backs off retries; persistent failures surface for managers", () => {
    expect(nextRetryDelaySeconds(0)).toBe(60);
    expect(nextRetryDelaySeconds(1)).toBe(300);
    expect(nextRetryDelaySeconds(2)).toBe(900);
    expect(nextRetryDelaySeconds(3)).toBe(3600);
    expect(nextRetryDelaySeconds(9)).toBe(3600);
  });
});
