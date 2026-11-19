import "server-only";

/**
 * The `tenant.usage-month` and `tenant.usage-day` views' models, built from
 * what `getUsageMonth` and `getUsageDay` return (RFC mgm#197 § 4–5): a
 * collection of days or hours with the unit's use, so every GUI draws them
 * with its kit before any bespoke renderer exists, and an ext a renderer
 * reads for the calendar and the bars (./usage-ext.ts).
 *
 * They show only the unit's title, its zone, dates, hour starts, the summed
 * kWh and each bucket's state, fixed copy and same-origin /my hrefs: never a
 * device, edge, component or microgrid id, an OpenEMS address or a provider
 * message. The usage source reads the meters' edges and the microgrid's
 * OpenEMS connection on the server (../infrastructure/usage-source.ts), and
 * none of it reaches these models; dispatchTenantView
 * (@/lib/gui/host/server/view) relies on that, and if a model ever carries
 * one of those records, that function must check it.
 *
 * The models carry no LinkRef or row href while the /my pages are
 * unreleased (RFC mgm#197: released by PR 5): the host refuses a link to an
 * unreleased page. The navigation is in the ext, which is data.
 */
import { formatLocalDate } from "@/components/format/local-date";
import { withUnit } from "@/lib/gui/host/shared/tenant-units";
import type { Value } from "@/lib/gui/contract";
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import { dayKeyInZone, localHourStarts } from "@/lib/timezone/day-key";
import type { TenantUsageBucket, TenantUsageDay, TenantUsageMonth, TenantUsageProblem, TenantUsageTotal } from "../types";
import { USAGE_EARLIEST_MONTH } from "../usage-calendar";
import { unitTitle } from "./home-model";
import type { TenantUsageDayExtData, TenantUsageMonthExtData } from "./usage-ext";

export const TENANT_USAGE_MONTH_PATH = "/my/usage";
export const TENANT_USAGE_DAY_PATH = "/my/usage/day";
/** The ext each model carries; its shape is in ./usage-ext.ts. */
export const TENANT_USAGE_MONTH_EXT_SCHEMA = "tenant.usage-month@1" as const;
export const TENANT_USAGE_DAY_EXT_SCHEMA = "tenant.usage-day@1" as const;
/** Every cell and total key each view emits. */
export const TENANT_USAGE_MONTH_KEYS = ["date", "usage", "note"] as const;
export const TENANT_USAGE_DAY_KEYS = ["hour", "usage", "note"] as const;

/**
 * Why a view has no figures, in fixed copy: never the metering source's
 * message, which can carry an outside system's text. Only the problems that
 * another try can clear suggest one: each try is one of the unit's limited
 * reads.
 */
export const TENANT_USAGE_PROBLEMS = {
  unavailable: { title: "No data", message: "Your meter readings could not be read right now. Try again in a minute." },
  limited: { title: "No data", message: "Your use has been asked for many times in the last minute. Try again in a minute." },
  "not-offered": { title: "No data", message: "Your meter readings are not available here." },
} as const satisfies Record<TenantUsageProblem, { title: string; message: string }>;

/** Which unit the hrefs name. */
export type UsageLinkContext = {
  tenantId: string;
  /** The person holds several units, so a page without `unit` would ask them to choose: hrefs name this one. */
  several: boolean;
};

type Options = { fmt: Fmt; locale: string; links: UsageLinkContext };
type Row = LoadedModel<"collection">["body"]["rows"][number];

const NO_DATA = "No data";
/**
 * The earliest day the views show. A month or date before it reads as the
 * current one (../usage-calendar.ts), so the ext names no previous period
 * there.
 */
const FIRST_DATE = `${USAGE_EARLIEST_MONTH}-01`;

