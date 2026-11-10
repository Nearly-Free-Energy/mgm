/**
 * requested-day.ts — which local day a day view shows, from its `?date=`.
 *
 * Pure: the caller passes `now`. The Operations page uses it, and the
 * Operations view's loader is meant to as well, so a link opens the same day
 * on either path; if either stops using it, revisit.
 *
 * - The microgrid's stored zone, or UTC when it is not one this installation
 *   supports.
 * - A single `?date=` that names a calendar day on or before today in that
 *   zone is shown as asked.
 * - Anything else (absent, repeated, malformed, not a real day, after today)
 *   shows yesterday, the last whole day.
 */
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { addDaysToDateKey, dayKeyInZone, isCalendarDateKey } from "./day-key";

export type RequestedDay = {
  /** The zone the day is read in. */
  timezone: string;
  /** Today's date in that zone, YYYY-MM-DD. */
  today: string;
  /** The day to show, YYYY-MM-DD, never after `today`. */
  date: string;
};

export function resolveRequestedDay(input: {
  /** The `date` search parameter: one value, every value given, or none. */
  requested: string | readonly string[] | null | undefined;
  /** The microgrid's stored IANA zone. */
  stored: string | null | undefined;
  now: Date | number;
}): RequestedDay {
  const timezone = input.stored && isSupportedTimezone(input.stored) ? input.stored : "UTC";
  const today = dayKeyInZone(input.now, timezone);
  const values = typeof input.requested === "string" ? [input.requested] : (input.requested ?? []);
  const [only] = values;
  const date =
    values.length === 1 && isCalendarDateKey(only) && only <= today ? only : addDaysToDateKey(today, -1);
  return { timezone, today, date };
}
