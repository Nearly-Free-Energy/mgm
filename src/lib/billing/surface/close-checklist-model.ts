/**
 * close-checklist-model.ts — what a manager walks before closing a billing
 * period, as a `flow` view model (`billing.close-checklist`), with the close
 * itself on its last step.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here. Each step is derived from the close review
 * (fn_billing_period_close_review, read through ../close.ts) and the
 * period's bills, so it shows what the close will ask about and nothing the
 * close does not check:
 *
 *  - blocked: must be fixed before the period can close (no bills, or a
 *    total that is not a whole number, which the close refuses);
 *  - todo: needs attention, fixed or acknowledged when closing (tenants with
 *    no bill, bills with no usage), or confirmed when closing (the totals);
 *  - done: nothing to do;
 *  - current: the close, once nothing above it is blocked.
 *
 * The close step offers `billing.close-period`, whose prepare returns the
 * server's ceremony (./close-checklist.ts): the totals, warnings,
 * acknowledgements and typed name are the review's, never built here.
 */
import type { LinkRef } from "@/lib/gui/contract";
import type { ActionLink, Fmt, LoadedModel } from "@/lib/gui/surface";
import { fractionalTotalsMessage, tenantNames, type CloseReview } from "../close";
import { count } from "../close-ceremony";
import { buildCsvFilename } from "../csv-export";
import { BACK_TO_PERIOD_LINK, clipText, periodHistoryHref } from "./period-history-model";
import { periodLabel } from "./period-label";
import { closeChecklistHref, EXPORT_CSV_LINK, VIEW_HISTORY_LINK } from "./period-review-model";

export { closeChecklistHref };

/** The steps a draft's checklist has, in order. A closed period shows only "close". */
export const CLOSE_CHECKLIST_STEPS = ["bills", "usage", "totals", "close"] as const;

/** The action the close step offers; BILLING_SURFACE (../surface.ts) defines it. */
export const CLOSE_PERIOD_ACTION = { id: "billing.close-period", title: "Close period" } as const;

/**
 * A step's detail is cut to this many characters. The host refuses a model
 * with any string over MODEL_CAPS.text (4000); tenants.display_name has no
 * length limit, and a detail names up to five tenants.
 */
export const CLOSE_CHECKLIST_DETAIL_MAX = 1000;

export type CloseChecklistInput = {
  microgrid: { id: string; name: string; timezone: string | null };
  period: {
    id: string;
    start_date: string;
    end_date: string;
    closed_at: string | null;
    timezone: string | null;
  };
  /** The close review of this period: what the close checks and asks about. */
  review: CloseReview;
  /**
   * Of the period's bills with usage recorded, how many were read from
   * meters and how many entered by hand. A bill with no usage is in neither:
   * its reading_source is still 'edge' by default (00029), so the loader
   * counts only bills whose usage_kwh is set.
   */
  sources: { edge: number; manual: number };
  fmt: Fmt;
};

type Step = LoadedModel<"flow">["body"]["steps"][number];

/** Sentences joined into one detail, clipped. */
const detail = (...parts: (string | null)[]): string =>
  clipText(parts.filter((p): p is string => p !== null).join(" "), CLOSE_CHECKLIST_DETAIL_MAX);

