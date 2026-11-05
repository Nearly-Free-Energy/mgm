import { describe, expect, it } from "vitest";
import {
  PERIOD_KEPT_CLOSED_MESSAGE,
  PERIOD_KEPT_MESSAGE,
  PERIOD_KEPT_PAYMENTS_MESSAGE,
  isPeriodKeptError,
  lineItemHasRecordedPayment,
  periodDeleteErrorMessage,
} from "../period-delete";

describe("periodDeleteErrorMessage", () => {
  it("explains a closed period", () => {
    expect(
      periodDeleteErrorMessage({
        code: "23514",
        message: "billing_period_kept: a closed billing period cannot be deleted",
        details: "closed",
      }),
    ).toBe(PERIOD_KEPT_CLOSED_MESSAGE);
  });

  it("explains a period with recorded payments", () => {
    expect(
      periodDeleteErrorMessage({
        code: "23514",
        message: "billing_period_kept: a billing period with recorded payments cannot be deleted",
        details: "payment_activity",
      }),
    ).toBe(PERIOD_KEPT_PAYMENTS_MESSAGE);
  });

  it("says the period is kept, without naming a reason, for a DETAIL it does not know", () => {
    for (const details of ["truncate", "", null, undefined]) {
      expect(
        periodDeleteErrorMessage({
          code: "23514",
          message: "billing_period_kept: kept for a reason added later",
          details,
        }),
      ).toBe(PERIOD_KEPT_MESSAGE);
    }
  });

  it("passes any other error through unchanged", () => {
    expect(
      periodDeleteErrorMessage({ code: "23514", message: "some other check failed" }),
    ).toBe("some other check failed");
    expect(periodDeleteErrorMessage({ code: "42501", message: "permission denied" })).toBe(
      "permission denied",
    );
  });

  it("falls back to a generic message when the error has none", () => {
    expect(periodDeleteErrorMessage({})).toBe("Could not delete the period.");
  });
});

describe("isPeriodKeptError", () => {
  it("needs both the SQLSTATE and the message prefix", () => {
    expect(isPeriodKeptError({ code: "23514", message: "billing_period_kept: x" })).toBe(true);
    expect(isPeriodKeptError({ code: "P0001", message: "billing_period_kept: x" })).toBe(false);
    expect(isPeriodKeptError({ code: "23514", message: "check failed" })).toBe(false);
  });
});

describe("lineItemHasRecordedPayment", () => {
  it("is false for an unpaid line item without paid_at", () => {
    expect(lineItemHasRecordedPayment({ payment_status: "unpaid", paid_at: null })).toBe(false);
  });

  it("is true for any payment_status other than unpaid", () => {
    expect(lineItemHasRecordedPayment({ payment_status: "paid", paid_at: null })).toBe(true);
    expect(lineItemHasRecordedPayment({ payment_status: "pending", paid_at: null })).toBe(true);
  });

  it("is true when paid_at is set on an unpaid line item", () => {
    expect(
      lineItemHasRecordedPayment({ payment_status: "unpaid", paid_at: "2026-03-20T10:00:00Z" }),
    ).toBe(true);
  });
});
