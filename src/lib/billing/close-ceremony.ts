/**
 * The host's confirmation step for closing a billing period (#201): the
 * Ceremony a person sees before the close, built from the close review
 * (./close.ts) with the server's formatter. The close route sends it with
 * its 428 and 409 answers, and the legacy billing page renders it with the
 * host's ConfirmStep; a contributed close action's prepare returns the same
 * shape, so every interface closes the same way.
 *
 * The digest and the typed name are the review's own, and the
 * acknowledgements are the review's ids with their labels, so what the
 * person confirms is exactly what fn_close_billing_period checks.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Fmt } from "@/lib/gui/surface";
import type { CloseReview } from "./close";

/** Names shown in a warning before the rest are counted. */
const NAMES_SHOWN = 5;

function names(list: { tenantName: string }[]): string {
  const shown = list.slice(0, NAMES_SHOWN).map((t) => t.tenantName).join(", ");
  const more = list.length - NAMES_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function closeCeremony(review: CloseReview, fmt: Fmt): Ceremony {
  const warnings: string[] = [];
  if (review.fractionalTotals.length > 0) {
    warnings.push(
      `${count(review.fractionalTotals.length, "bill has", "bills have")} a total that is not a whole number: ${names(review.fractionalTotals)}. Regenerate ${review.fractionalTotals.length === 1 ? "it" : "them"} before closing.`
    );
  }
  if (review.unbilled.length > 0) {
    warnings.push(
      `${count(review.unbilled.length, "tenant has", "tenants have")} no bill in this period: ${names(review.unbilled)}.`
    );
  }
  if (review.unmetered.length > 0) {
    warnings.push(
      `${count(review.unmetered.length, "bill has", "bills have")} no usage recorded: ${names(review.unmetered)}.`
    );
  }
  return {
    type: "ceremony",
    statement: `Close ${review.name}. Bills become final, and corrections after this are recorded against the closed period.`,
    facts: [
      { label: "Period", value: fmt.text(review.name) },
      { label: "Bills", value: fmt.number(review.billCount) },
      { label: "Energy", value: fmt.energy(review.usageKwh * 1000) },
      {
        label: "Total",
        value: review.currency ? fmt.money(review.totalAmount, review.currency) : fmt.number(review.totalAmount),
      },
    ],
    warnings,
    acknowledgements: review.acknowledgements.map((a) => ({ id: a.id, label: a.label })),
    typed: review.name,
    digest: review.digest,
  };
}
