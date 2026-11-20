import { describe, expect, it } from "vitest";
import {
  CLOSE_ACKNOWLEDGEMENTS,
  CLOSE_REFUSAL_COPY,
  fractionalTotalsMessage,
  missingAcknowledgements,
  parseCloseReview,
  periodName,
  typedNameMatches,
} from "../close";

const ROW = {
  periodId: "770e8400-e29b-41d4-a716-446655440000",
  microgridId: "660e8400-e29b-41d4-a716-446655440000",
  status: "draft",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  currency: "UGX",
  billCount: 2,
  totalAmount: 4216800,
  usageKwh: 1840.5,
  unbilled: [{ tenantId: "t-1", tenantName: "House 1" }],
  unmetered: [],
  fractionalTotals: [],
  acknowledgements: ["totals_reviewed", "tenants_without_bills"],
  digest: "v1:abc",
};

describe("periodName", () => {
  it.each([
    ["2026-10-01", "2026-10-31", "October 2026"],
    ["2028-02-01", "2028-02-29", "February 2028"],
    ["2026-02-01", "2026-02-28", "February 2026"],
    ["2026-10-05", "2026-10-05", "5 October 2026"],
    ["2026-10-01", "2026-10-15", "1 to 15 October 2026"],
    ["2026-10-02", "2026-10-31", "2 to 31 October 2026"],
    ["2026-10-01", "2026-11-15", "1 October to 15 November 2026"],
    ["2026-10-01", "2026-11-30", "1 October to 30 November 2026"],
    ["2026-12-20", "2027-01-10", "20 December 2026 to 10 January 2027"],
  ])("names %s to %s %j", (start, end, name) => {
    expect(periodName(start, end)).toBe(name);
  });

  it.each([
    ["2026-10-31", "2026-10-01"],
    ["2026-02-30", "2026-03-01"],
    ["2026-1-01", "2026-10-31"],
    ["", ""],
  ])("refuses %j to %j", (start, end) => {
    expect(periodName(start, end)).toBeNull();
  });
});

describe("typedNameMatches", () => {
  it("ignores case, surrounding space and repeated spaces", () => {
    expect(typedNameMatches("october 2026", "October 2026")).toBe(true);
    expect(typedNameMatches("  OCTOBER\t 2026 ", "October 2026")).toBe(true);
    expect(typedNameMatches("1 to 15 october 2026", "1 to 15 October 2026")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(typedNameMatches(undefined, "October 2026")).toBe(false);
    expect(typedNameMatches("", "October 2026")).toBe(false);
    expect(typedNameMatches("October", "October 2026")).toBe(false);
    expect(typedNameMatches("Oct 2026", "October 2026")).toBe(false);
    expect(typedNameMatches("October 2026.", "October 2026")).toBe(false);
  });
});

describe("parseCloseReview", () => {
  it("adds the period's name and each acknowledgement's label", () => {
    const review = parseCloseReview(ROW);
    expect(review).toMatchObject({
      name: "October 2026",
      digest: "v1:abc",
      acknowledgements: [
        { id: "totals_reviewed", label: CLOSE_ACKNOWLEDGEMENTS.totals_reviewed },
        { id: "tenants_without_bills", label: CLOSE_ACKNOWLEDGEMENTS.tenants_without_bills },
      ],
    });
  });

  it.each([
    ["an acknowledgement with no label", { acknowledgements: ["totals_reviewed", "something_new"] }],
    ["no acknowledgements", { acknowledgements: [] }],
    ["no digest", { digest: "" }],
    ["an unknown status", { status: "open" }],
    ["an end before the start", { startDate: "2026-11-01" }],
    ["a total that is not a number", { totalAmount: "4216800" }],
  ])("refuses a review with %s", (_label, change) => {
    expect(parseCloseReview({ ...ROW, ...change })).toBeNull();
  });

  it("refuses something that is not a review", () => {
    expect(parseCloseReview(null)).toBeNull();
    expect(parseCloseReview([])).toBeNull();
  });
});

describe("missingAcknowledgements", () => {
  it("lists the required acknowledgements not ticked, in the review's order", () => {
    const review = parseCloseReview(ROW)!;
    expect(missingAcknowledgements(review, [])).toEqual(["totals_reviewed", "tenants_without_bills"]);
    expect(missingAcknowledgements(review, ["tenants_without_bills", "unrelated"])).toEqual(["totals_reviewed"]);
    expect(missingAcknowledgements(review, ["totals_reviewed", "tenants_without_bills"])).toEqual([]);
  });
});

describe("the close refusals' copy", () => {
  it("names the tenants whose totals are not whole numbers, or speaks of the bills when none is named", () => {
    const houses = (n: number) => Array.from({ length: n }, (_, i) => ({ tenantName: `House ${i + 1}` }));
    expect(fractionalTotalsMessage(houses(2))).toBe(
      "Regenerate the bills for House 1, House 2 before closing: their totals are not whole numbers."
    );
    // As the ceremony's warnings name them: the first five, then a count.
    expect(fractionalTotalsMessage(houses(7))).toBe(
      "Regenerate the bills for House 1, House 2, House 3, House 4, House 5 and 2 more before closing: their totals are not whole numbers."
    );
    expect(fractionalTotalsMessage([])).toBe("Regenerate the bills whose totals are not whole numbers before closing.");
  });

  it("is the route's copy for a closed period, an unreadable review and totals that changed", () => {
    expect(CLOSE_REFUSAL_COPY).toEqual({
      closed: "Billing period is already closed.",
      reviewUnavailable: "Could not load the period's totals. Retry before closing the period.",
      // The GUI host shows its old step again after a refusal, so not "confirm again".
      totalsChanged:
        "The period's totals changed after you reviewed them. Close this dialog and choose Close period again to review the new totals.",
    });
  });
});
