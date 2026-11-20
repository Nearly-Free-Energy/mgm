/**
 * What POST /api/billing-periods/[periodId]/generate-from-meters answers
 * about a run (BillingCapability.generateFromMeters): each tenant's outcome,
 * the counts, and one message in fixed copy built from the counts.
 *
 * Pure. It never passes on a tenant's `error` text, which can hold a
 * database's message ("Failed to write line item: …"); it passes on only
 * the code. The message stays within the 300 characters the GUI host keeps
 * of an action's result (invoke.ts): every clause is a count and a fixed
 * phrase, and when the full message would be longer (every clause present
 * at a thousand tenants each is), it says the not-billed and left counts
 * as totals instead (the summary test checks both). If a phrase grows, or
 * the short form gains a sentence, test the longest.
 */
import type { Fmt } from "@/lib/gui/surface";
import type { GenerationErrorCode, TenantResult } from "./generate";
import { roundAmount } from "./precision";

/**
 * A tenant's outcome. "left" is any bill the run left as it was: the ones
 * counted in `left` (paid, invoiced, refunded) and also those counted in
 * `changed` and `notRefreshed`, so the tenants marked "left" outnumber the
 * `left` count whenever those two are not zero.
 */
export type GenerateFromMetersOutcome = "generated" | "unchanged" | "kept" | "left" | "not_billed";

export type GenerateFromMetersCounts = {
  /** Written: a first bill, or an existing one with new figures. */
  generated: number;
  /**
   * Of `generated`, bills that had a pending payment link (link_generated)
   * and a new total: fn_record_line_item_with_audit clears the link when a
   * bill's total changes, so it stops working. Known from the engine's
   * result (the payment status and total it read, and the total written).
   */
  paymentLinksCleared: number;
  /** Read from the meter, with the figures the bill already had: nothing written. */
  unchanged: number;
  /** Manual bills, kept as they are. */
  kept: number;
  /**
   * Invoiced, paid or refunded bills, left as they are: as the run read
   * them, or invoiced before its write (that write's refusal counts here
   * too, see ERROR_BUCKET). A tenant's `outcome` "left" is wider: it also
   * covers `changed` and `notRefreshed`, whose bills are left as they were
   * as well.
   */
  left: number;
  /** Bills that changed, or a period that closed, while the run wrote. */
  changed: number;
  /**
   * Tenants with a bill the run could not read from a meter (no meter, an
   * assignment gap, no data) or not save: the bill they had is left as it
   * was (ErrorTenantResult.hadBill), so they are not counted as not billed.
   */
  notRefreshed: number;
  /** Tenants with no bill that the run did not bill, by why. */
  notBilled: { noMeter: number; meterAssignment: number; noReading: number; failed: number };
};

export type GenerateFromMetersSummary = GenerateFromMetersCounts & {
  tenants: { tenantId: string; tenantName: string; outcome: GenerateFromMetersOutcome; code?: GenerationErrorCode }[];
  message: string;
};

type NotBilled = keyof GenerateFromMetersCounts["notBilled"];

/** Where each error code of a run counts. Codes not listed count as `failed`. */
const ERROR_BUCKET: Partial<Record<GenerationErrorCode, "left" | "changed" | NotBilled>> = {
  // `invoiced` is both the run's own choice (a bill it read with an invoice
  // number) and fn_regenerate_bill_with_audit's refusal of a bill invoiced
  // after the read: either way the bill now has an invoice number and a
  // second run would leave it too, so both count as left. bill_changed and
  // period_closed are refusals of a bill or period that changed in some
  // other way, which a second run may well refresh, so they count apart.
  invoiced: "left",
  paid: "left",
  refunded: "left",
  // fn_regenerate_bill_with_audit's refusals of a bill that changed after it was read.
  bill_changed: "changed",
  period_closed: "changed",
  unmetered_no_manual: "noMeter",
  meter_assignment_continuity: "meterAssignment",
  no_meter_reading: "noReading",
};

const plural = (fmt: Fmt, n: number, one: string, many: string) => `${fmt.number(n).text} ${n === 1 ? one : many}`;

