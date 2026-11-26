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
/** A rewritten bill that had a pending payment link, its total going from `from` to `to`. */
const linked = (from: number, to: number | string, status = "link_generated"): TenantResult =>
  ({
    kind: "written",
    tenantId: id(),
    tenantName: "Unit",
    lineItem: { total_amount: to },
    previousTotalAmount: from,
    previousPaymentStatus: status,
    previousReadingSource: "edge",
  }) as unknown as TenantResult;
const unchanged = (): TenantResult => ({ kind: "unchanged", tenantId: id(), tenantName: "Unit", lineItemId: "b", totalAmount: 1 });
const kept = (): TenantResult => ({ kind: "kept", tenantId: id(), tenantName: "Unit", readingSource: "manual" });
const error = (code: GenerationErrorCode, text = "x"): TenantResult => ({ kind: "error", tenantId: id(), tenantName: "Unit", code, error: text });
/** A guarded run's error for a tenant that had a bill, which is left as it was. */
const hadBill = (code: GenerationErrorCode): TenantResult => ({ kind: "error", tenantId: id(), tenantName: "Unit", code, error: "x", hadBill: true });
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
        error("bill_exists"),
        error("period_not_found"),
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
      changed: 4,
      notBilled: { noMeter: 1, meterAssignment: 1, noReading: 1, failed: 2 },
    });
    expect(notBilledCount(s)).toBe(5);
    expect(s.tenants.map((t) => t.outcome)).toEqual([
      ...Array(3).fill("generated"),
      ...Array(2).fill("unchanged"),
      "kept",
      ...Array(7).fill("left"),
      ...Array(5).fill("not_billed"),
    ]);
    expect(s.message).toBe(
      "Generated 3 bills from meter data; 2 already up to date. Not billed: 1 with no meter, 1 with a meter assignment gap, 1 with no meter data, 2 not saved. Left as they were: 1 entered by hand, 3 paid, invoiced or refunded, 4 changed meanwhile.",
    );
  });

  it("counts a tenant whose bill the run did not read as left, not as not billed", () => {
    const s = summarizeGenerateFromMeters(
      [hadBill("unmetered_no_manual"), hadBill("meter_assignment_continuity"), hadBill("no_meter_reading"), hadBill("line_item_write_failed"), hadBill("paid")],
      fmt,
    );
    expect(s).toMatchObject({ notRefreshed: 4, left: 1, notBilled: { noMeter: 0, meterAssignment: 0, noReading: 0, failed: 0 } });
    expect(notBilledCount(s)).toBe(0);
    expect(s.tenants.map((t) => [t.outcome, t.code])).toEqual([
      ["left", "unmetered_no_manual"],
      ["left", "meter_assignment_continuity"],
      ["left", "no_meter_reading"],
      ["left", "line_item_write_failed"],
      ["left", "paid"],
    ]);
    expect(s.message).toBe("No bill was generated. Left as they were: 1 paid, invoiced or refunded, 4 not refreshed.");
  });

  it("passes on each tenant's code, never its error text", () => {
    const s = summarizeGenerateFromMeters([error("line_item_write_failed", "Failed to write line item: permission denied for table secret")], fmt);
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(s.tenants).toEqual([{ tenantId: expect.any(String), tenantName: "Unit", outcome: "not_billed", code: "line_item_write_failed" }]);
  });

  it.each([
    [[written()], "Generated 1 bill from meter data."],
    [[written(), unchanged()], "Generated 1 bill from meter data; 1 already up to date."],
    [[unchanged(), unchanged()], "Nothing changed: every bill already has the latest meter figures."],
    [[unchanged(), kept()], "Nothing changed: 1 bill already has the latest meter figures. Left as they were: 1 entered by hand."],
    [[kept(), error("paid")], "No bill was generated. Left as they were: 1 entered by hand, 1 paid, invoiced or refunded."],
    [[error("unmetered_no_manual"), error("unmetered_no_manual")], "No bill was generated. Not billed: 2 with no meter."],
    [[unchanged(), hadBill("unmetered_no_manual")], "Nothing changed: 1 bill already has the latest meter figures. Left as they were: 1 not refreshed."],
  ])("says %j as %j", (results, message) => {
    expect(summarizeGenerateFromMeters(results, fmt).message).toBe(message);
  });

  it("formats counts in the request's locale", () => {
    expect(summarizeGenerateFromMeters(times(1200, written), createFmt({ locale: "en" })).message).toBe("Generated 1,200 bills from meter data.");
    expect(summarizeGenerateFromMeters(times(1200, written), createFmt({ locale: "de" })).message).toBe("Generated 1.200 bills from meter data.");
  });

  it("counts the bills whose pending payment link stopped working, as their total changed", () => {
    const s = summarizeGenerateFromMeters(
      [
        linked(3000, "4200"),
        linked(3000, 4200),
        // The same total, as the database rounds it: the link is kept.
        linked(4200, "4200.000"),
        // No pending link to stop.
        linked(3000, 4200, "unpaid"),
        written(),
      ],
      fmt,
    );
    expect(s).toMatchObject({ generated: 5, paymentLinksCleared: 2 });
    expect(s.message).toBe("Generated 5 bills from meter data. 2 payment links stopped working, as their bills' totals changed.");
    expect(summarizeGenerateFromMeters([linked(3000, 4200), unchanged()], fmt).message).toBe(
      "Generated 1 bill from meter data; 1 already up to date. 1 payment link stopped working, as its bill's total changed.",
    );
  });

  it("says the not-billed and left counts as totals when the full message would pass 300 characters", () => {
    const codes: GenerationErrorCode[] = ["paid", "bill_changed", "unmetered_no_manual", "meter_assignment_continuity", "no_meter_reading", "tariff_changed"];
    const results = [
      ...times(1000, () => linked(3000, 4200)),
      ...times(1000, unchanged),
      ...times(1000, kept),
      ...codes.flatMap((c) => times(1000, () => error(c))),
      ...times(1000, () => hadBill("no_meter_reading")),
    ];
    const s = summarizeGenerateFromMeters(results, fmt);
    // The counts are all still there; only the message is shorter.
    expect(s).toMatchObject({ generated: 1000, paymentLinksCleared: 1000, left: 1000, changed: 1000, notRefreshed: 1000 });
    expect(s.message).toBe(
      "Generated 1,000 bills from meter data; 1,000 already up to date. 1,000 payment links stopped working, as their bills' totals changed. Not billed: 4,000. Left as they were: 4,000.",
    );
    expect(s.message.length).toBeLessThanOrEqual(300);
    // Far past any microgrid, still within it.
    const huge = summarizeGenerateFromMeters(results, { ...fmt, number: () => ({ t: "number", v: 0, text: "999,999,999" }) } as typeof fmt);
    expect(huge.message.length).toBeLessThanOrEqual(300);
  });

  it("stays within the host's 300 characters with every clause at a thousand tenants", () => {
    const codes: GenerationErrorCode[] = ["paid", "bill_changed", "unmetered_no_manual", "meter_assignment_continuity", "no_meter_reading", "tariff_changed"];
    const results = [
      ...times(1000, written),
      ...times(1000, unchanged),
      ...times(1000, kept),
      ...codes.flatMap((c) => times(1000, () => error(c))),
      ...times(1000, () => hadBill("no_meter_reading")),
    ];
    const { message } = summarizeGenerateFromMeters(results, fmt);
    expect(message).toContain("1,000 changed meanwhile, 1,000 not refreshed");
    expect(message.length).toBeLessThanOrEqual(300);
  });
});
