/**
 * Closing a billing period against the totals a person reviewed (#201).
 *
 * fn_billing_period_close_review (migration 20261118130000) computes the
 * review: the totals, the warnings, the acknowledgements the close requires
 * and a digest of the figures behind the totals. fn_close_billing_period
 * recomputes the digest inside the write and refuses a close whose digest or
 * acknowledgements do not match. This module holds what both sides of the
 * confirmation need besides that: the review's shape, the label of each
 * acknowledgement and the period's name, which the person types.
 *
 * Client-safe: imports only zod and the typed-name check
 * (src/lib/validation/typed-name.ts), which imports nothing.
 */
import { z } from "zod";
import { typedNameMatches } from "@/lib/validation/typed-name";

/**
 * The label a person ticks for each acknowledgement the database can
 * require, keyed by the ids fn_billing_period_close_review returns. An id
 * the database returns without a label here fails parseCloseReview, so the
 * close is refused rather than asked with no wording; a new id in a
 * migration needs its label here in the same change.
 */
export const CLOSE_ACKNOWLEDGEMENTS = {
  totals_reviewed: "I have reviewed these totals, and they are what I will file. Closing is final.",
  tenants_without_bills: "I am closing this period although some tenants have no bill in it.",
  bills_without_usage: "I am closing this period although some bills have no usage recorded.",
} as const;
export type CloseAcknowledgementId = keyof typeof CLOSE_ACKNOWLEDGEMENTS;

const ACKNOWLEDGEMENT_IDS = Object.keys(CLOSE_ACKNOWLEDGEMENTS) as [
  CloseAcknowledgementId,
  ...CloseAcknowledgementId[],
];

/**
 * The refusals of a close that the close route (./capability.ts
 * closePeriod) and the contributed close action's prepare and availability
 * (./surface/close-checklist.ts) both give, so a person reads the same
 * sentence in every interface. fractionalTotalsMessage below is shared for
 * the same reason, and takes the tenants rather than their joined names so
 * that every caller names them the same way.
 */
export const CLOSE_REFUSAL_COPY = {
  closed: "Billing period is already closed.",
  reviewUnavailable: "Could not load the period's totals. Retry before closing the period.",
  /**
   * The close route's 409 billing_period_totals_changed, shown over the new
   * totals. The GUI host prepares billing.close-period again on this code
   * (its prepareAgainOn in ./surface.ts) and shows this sentence over the
   * new ceremony (src/lib/gui/host/client/action-host.tsx). If it stops
   * showing the new totals with it, revisit this sentence.
   */
  totalsChanged: "The period's totals changed after you reviewed them. Review the new totals and confirm again.",
} as const;

/** Names shown in a list of tenants before the rest are counted. */
const NAMES_SHOWN = 5;

/**
 * The tenants a warning or refusal names: the first five, then "and N
 * more". The ceremony's warnings (./close-ceremony.ts), the close checklist
 * (./surface/close-checklist-model.ts) and fractionalTotalsMessage name them
 * with this, so every interface lists the same tenants.
 */
export function tenantNames(list: readonly { tenantName: string }[]): string {
  const shown = list.slice(0, NAMES_SHOWN).map((t) => t.tenantName).join(", ");
  const more = list.length - NAMES_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * The refusal of a close while some bill totals are not whole numbers,
 * naming those tenants with tenantNames. The close route and the close
 * checklist both pass the review's fractionalTotals, so the sentence is the
 * same in both.
 */
export function fractionalTotalsMessage(tenants: readonly { tenantName: string }[]): string {
  const names = tenantNames(tenants);
  return names.length > 0
    ? `Regenerate the bills for ${names} before closing: their totals are not whole numbers.`
    : "Regenerate the bills whose totals are not whole numbers before closing.";
}

const tenantRef = z.object({ tenantId: z.string(), tenantName: z.string() });
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** fn_billing_period_close_review's result, as the database returns it. */
const CloseReviewRow = z.object({
  periodId: z.string(),
  microgridId: z.string(),
  status: z.enum(["draft", "closed"]),
  startDate: calendarDay,
  endDate: calendarDay,
  currency: z.string().nullable(),
  billCount: z.number().int().nonnegative(),
  totalAmount: z.number(),
  usageKwh: z.number(),
  unbilled: z.array(tenantRef),
  unmetered: z.array(tenantRef),
  fractionalTotals: z.array(tenantRef),
  acknowledgements: z.array(z.enum(ACKNOWLEDGEMENT_IDS)).min(1),
  digest: z.string().min(1),
});

type TenantRef = z.infer<typeof tenantRef>;

/** What a person reviews before closing a period, and what the close is checked against. */
export type CloseReview = {
  periodId: string;
  microgridId: string;
  status: "draft" | "closed";
  startDate: string;
  endDate: string;
  currency: string | null;
  billCount: number;
  totalAmount: number;
  usageKwh: number;
  /** Tenants of the microgrid with no bill in the period. */
  unbilled: TenantRef[];
  /** Tenants whose bill has no usage recorded. */
  unmetered: TenantRef[];
  /**
   * Tenants whose bill total is not a whole number. A period with any cannot
   * close: totals are whole units of the currency (fn_billing_period_close_review).
   */
  fractionalTotals: TenantRef[];
  /** The period's name, which the person types to confirm. */
  name: string;
  acknowledgements: { id: CloseAcknowledgementId; label: string }[];
  digest: string;
};

/** Parses the database's review, or returns null when it is not one. */
export function parseCloseReview(raw: unknown): CloseReview | null {
  const parsed = CloseReviewRow.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  const name = periodName(row.startDate, row.endDate);
  if (name === null) return null;
  return {
    ...row,
    name,
    acknowledgements: row.acknowledgements.map((id) => ({ id, label: CLOSE_ACKNOWLEDGEMENTS[id] })),
  };
}

// English on purpose: the person types this name and the server compares it,
// so it must not depend on the browser's language. If the name is ever
// localised, the comparison in typedNameMatches must accept each locale's form.
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function day(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return { y, m, d };
}

const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * A period's name: "October 2026" for a whole calendar month, "5 October
 * 2026" for one day, "1 to 15 October 2026", "1 October to 15 November
 * 2026" or "20 December 2026 to 10 January 2027" otherwise. Written with
 * "to" rather than a dash so it can be typed on any keyboard. Null for a
 * date that is not a calendar day, or an end before the start.
 */
export function periodName(startDate: string, endDate: string): string | null {
  const s = day(startDate);
  const e = day(endDate);
  if (!s || !e || startDate > endDate) return null;
  const month = (m: number) => MONTHS[m - 1];
  if (startDate === endDate) return `${s.d} ${month(s.m)} ${s.y}`;
  if (s.y === e.y && s.m === e.m) {
    if (s.d === 1 && e.d === lastDayOfMonth(e.y, e.m)) return `${month(s.m)} ${s.y}`;
    return `${s.d} to ${e.d} ${month(s.m)} ${s.y}`;
  }
  if (s.y === e.y) return `${s.d} ${month(s.m)} to ${e.d} ${month(e.m)} ${e.y}`;
  return `${s.d} ${month(s.m)} ${s.y} to ${e.d} ${month(e.m)} ${e.y}`;
}

/** Whether what the person typed is the period's name, ignoring case and spacing. */
export { typedNameMatches };

/** The required acknowledgements the person did not tick, in the review's order. */
export function missingAcknowledgements(review: CloseReview, acknowledged: readonly string[]): CloseAcknowledgementId[] {
  const ticked = new Set(acknowledged);
  return review.acknowledgements.map((a) => a.id).filter((id) => !ticked.has(id));
}
