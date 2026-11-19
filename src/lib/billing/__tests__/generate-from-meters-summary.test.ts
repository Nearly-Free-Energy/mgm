/**
 * What POST /api/billing-periods/[periodId]/generate-from-meters answers
 * about a run: counts by outcome, each tenant's outcome and code (never its
 * error text), and a message in fixed copy within the GUI host's 300
 * characters.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { GenerationErrorCode, TenantResult } from "../generate";
import { notBilledCount, summarizeGenerateFromMeters } from "../generate-from-meters-summary";

const fmt = createFmt({ locale: "en" });
let next = 0;
const id = () => `t-${++next}`;
const written = (): TenantResult =>
  ({ kind: "written", tenantId: id(), tenantName: "Unit", lineItem: {}, previousTotalAmount: null, previousPaymentStatus: null, previousReadingSource: null }) as unknown as TenantResult;
const unchanged = (): TenantResult => ({ kind: "unchanged", tenantId: id(), tenantName: "Unit", lineItemId: "b", totalAmount: 1 });
const kept = (): TenantResult => ({ kind: "kept", tenantId: id(), tenantName: "Unit", readingSource: "manual" });
const error = (code: GenerationErrorCode, text = "x"): TenantResult => ({ kind: "error", tenantId: id(), tenantName: "Unit", code, error: text });
const times = (n: number, f: () => TenantResult) => Array.from({ length: n }, f);

describe("summarizeGenerateFromMeters", () => {
  it("counts each outcome, and puts each error code in its place", () => {
    const s = summarizeGenerateFromMeters(
      [
        ...times(3, written),
        ...times(2, unchanged),
        kept(),
        error("paid"),
        error("invoiced"),
        error("refunded"),
        error("bill_changed"),
        error("period_closed"),
        error("unmetered_no_manual"),
        error("meter_assignment_continuity"),
        error("no_meter_reading"),
        error("line_item_write_failed"),
        error("tariff_changed"),
      ],
      fmt,
    );
    expect(s).toMatchObject({
      generated: 3,
      unchanged: 2,
      kept: 1,
      left: 3,
      changed: 2,
      notBilled: { noMeter: 1, meterAssignment: 1, noReading: 1, failed: 2 },
    });
    expect(notBilledCount(s)).toBe(5);
    expect(s.tenants.map((t) => t.outcome)).toEqual([
      ...Array(3).fill("generated"),
      ...Array(2).fill("unchanged"),
      "kept",
      ...Array(5).fill("left"),
      ...Array(5).fill("not_billed"),
    ]);
    expect(s.message).toBe(
      "Generated 3 bills from meter data; 2 were already up to date. Not billed from meters: 1 with no meter, 1 with a meter assignment gap, 1 with no meter data, 2 not saved. Left as they were: 1 entered by hand, 3 paid, invoiced or refunded, 2 changed meanwhile.",
    );
  });

  it("passes on each tenant's code, never its error text", () => {
    const s = summarizeGenerateFromMeters([error("line_item_write_failed", "Failed to write line item: permission denied for table secret")], fmt);
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(s.tenants).toEqual([{ tenantId: expect.any(String), tenantName: "Unit", outcome: "not_billed", code: "line_item_write_failed" }]);
  });

  it.each([
    [[written()], "Generated 1 bill from meter data."],
    [[written(), unchanged()], "Generated 1 bill from meter data; 1 was already up to date."],
    [[unchanged(), unchanged()], "Nothing changed: every bill already has the latest meter figures."],
    [[unchanged(), kept()], "Nothing changed: 1 bill already has the latest meter figures. Left as they were: 1 entered by hand."],
    [[kept(), error("paid")], "No bill was generated. Left as they were: 1 entered by hand, 1 paid, invoiced or refunded."],
    [[error("unmetered_no_manual"), error("unmetered_no_manual")], "No bill was generated. Not billed from meters: 2 with no meter."],
  ])("says %j as %j", (results, message) => {
    expect(summarizeGenerateFromMeters(results, fmt).message).toBe(message);
  });

  it("formats counts in the request's locale", () => {
    expect(summarizeGenerateFromMeters(times(1200, written), createFmt({ locale: "en" })).message).toBe("Generated 1,200 bills from meter data.");
    expect(summarizeGenerateFromMeters(times(1200, written), createFmt({ locale: "de" })).message).toBe("Generated 1.200 bills from meter data.");
  });

  it("stays within the host's 300 characters with every clause at a thousand tenants", () => {
    const codes: GenerationErrorCode[] = ["paid", "bill_changed", "unmetered_no_manual", "meter_assignment_continuity", "no_meter_reading", "tariff_changed"];
    const results = [...times(1000, written), ...times(1000, unchanged), ...times(1000, kept), ...codes.flatMap((c) => times(1000, () => error(c)))];
    const { message } = summarizeGenerateFromMeters(results, fmt);
    expect(message).toContain("1,000 changed meanwhile");
    expect(message.length).toBeLessThanOrEqual(300);
  });
});
