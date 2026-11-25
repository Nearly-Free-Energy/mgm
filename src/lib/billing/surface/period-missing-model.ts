import "server-only";

/**
 * The signals of the `billing.period-missing` watcher (./period-missing.ts),
 * built from what it has already read: one warning per microgrid that had a
 * metered tenant during the previous calendar month, in the microgrid's own
 * zone, and has no billing period for any day of that month, from the 2nd of
 * the current month in that zone (decided on #230). Each leads to the
 * microgrid's billing periods, where its create form starts with the
 * previous calendar month (getDefaultDates, ../default-dates.ts).
 *
 * A period of any status with any day in the month counts as one for it, so
 * a microgrid billed on a cycle that does not start on the 1st is not
 * reported every month. "Metered" is the bill engine's test: a primary
 * consumption-meter assignment effective on some day of the month
 * (overlapsPeriod, ../meter-coverage.ts), whether or not its meter has
 * OpenEMS ids, since a unit billed from typed readings needs a period too.
 *
 * Fixed copy: the microgrid's name and the month's name, as the close
 * ceremony names a period (periodName in ../close.ts). No tenant reaches a
 * signal, since an assistant may read signals (#133's data boundary).
 */
import { MAX_SIGNALS_PER_SOURCE, type Fmt, type SignalOut } from "@/lib/gui/surface";
import { addDaysToDateKey, dayKeyInZone, startOfDayInZone } from "@/lib/timezone/day-key";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { periodName } from "../close";
import { getDefaultDates } from "../default-dates";
import type { PeriodDates } from "../meter-coverage";
import { periodLabel } from "./period-label";

export const PERIOD_MISSING_SIGNAL = "billing.period-missing";
/** The day of the month, in the microgrid's zone, from which last month's missing period is reported. */
export const REPORT_FROM_DAY = 2;

export type MissingMicrogrid = {
  id: string;
  name: string;
  /** The microgrid's zone (microgrids.timezone); one the runtime cannot resolve counts as UTC. */
  timezone: string;
};

const zoneOf =(timezone: string) => (isSupportedTimezone(timezone) ? timezone : "UTC");

/**
 * The previous calendar month in the microgrid's zone, as the create form's
 * defaults name it, once the zone's date is the REPORT_FROM_DAY or later;
 * null before then.
 */
export function expectedMonth(timezone: string, now: Date): PeriodDates | null {
  const zone = zoneOf(timezone);
  if (Number(dayKeyInZone(now, zone).slice(8, 10)) < REPORT_FROM_DAY) return null;
  const { start, end } = getDefaultDates(now, zone);
  return { start_date: start, end_date: end };
}

/** Whether a period (inclusive dates) has any day in `month`. */
export function periodTouches(period: PeriodDates, month: PeriodDates): boolean {
  return period.start_date <= month.end_date && period.end_date >= month.start_date;
}

/**
 * One warning per microgrid in `missing`, which the watcher found with a
 * metered tenant and no period for its expected month, by name, at most
 * MAX_SIGNALS_PER_SOURCE. One with no expected month at `now` is left out.
 */
export function buildPeriodMissingSignals(fmt: Fmt, missing: readonly MissingMicrogrid[], now: Date): SignalOut[] {
  return missing
    .flatMap((m) => {
      const month = expectedMonth(m.timezone, now);
      return month ? [{ m, month }] : [];
    })
    .sort((a, b) => a.m.name.localeCompare(b.m.name) || a.m.id.localeCompare(b.m.id))
    .slice(0, MAX_SIGNALS_PER_SOURCE)
    .map(({ m, month }): SignalOut => {
      const label = periodLabel(fmt, month.start_date, month.end_date);
      // The day reporting starts: the REPORT_FROM_DAY of the month after.
      const due = addDaysToDateKey(month.end_date, REPORT_FROM_DAY);
      return {
        id: m.id,
        kind: "your-move",
        severity: "warn",
        title: `${m.name}: no billing period for ${periodName(month.start_date, month.end_date) ?? label}`,
        facts: [fmt.text(label)],
        entity: { kind: "microgrid", id: m.id, label: m.name },
        href: `/microgrids/${m.id}/billing`,
        at: startOfDayInZone(due, zoneOf(m.timezone)).toISOString(),
        due,
      };
    });
}
