/**
 * The dates a new billing period's form starts with: the previous calendar
 * month. The periods view (billing.periods, ./surface/periods.ts) passes them
 * as the create action's prefill and the legacy periods list
 * (src/components/BillingPeriodList.tsx) as its form's starting state, so
 * both open on the same month.
 *
 * Client-safe and pure apart from the clock its caller passes in.
 */
import { dayKeyInZone } from "@/lib/timezone/day-key";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The previous calendar month as `YYYY-MM-DD` start and end dates. "Today" is
 * read in `timezone` (the microgrid's IANA zone) when given, otherwise from
 * the runtime's local date parts. Neither path goes through `toISOString()`,
 * which names the UTC day and moves both dates back a day east of UTC.
 */
export function getDefaultDates(
  now: Date = new Date(),
  timezone?: string,
): { start: string; end: string } {
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-12
  if (timezone) {
    // dayKeyInZone reads the calendar day of an instant (now), not a stored
    // billing DATE, so this stays inside the scope its header sets.
    try {
      const [y, m] = dayKeyInZone(now, timezone).split("-");
      year = Number(y);
      month = Number(m);
    } catch {
      // Unknown zone id (RangeError): keep the local date parts rather than
      // fail the whole billing page over a form's default dates.
    }
  }

  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  // Day 0 of the following month is the last day of prevMonth. UTC keeps
  // this pure calendar arithmetic, free of any local-zone shift.
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();

  return {
    start: `${prevYear}-${pad2(prevMonth)}-01`,
    end: `${prevYear}-${pad2(prevMonth)}-${pad2(lastDay)}`,
  };
}