const monthHref = (month: string, links: UsageLinkContext) => href(`${TENANT_USAGE_MONTH_PATH}?month=${month}`, links);
const dayHref = (date: string, links: UsageLinkContext) => href(`${TENANT_USAGE_DAY_PATH}?date=${date}`, links);
/** Names the unit only for a person with several, as the tenant home's link does (unitHomeHref). */
function href(path: `/${string}`, links: UsageLinkContext): `/${string}` {
  return links.several ? withUnit(path, links.tenantId) : path;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** "November 2026". */
function monthLabel(month: string, locale: string): string {
  return formatLocalDate(new Date(`${month}-15T12:00:00Z`), locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "Wednesday 18 November 2026". */
function longDate(date: string, locale: string): string {
  return formatLocalDate(new Date(`${date}T12:00:00Z`), locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "17 Nov 2026". */
function shortDate(date: string, locale: string): string {
  return formatLocalDate(new Date(`${date}T12:00:00Z`), locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * An instant's local time in the unit's zone, never the server's: "14:05".
 * On a day that is not 24 hours long the UTC offset is added ("01:00
 * GMT-4"), so the two 01:00 hours of a fall-back day can be told apart.
 * shortOffset, as src/components/format/timezone.tsx uses it, gives an
 * offset in every locale, where "short" gives a zone name in some.
 */
function clock(ms: number, timezone: string, locale: string, withOffset: boolean): string {
  return formatLocalDate(new Date(ms), locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
    ...(withOffset ? { timeZoneName: "shortOffset" } : {}),
  });
}

/** Whether the local day holding `ms` has other than 24 hours. */
function unusualDay(ms: number, timezone: string): boolean {
  return localHourStarts(dayKeyInZone(ms, timezone), timezone).length !== 24;
}

/** When the figures were read, in the unit's zone: "14:05". */
export function readTimeLabel(readAt: number, timezone: string, locale: string): string {
  return clock(readAt, timezone, locale, unusualDay(readAt, timezone));
}

/** "As read at 14:05." for kept figures (an earlier read), in the unit's zone; null for fresh ones. */
function staleNote(read: TenantUsageMonth["read"], timezone: string, locale: string): string | null {
  return read.stale && read.readAt !== null ? `As read at ${readTimeLabel(read.readAt, timezone, locale)}.` : null;
}

/** The unit's title, then why there are no figures, or when the kept ones were read. */
function subtitleOf(
  tenant: TenantUsageMonth["tenant"],
  read: TenantUsageMonth["read"],
  timezone: string,
  locale: string,
): string {
  const parts = [unitTitle(tenant)];
  const stale = staleNote(read, timezone, locale);
  if (read.problem) parts.push(TENANT_USAGE_PROBLEMS[read.problem].message);
  else if (stale) parts.push(stale);
  return parts.join(" · ");
}

function problemExt(read: TenantUsageMonth["read"]): TenantUsageMonthExtData["problem"] {
  return read.problem ? { kind: read.problem, ...TENANT_USAGE_PROBLEMS[read.problem] } : null;
}

/** When the figures were read, with the stale note a renderer prints; null when nothing was read. */
function readAtExt(read: TenantUsageMonth["read"], timezone: string, locale: string): TenantUsageMonthExtData["readAt"] {
  return read.readAt === null ? null : { at: iso(read.readAt), label: staleNote(read, timezone, locale) };
}

/** A day row's note: today so far, or no meter in force. */
function dayNote(d: TenantUsageBucket): string | null {
  return d.state === "partial" ? "So far today" : d.state === "no-meter" ? "No meter on this day" : null;
}

/**
 * An hour row's note: the hour that held the read shows its figure so far;
 * one begun since was not read yet, and is never counted as missing.
 */
function hourNote(h: TenantUsageBucket & { start: number }, read: TenantUsageDay["read"]): string | null {
  if (h.state !== "partial") return null;
  return read.readAt !== null && h.start > read.readAt ? "Not read yet" : "So far";
}

/** A bucket's use as a cell: the figure, "—" for a partial bucket with none yet, or "No data". */
function usageValue(bucket: TenantUsageBucket, o: Options, synthetic: boolean, digits: 1 | 2): Value {
  if ((bucket.state === "data" || bucket.state === "partial") && bucket.kwh !== null) {
    return o.fmt.energy(bucket.kwh * 1000, { digits, ...(synthetic ? { synthetic: true } : {}) });
  }
  if (bucket.state === "partial") return o.fmt.empty();
  return o.fmt.text(NO_DATA);
}

/** The text a renderer prints for a bucket: the cell's, or "" for a future one. */
function bucketText(bucket: TenantUsageBucket, o: Options, synthetic: boolean, digits: 1 | 2): string {
  return bucket.state === "future" ? "" : usageValue(bucket, o, synthetic, digits).text;
}

/**
 * "2 days missing", "1 hour missing": what a total leaves out.
 */
function missingNote(count: number, unit: [one: string, many: string]): string {
  return `${count} ${count === 1 ? unit[0] : unit[1]} missing`;
}

/**
 * The footer: the total, or "No data", with what it covers. A total with
 * gaps is the sum of the rest and its note says how many it leaves out
 * ("So far · 2 days missing"), so it is never read as the whole period's
 * use. On a problem the note is empty: the subtitle already says why.
 */
function totalCells(
  total: TenantUsageTotal,
  o: Options & {
    synthetic: boolean;
    current: boolean;
    problem: boolean;
    unit: [one: string, many: string];
    /** The rows' own decimals, so the total never rounds away what they show. */
    digits: 1 | 2;
  },
): { cells: Record<string, Value>; text: string; note: string } {
  const usage =
    total.kwh === null
      ? o.fmt.text(NO_DATA)
      : o.fmt.energy(total.kwh * 1000, { digits: o.digits, ...(o.synthetic ? { synthetic: true } : {}) });
  const note = o.problem
    ? ""
    : total.kwh !== null
      ? [o.current ? "So far" : "", total.withoutData > 0 ? missingNote(total.withoutData, o.unit) : ""]
          .filter(Boolean)
          .join(" · ")
      : total.withoutData > 0
        ? `No data for ${total.withoutData} ${total.withoutData === 1 ? o.unit[0] : o.unit[1]}`
        : "";
  return { cells: { usage, ...(note ? { note: o.fmt.text(note) } : {}) }, text: usage.text, note };
}

/**
 * The current month's use as the tenant home shows it (RFC mgm#197 § 3):
 * the month's total so far, or why there is none, and a note with what the
 * total leaves out and when a kept read was made. Built from the same
 * `getUsageMonth` result and copy as the month view, so the two never
 * disagree; `note` is null when there is nothing to add.
 */
export function monthSoFar(month: TenantUsageMonth, o: { fmt: Fmt; locale: string }): { value: Value; note: string | null } {
  const { read, total, timezone } = month;
  if (read.problem) return { value: o.fmt.text(NO_DATA), note: TENANT_USAGE_PROBLEMS[read.problem].message };
  if (read.readAt === null) return { value: o.fmt.text("No meter in use this month"), note: null };
  if (total.kwh === null) {
    return {
      value: o.fmt.text(NO_DATA),
      note: total.withoutData > 0 ? `No data for ${total.withoutData} ${total.withoutData === 1 ? "day" : "days"}` : null,
    };
  }
  const parts = [
    total.withoutData > 0 ? missingNote(total.withoutData, ["day", "days"]) : "",
    staleNote(read, timezone, o.locale) ?? "",
  ].filter(Boolean);
  return {
    value: o.fmt.energy(total.kwh * 1000, { digits: 1, ...(read.synthetic ? { synthetic: true } : {}) }),
    note: parts.length > 0 ? parts.join(" · ") : null,
  };
}

/** Shade tiers 1–4 relative to the highest figure; null without a figure. */
function tiers(values: (number | null)[]): (number | null)[] {
  const figures = values.filter((v): v is number => v !== null);
  const max = figures.length > 0 ? Math.max(...figures) : 0;
  return values.map((v) => (v === null ? null : max > 0 ? Math.min(4, Math.max(1, Math.ceil((4 * v) / max))) : 1));
}

const hasFigure = (b: TenantUsageBucket) => (b.state === "data" || b.state === "partial") && b.kwh !== null;

/** A month of the unit's use per day: one row per day up to today, and the calendar in the ext. */
export function buildUsageMonthModel(month: TenantUsageMonth, o: Options): LoadedModel<"collection"> {
  const { fmt, locale, links } = o;
  const { read, timezone } = month;
  const title = unitTitle(month.tenant);
  const synthetic = read.synthetic;
  const shown = month.days.filter((d) => d.state !== "future");
  const anyMeter = shown.some((d) => d.state !== "no-meter");

  const rows: Row[] = anyMeter
    ? shown.map((d) => {
        const note = dayNote(d);
        return {
          id: d.date,
          cells: {
            date: fmt.date(d.date),
            usage: usageValue(d, o, synthetic, 1),
            ...(note ? { note: fmt.text(note) } : {}),
          },
          actions: [],
        };
      })
    : [];
  const footer = totalCells(month.total, {
    ...o,
    synthetic,
    current: month.month === month.today.slice(0, 7),
    problem: read.problem !== null,
    unit: ["day", "days"],
    digits: 1,
  });

  const tier = tiers(month.days.map((d) => (hasFigure(d) ? d.kwh : null)));
  const first = new Date(`${month.month}-01T12:00:00Z`).getUTCDay();
  const ext: TenantUsageMonthExtData = {
    month: month.month,
    title: monthLabel(month.month, locale),
    today: month.today,
    timezone,
    href: monthHref(month.month, links),
    firstWeekday: (first + 6) % 7,
    previous:
      month.month > USAGE_EARLIEST_MONTH
        ? { month: month.previousMonth, label: monthLabel(month.previousMonth, locale), href: monthHref(month.previousMonth, links) }
        : null,
    next: month.nextMonth
      ? { month: month.nextMonth, label: monthLabel(month.nextMonth, locale), href: monthHref(month.nextMonth, links) }
      : null,
    days: month.days.map((d, i) => ({
      date: d.date,
      day: Number(d.date.slice(8, 10)),
      state: d.state,
      kwh: d.kwh,
      text: bucketText(d, o, synthetic, 1),
      note: dayNote(d),
      tier: tier[i],
      href: d.state === "future" ? null : dayHref(d.date, links),
    })),
    total: { kwh: month.total.kwh, text: footer.text, note: footer.note, withoutData: month.total.withoutData },
    synthetic,
    stale: read.stale,
    readAt: readAtExt(read, timezone, locale),
    problem: problemExt(read),
  };

  return {
    title: monthLabel(month.month, locale),
    subtitle: subtitleOf(month.tenant, read, timezone, locale),
    entity: { kind: "tenant", id: month.tenant.id, label: title },
    actions: [],
    body: {
      columns: [
        { key: "date", label: "Day", type: "date", priority: 1 },
        { key: "usage", label: "Use", type: "energy", priority: 1 },
        { key: "note", label: "Note", type: "text", priority: 2 },
      ],
      rows,
      ...(rows.length > 0 ? { totals: footer.cells } : {}),
      empty: anyMeter ? { title: NO_DATA } : { title: NO_DATA, text: "No meter of this unit was in use in this month." },
    },
    ext: { schema: TENANT_USAGE_MONTH_EXT_SCHEMA, data: ext },
  };
}

/** One day of the unit's use per hour: one row per hour up to now, and the bars in the ext. */
export function buildUsageDayModel(day: TenantUsageDay, o: Options): LoadedModel<"collection"> {
  const { fmt, locale, links } = o;
  const { read, timezone } = day;
  const title = unitTitle(day.tenant);
  const synthetic = read.synthetic;
  const withOffset = day.hours.length !== 24;
  const label = (start: number) => clock(start, timezone, locale, withOffset);
  const shown = day.hours.filter((h) => h.state !== "future");

  const rows: Row[] =
    day.meters > 0
      ? shown.map((h) => {
          const note = hourNote(h, read);
          return {
            id: iso(h.start),
            cells: {
              hour: fmt.text(label(h.start)),
              usage: usageValue(h, o, synthetic, 2),
              ...(note ? { note: fmt.text(note) } : {}),
            },
            actions: [],
          };
        })
      : [];
  const footer = totalCells(day.total, {
    ...o,
    synthetic,
    current: day.date === day.today,
    problem: read.problem !== null,
    unit: ["hour", "hours"],
    digits: 2,
  });
  const month = day.date.slice(0, 7);

  const ext: TenantUsageDayExtData = {
    date: day.date,
    title: longDate(day.date, locale),
    today: day.today,
    timezone,
    href: dayHref(day.date, links),
    previous:
      day.date > FIRST_DATE
        ? { date: day.previousDate, label: shortDate(day.previousDate, locale), href: dayHref(day.previousDate, links) }
        : null,
    next: day.nextDate ? { date: day.nextDate, label: shortDate(day.nextDate, locale), href: dayHref(day.nextDate, links) } : null,
    month: { month, label: monthLabel(month, locale), href: monthHref(month, links) },
    meters: day.meters,
    hours: day.hours.map((h) => ({
      start: iso(h.start),
      label: label(h.start),
      state: h.state,
      kwh: h.kwh,
      text: bucketText(h, o, synthetic, 2),
      note: hourNote(h, read),
    })),
    total: { kwh: day.total.kwh, text: footer.text, note: footer.note, withoutData: day.total.withoutData },
    synthetic,
    stale: read.stale,
    readAt: readAtExt(read, timezone, locale),
    problem: problemExt(read),
  };

  return {
    title: longDate(day.date, locale),
    subtitle: subtitleOf(day.tenant, read, timezone, locale),
    entity: { kind: "tenant", id: day.tenant.id, label: title },
    actions: [],
    body: {
      columns: [
        { key: "hour", label: "Hour", type: "text", priority: 1 },
        { key: "usage", label: "Use", type: "energy", priority: 1 },
        { key: "note", label: "Note", type: "text", priority: 2 },
      ],
      rows,
      ...(rows.length > 0 ? { totals: footer.cells } : {}),
      empty:
        day.meters > 0 ? { title: NO_DATA } : { title: NO_DATA, text: "No meter of this unit was in use on this day." },
    },
    ext: { schema: TENANT_USAGE_DAY_EXT_SCHEMA, data: ext },
  };
}