export function summarizeGenerateFromMeters(results: readonly TenantResult[], fmt: Fmt): GenerateFromMetersSummary {
  const counts: GenerateFromMetersCounts = {
    generated: 0,
    paymentLinksCleared: 0,
    unchanged: 0,
    kept: 0,
    left: 0,
    changed: 0,
    notRefreshed: 0,
    notBilled: { noMeter: 0, meterAssignment: 0, noReading: 0, failed: 0 },
  };
  const tenants: GenerateFromMetersSummary["tenants"] = [];
  for (const r of results) {
    switch (r.kind) {
      case "written":
        counts.generated++;
        if (linkCleared(r)) counts.paymentLinksCleared++;
        tenants.push({ tenantId: r.tenantId, tenantName: r.tenantName, outcome: "generated" });
        break;
      case "unchanged":
        counts.unchanged++;
        tenants.push({ tenantId: r.tenantId, tenantName: r.tenantName, outcome: "unchanged" });
        break;
      case "kept":
        counts.kept++;
        tenants.push({ tenantId: r.tenantId, tenantName: r.tenantName, outcome: "kept" });
        break;
      case "error": {
        const bucket = ERROR_BUCKET[r.code] ?? "failed";
        if (bucket === "left" || bucket === "changed") counts[bucket]++;
        else if (r.hadBill) counts.notRefreshed++;
        else counts.notBilled[bucket]++;
        const outcome = bucket === "left" || bucket === "changed" || r.hadBill ? "left" : "not_billed";
        tenants.push({ tenantId: r.tenantId, tenantName: r.tenantName, outcome, code: r.code });
        break;
      }
      // A preview never reaches a write's summary.
      case "preview":
        break;
    }
  }
  return { ...counts, tenants, message: messageFor(counts, fmt) };
}

/**
 * Whether a written bill had a pending payment link and now has another
 * total: compared as fn_record_line_item_with_audit compares them, rounded
 * to whole units (previousTotalAmount already is).
 */
function linkCleared(r: Extract<TenantResult, { kind: "written" }>): boolean {
  return (
    r.previousPaymentStatus === "link_generated" &&
    r.previousTotalAmount !== null &&
    roundAmount(Number(r.lineItem.total_amount)) !== r.previousTotalAmount
  );
}

/** The number of tenants with no bill that a run did not bill from meter data. */
export const notBilledCount = (c: GenerateFromMetersCounts) =>
  c.notBilled.noMeter + c.notBilled.meterAssignment + c.notBilled.noReading + c.notBilled.failed;

/** The most the GUI host keeps of an action's result message (invoke.ts). */
const MESSAGE_LIMIT = 300;

function messageFor(c: GenerateFromMetersCounts, fmt: Fmt): string {
  const full = sentencesFor(c, fmt, false).join(" ");
  return full.length <= MESSAGE_LIMIT ? full : sentencesFor(c, fmt, true).join(" ");
}

/** The message's sentences; `short` says the not-billed and left counts as totals. */
function sentencesFor(c: GenerateFromMetersCounts, fmt: Fmt, short: boolean): string[] {
  const n = (v: number) => fmt.number(v).text;
  const sentences: string[] = [];
  const others = notBilledCount(c) + c.kept + c.left + c.changed + c.notRefreshed;
  if (c.generated > 0) {
    sentences.push(
      `Generated ${plural(fmt, c.generated, "bill", "bills")} from meter data` +
        (c.unchanged > 0 ? `; ${n(c.unchanged)} already up to date.` : "."),
    );
  } else if (c.unchanged > 0) {
    sentences.push(
      others === 0
        ? "Nothing changed: every bill already has the latest meter figures."
        : `Nothing changed: ${plural(fmt, c.unchanged, "bill already has", "bills already have")} the latest meter figures.`,
    );
  } else {
    sentences.push("No bill was generated.");
  }
  if (c.paymentLinksCleared > 0) {
    sentences.push(
      c.paymentLinksCleared === 1
        ? `${n(1)} payment link stopped working, as its bill's total changed.`
        : `${n(c.paymentLinksCleared)} payment links stopped working, as their bills' totals changed.`,
    );
  }
  const notBilled = [
    [c.notBilled.noMeter, "with no meter"],
    [c.notBilled.meterAssignment, "with a meter assignment gap"],
    [c.notBilled.noReading, "with no meter data"],
    [c.notBilled.failed, "not saved"],
  ] as const;
  const left = [
    [c.kept, "entered by hand"],
    [c.left, "paid, invoiced or refunded"],
    [c.changed, "changed meanwhile"],
    [c.notRefreshed, "not refreshed"],
  ] as const;
  if (short) {
    if (notBilledCount(c) > 0) sentences.push(`Not billed: ${n(notBilledCount(c))}.`);
    const leftCount = c.kept + c.left + c.changed + c.notRefreshed;
    if (leftCount > 0) sentences.push(`Left as they were: ${n(leftCount)}.`);
    return sentences;
  }
  const nb = notBilled.filter(([count]) => count > 0).map(([count, phrase]) => `${n(count)} ${phrase}`);
  if (nb.length > 0) sentences.push(`Not billed: ${nb.join(", ")}.`);
  const lf = left.filter(([count]) => count > 0).map(([count, phrase]) => `${n(count)} ${phrase}`);
  if (lf.length > 0) sentences.push(`Left as they were: ${lf.join(", ")}.`);
  return sentences;
}
