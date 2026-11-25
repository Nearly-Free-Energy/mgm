import "server-only";

/**
 * The signals of the `billing.period-due` watcher (./period-due.ts), built
 * from rows already read: one per draft billing period whose last day has
 * passed in the period's own time zone. A period with bills asks to be
 * closed and leads to its close checklist; one with none asks for its bills
 * and leads to its review, which offers generating them.
 *
 * Severity (decided on #230): "not closed" is a warning from the day after
 * the period's last day and critical from CRITICAL_AFTER_DAYS after it, both
 * in the period's own zone. "Has no bills" stays a warning however old.
 *
 * Fixed copy: the microgrid's name and the period's name, as the close
 * ceremony names it (periodName in ../close.ts). No tenant, amount or id
 * reaches the text, since an assistant may read signals (#133's data
 * boundary).
 */
import { MAX_SIGNALS_PER_SOURCE, type Fmt, type SignalOut } from "@/lib/gui/surface";
import { addDaysToDateKey, dayKeyInZone, startOfDayInZone } from "@/lib/timezone/day-key";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { periodName } from "../close";
import { periodLabel } from "./period-label";

export const PERIOD_DUE_SIGNAL = "billing.period-due";
/** Days after a period's last day, in its zone, from which "not closed" is critical rather than a warning. */
export const CRITICAL_AFTER_DAYS = 7;

export type DuePeriodInput = {
  id: string;
  microgridId: string;
  microgridName: string;
  startDate: string;
  endDate: string;
  /** The period's own zone (billing_periods.timezone); one the runtime cannot resolve counts as UTC. */
  timezone: string;
  bills: number;
};

const zoneOf = (timezone: string) => (isSupportedTimezone(timezone) ? timezone : "UTC");

/** Whether the period's last day has passed in its own time zone at `now`. */
export function hasEnded(period: Pick<DuePeriodInput, "endDate" | "timezone">, now: Date): boolean {
  return period.endDate < dayKeyInZone(now, zoneOf(period.timezone));
}

/**
 * Whether an open period is CRITICAL_AFTER_DAYS or more past its last day
 * at `now`, in its own zone; only one with bills is then critical.
 */
export function isOverdue(period: Pick<DuePeriodInput, "endDate" | "timezone">, now: Date): boolean {
  return addDaysToDateKey(period.endDate, CRITICAL_AFTER_DAYS) <= dayKeyInZone(now, zoneOf(period.timezone));
}

/**
 * One signal per period whose last day has passed, oldest first, at most
 * MAX_SIGNALS_PER_SOURCE. `periods` are draft periods; any that has not
 * ended yet is left out here.
 */
export function buildPeriodDueSignals(fmt: Fmt, periods: readonly DuePeriodInput[], now: Date): SignalOut[] {
  return periods
    .filter((p) => hasEnded(p, now))
    .sort((a, b) => a.endDate.localeCompare(b.endDate) || a.microgridName.localeCompare(b.microgridName) || a.id.localeCompare(b.id))
    .slice(0, MAX_SIGNALS_PER_SOURCE)
    .map((p): SignalOut => {
      const label = periodLabel(fmt, p.startDate, p.endDate);
      const name = periodName(p.startDate, p.endDate) ?? label;
      const due = addDaysToDateKey(p.endDate, 1);
      const base = `/microgrids/${p.microgridId}/billing/${p.id}` as const;
      return {
        id: p.id,
        kind: "your-move",
        severity: p.bills > 0 && isOverdue(p, now) ? "critical" : "warn",
        title: p.bills > 0 ? `${p.microgridName}: ${name} is not closed` : `${p.microgridName}: ${name} has no bills`,
        facts: [fmt.text(label)],
        entity: { kind: "microgrid", id: p.microgridId, label: p.microgridName },
        href: p.bills > 0 ? `${base}/close` : base,
        // When the period became ready to close: the start of the day after its last, in its zone.
        // `at` and `due` stay there once it is critical: it has been due since then.
        at: startOfDayInZone(due, zoneOf(p.timezone)).toISOString(),
        due,
      };
    });
}