/** The steps of a draft period, in CLOSE_CHECKLIST_STEPS order. */
function draftSteps(i: CloseChecklistInput, reviewHref: `/${string}`): Step[] {
  const { review, sources, fmt } = i;
  const bills = review.billCount;

  const billsStep: Step =
    bills === 0
      ? { id: "bills", title: "Bills for every tenant", state: "blocked", detail: "No bills yet. Generate the bills on the period's page before closing." }
      : review.unbilled.length > 0
        ? {
            id: "bills",
            title: "Bills for every tenant",
            state: "todo",
            detail: detail(
              `${count(review.unbilled.length, "tenant has", "tenants have")} no bill in this period: ${tenantNames(review.unbilled)}.`,
              "Generate their bills, or acknowledge it when you close.",
            ),
          }
        : { id: "bills", title: "Bills for every tenant", state: "done", detail: `${count(bills, "bill", "bills")}.` };

  const sourcesPhrase = `${sources.edge} read from meters, ${sources.manual} entered by hand.`;
  // After the bills with no usage, the sources are of the rest; none when no bill has usage.
  const sourcesSentence = sources.edge + sources.manual === 0 ? null : review.unmetered.length > 0 ? `Of the rest, ${sourcesPhrase}` : sourcesPhrase;
  const usageStep: Step =
    bills === 0
      ? { id: "usage", title: "Usage on every bill", state: "todo" }
      : review.unmetered.length > 0
        ? {
            id: "usage",
            title: "Usage on every bill",
            state: "todo",
            detail: detail(
              `${count(review.unmetered.length, "bill has", "bills have")} no usage recorded: ${tenantNames(review.unmetered)}.`,
              "Enter their readings on the period's page, or acknowledge it when you close.",
              sourcesSentence,
            ),
          }
        : { id: "usage", title: "Usage on every bill", state: "done", detail: detail("Every bill has usage recorded.", sourcesSentence) };

  // As the ceremony shows the total (../close-ceremony.ts): money in the
  // period's currency, or a plain number when it has none.
  const total = review.currency ? fmt.money(review.totalAmount, review.currency).text : fmt.number(review.totalAmount).text;
  const totalsStep: Step =
    review.fractionalTotals.length > 0
      ? { id: "totals", title: "Totals to file", state: "blocked", detail: detail(fractionalTotalsMessage(review.fractionalTotals)) }
      : bills === 0
        ? { id: "totals", title: "Totals to file", state: "todo" }
        : {
            id: "totals",
            title: "Totals to file",
            state: "todo",
            detail: detail(
              `${count(bills, "bill", "bills")}, ${fmt.energy(review.usageKwh * 1000).text}, total ${total}.`,
              "You confirm these figures when you close.",
            ),
          };

  const checks = [billsStep, usageStep, totalsStep].map((s): Step => ({ ...s, href: reviewHref }));
  const blocked = checks.some((s) => s.state === "blocked");
  // Offered blocked too: available() disables it with the reason, so the
  // button says why rather than vanishing.
  const close: ActionLink = { action: CLOSE_PERIOD_ACTION.id, params: { periodId: i.period.id }, label: "Close period" };
  return [
    ...checks,
    blocked
      ? { id: "close", title: "Close the period", state: "blocked", detail: "Fix the blocked items above before closing.", action: close }
      : {
          id: "close",
          title: "Close the period",
          state: "current",
          detail: "Closing asks you to confirm the totals, tick each warning and type the period's name. Bills become final.",
          action: close,
        },
  ];
}

export function buildCloseChecklistModel(i: CloseChecklistInput): LoadedModel<"flow"> {
  const { microgrid, period, review, fmt } = i;
  const closed = review.status === "closed";
  const reviewHref = `/microgrids/${microgrid.id}/billing/${period.id}` as const;

  const steps: Step[] = closed
    ? [
        {
          id: "close",
          title: "Period closed",
          state: "done",
          detail: `${period.closed_at ? `Closed ${fmt.datetime(period.closed_at, period.timezone ?? microgrid.timezone ?? "UTC").text}.` : "Closed."} Bills are final; corrections are recorded against the closed period.`,
        },
      ]
    : draftSteps(i, reviewHref);

  const links: LinkRef[] = [
    { id: BACK_TO_PERIOD_LINK, label: "Back to period", href: reviewHref },
    { id: VIEW_HISTORY_LINK, label: "View history", href: periodHistoryHref(microgrid.id, period.id) },
  ];
  // The legacy close dialog's last step, here once the period is closed.
  if (closed && review.billCount > 0) {
    links.push({
      id: EXPORT_CSV_LINK,
      label: "Export CSV for URA",
      icon: "download",
      href: `/api/billing-periods/${period.id}/export-csv`,
      download: {
        mime: "text/csv",
        filename: buildCsvFilename({ microgridName: microgrid.name, startDate: period.start_date, endDate: period.end_date }),
      },
    });
  }

  return {
    title: closed ? `${review.name} is closed` : `Close ${review.name}`,
    ...(period.timezone ? { subtitle: period.timezone } : {}),
    entity: { kind: "billingPeriod", id: period.id, label: periodLabel(fmt, period.start_date, period.end_date) },
    // Close sits on its step, after the checks it follows.
    actions: [],
    links,
    body: { steps },
  };
}
