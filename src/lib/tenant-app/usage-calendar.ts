/**
 * usage-calendar.ts — a tenant's month and day of use (RFC mgm#197 § 5),
 * from the unit's meter links and the figures read for them.
 *
 * Pure: no clock (the caller passes now and today), no I/O. The capability
 * reads the links and the figures; this module decides which meters count
 * on which day, sums them and gives each day or hour its state.
 */
import {
  addDaysToDateKey,
  isCalendarDateKey,
  localHourStarts,
  startOfDayInZone,
} from "@/lib/timezone/day-key";
import type {
  PrimaryElsewhereSpan,
  TenantMeter,
  TenantUsageBucket,
  TenantUsageDay,
  TenantUsageMonth,
  TenantUsageProblem,
  TenantUsageReadInfo,
  TenantUsageSeries,
  TenantUsageTotal,
} from "./types";

/** The earliest month the views show; anything before it reads as the current month. */
export const USAGE_EARLIEST_MONTH = "2000-01";
const USAGE_EARLIEST_DATE = `${USAGE_EARLIEST_MONTH}-01`;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The month to show: `requested` when it is a `YYYY-MM` from 2000-01 to the current month, else the current month. */
export function resolveRequestedMonth(requested: string | undefined, today: string): string {
  const current = today.slice(0, 7);
  if (
    typeof requested === "string" &&
    MONTH_RE.test(requested) &&
    requested >= USAGE_EARLIEST_MONTH &&
    requested <= current
  ) {
    return requested;
  }
  return current;
}

/** The day to show: `requested` when it is a real `YYYY-MM-DD` from 2000-01-01 to today, else today. */
export function resolveRequestedDate(requested: string | undefined, today: string): string {
  if (
    typeof requested === "string" &&
    isCalendarDateKey(requested) &&
    requested >= USAGE_EARLIEST_DATE &&
    requested <= today
  ) {
    return requested;
  }
  return today;
}

/** `month` moved by `n` months, `YYYY-MM`; plain calendar arithmetic through UTC. */
export function addMonths(month: string, n: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + n, 1)).toISOString().slice(0, 7);
}

/** Every day of `month` (`YYYY-MM`), from the 1st to the last, `YYYY-MM-DD`. */
export function datesOfMonth(month: string): string[] {
  const dates: string[] = [];
  for (let date = `${month}-01`; date.startsWith(month); date = addDaysToDateKey(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/**
 * The device ids in force on `date`: a link covers its days from
 * `effectiveFrom` up to, not including, `effectiveTo` (null: still in force),
 * half-open as billing reads it. A device linked twice counts once.
 */
export function metersOn(assignments: readonly TenantMeter[], date: string): Set<string> {
  const ids = new Set<string>();
  for (const link of assignments) {
    if (inForceOn(link, date)) ids.add(link.deviceId);
  }
  return ids;
}

/** The link covers `date`: from `effectiveFrom` up to, not including, `effectiveTo`. */
export function inForceOn(link: TenantMeter, date: string): boolean {
  return link.effectiveFrom <= date && (link.effectiveTo === null || date < link.effectiveTo);
}

/** `a` is before `b`, where null is a period's open end (after every day). */
const endsBefore = (a: string | null, b: string | null) => a !== null && (b === null || a < b);

/**
 * The links with each secondary link's days removed where its device is
 * another unit's primary (decided on #210, 19 November; TENANT_METER_ROLES).
 * Half-open periods, as metersOn reads them, with null for an open end. A
 * link may split into several pieces, oldest first, each in the link's
 * place; a piece with no days is dropped. Primary links pass unchanged. If
 * the rule ever covers a meter that is two units' primary, or two units'
 * secondary, at once, it is decided here.
 */
export function withoutPrimaryElsewhere(
  links: readonly TenantMeter[],
  spans: readonly PrimaryElsewhereSpan[]
): TenantMeter[] {
  return links.flatMap((link) => {
    if (link.role !== "secondary_meter") return [link];
    let pieces: { from: string; to: string | null }[] = [{ from: link.effectiveFrom, to: link.effectiveTo }];
    for (const span of spans) {
      if (span.deviceId !== link.deviceId) continue;
      pieces = pieces.flatMap((piece) => {
        // No overlap: the span ends on or before the piece starts, or starts on or after it ends.
        if (!endsBefore(piece.from, span.effectiveTo) || !endsBefore(span.effectiveFrom, piece.to)) {
          return [piece];
        }
        const kept: { from: string; to: string | null }[] = [];
        if (piece.from < span.effectiveFrom) kept.push({ from: piece.from, to: span.effectiveFrom });
        if (endsBefore(span.effectiveTo, piece.to)) {
          kept.push({ from: span.effectiveTo as string, to: piece.to });
        }
        return kept;
      });
    }
    return pieces
      .filter((piece) => endsBefore(piece.from, piece.to))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
      .map((piece) => ({ ...link, effectiveFrom: piece.from, effectiveTo: piece.to }));
  });
}

/**
 * A stable text of the links (device and dates), for the cache key: the same
 * links in any order give the same key, and a link that moves gives another.
 */
export function assignmentsKey(assignments: readonly TenantMeter[]): string {
  return [
    ...new Set(assignments.map((link) => `${link.deviceId}@${link.effectiveFrom}..${link.effectiveTo ?? ""}`)),
  ]
    .sort()
    .join(",");
}

/**
 * The sum over `devices` of bucket `index`, rounded to the Wh, or null when
 * any of them has no value there, when there are none, or when `index` is
 * undefined (the source returned no such bucket). Never the sum of the
 * meters that had a value.
 */
export function sumMeters(
  series: TenantUsageSeries,
  devices: Iterable<string>,
  index: number | undefined
): number | null {
  if (index === undefined) return null;
  let wh = 0;
  let counted = 0;
  for (const id of devices) {
    const value = Object.hasOwn(series.kwh, id) ? series.kwh[id][index] : undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    wh += value * 1000;
    counted += 1;
  }
  return counted > 0 ? Math.round(wh) / 1000 : null;
}

/** What was read for a view, and when. */
export type UsageFigures =
  /** Nothing was read: no meter was in force on any day up to today. */
  | { kind: "none" }
  | {
      kind: "figures";
      /** kWh by bucket key (a date, or `String(hour start)`); null for no value. */
      values: Record<string, number | null>;
      /** When the source was read, epoch ms: a cached or kept read's own time, never the request's. */
      readAt: number;
      stale: boolean;
      synthetic: boolean;
    }
  | { kind: "problem"; problem: TenantUsageProblem };

type BucketFacts = {
  start: number;
  /** The next bucket's start. */
  end: number;
  future: boolean;
  inForce: boolean;
  /** The figure read for the bucket; undefined when none was read for it. */
  value: number | null | undefined;
};

/**
 * A bucket's state (first match wins): after now → future; no meter in force
 * → no-meter; no figures (a problem) → no-data; not ended when the figures
 * were read → partial, with the figure when the bucket held the read time and
 * null when it began since (so a part-bucket figure is never shown as the
 * whole bucket's use, however long after the read it is served); no value →
 * no-data; otherwise data.
 */
function bucketState(bucket: BucketFacts, figures: UsageFigures): TenantUsageBucket {
  if (bucket.future) return { state: "future", kwh: null };
  if (!bucket.inForce) return { state: "no-meter", kwh: null };
  if (figures.kind !== "figures") return { state: "no-data", kwh: null };
  if (bucket.end > figures.readAt) {
    return { state: "partial", kwh: bucket.start <= figures.readAt ? (bucket.value ?? null) : null };
  }
  if (bucket.value === null || bucket.value === undefined) return { state: "no-data", kwh: null };
  return { state: "data", kwh: bucket.value };
}

/**
 * No total ("No data") when any bucket with a meter in force has no figure,
 * when no bucket has one, or on a problem: never a lower number (RFC mgm#197
 * § 5). Otherwise the sum of the data and partial figures, to the Wh.
 */
function totalOf(buckets: readonly TenantUsageBucket[], figures: UsageFigures): TenantUsageTotal {
  const withoutData = buckets.filter((bucket) => bucket.state === "no-data").length;
  const shown = buckets.flatMap((bucket) =>
    (bucket.state === "data" || bucket.state === "partial") && bucket.kwh !== null ? [bucket.kwh] : []
  );
  if (figures.kind !== "figures" || withoutData > 0 || shown.length === 0) {
    return { kwh: null, withoutData };
  }
  return { kwh: Math.round(shown.reduce((sum, kwh) => sum + kwh * 1000, 0)) / 1000, withoutData };
}

function readInfo(figures: UsageFigures): TenantUsageReadInfo {
  if (figures.kind === "figures") {
    return { readAt: figures.readAt, stale: figures.stale, synthetic: figures.synthetic, problem: null };
  }
  return {
    readAt: null,
    stale: false,
    synthetic: false,
    problem: figures.kind === "problem" ? figures.problem : null,
  };
}

function valueOf(figures: UsageFigures, key: string): number | null | undefined {
  if (figures.kind !== "figures" || !Object.hasOwn(figures.values, key)) return undefined;
  return figures.values[key];
}

/** A month of the unit's use per local day, in `timezone`; `figures.values` keyed by date. */
export function computeUsageMonth(input: {
  tenant: TenantUsageMonth["tenant"];
  timezone: string;
  month: string;
  /** Today in `timezone`: days after it are future. */
  today: string;
  /** The request's time, epoch ms. */
  nowMs: number;
  assignments: readonly TenantMeter[];
  figures: UsageFigures;
}): TenantUsageMonth {
  const { timezone, month, today, figures } = input;
  const days = datesOfMonth(month).map((date) => ({
    date,
    ...bucketState(
      {
        start: startOfDayInZone(date, timezone).getTime(),
        end: startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime(),
        future: date > today,
        inForce: metersOn(input.assignments, date).size > 0,
        value: valueOf(figures, date),
      },
      figures
    ),
  }));
  return {
    tenant: input.tenant,
    timezone,
    month,
    today,
    previousMonth: addMonths(month, -1),
    nextMonth: month < today.slice(0, 7) ? addMonths(month, 1) : null,
    days,
    total: totalOf(days, figures),
    read: readInfo(figures),
  };
}

/** One local day of the unit's use per hour, in `timezone`; `figures.values` keyed by `String(hour start)`. */
export function computeUsageDay(input: {
  tenant: TenantUsageDay["tenant"];
  timezone: string;
  date: string;
  today: string;
  /** The request's time, epoch ms: hours that start after it are future. */
  nowMs: number;
  assignments: readonly TenantMeter[];
  figures: UsageFigures;
}): TenantUsageDay {
  const { timezone, date, today, nowMs, figures } = input;
  const meters = metersOn(input.assignments, date).size;
  const starts = localHourStarts(date, timezone);
  const dayEnd = startOfDayInZone(addDaysToDateKey(date, 1), timezone).getTime();
  const hours = starts.map((start, i) => ({
    start,
    ...bucketState(
      {
        start,
        end: starts[i + 1] ?? dayEnd,
        future: start > nowMs,
        inForce: meters > 0,
        value: valueOf(figures, String(start)),
      },
      figures
    ),
  }));
  return {
    tenant: input.tenant,
    timezone,
    date,
    today,
    previousDate: addDaysToDateKey(date, -1),
    nextDate: date < today ? addDaysToDateKey(date, 1) : null,
    meters,
    hours,
    total: totalOf(hours, figures),
    read: readInfo(figures),
  };
}
