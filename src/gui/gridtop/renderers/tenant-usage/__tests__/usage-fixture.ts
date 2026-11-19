/**
 * Hand-built `tenant.usage-month@1` and `tenant.usage-day@1` models, shaped
 * as buildUsageMonthModel and buildUsageDayModel build them
 * (src/lib/tenant-app/surface/usage-model.ts, which these tests may not
 * import), with the fields the host fills for a tenant view. The month is
 * November 2026 with today the 18th; the day is the 18th in Kampala, 23 and
 * 25 hour days in New York, and each period for a person with several units.
 *
 * The real builder's output (Kampala, the 23 and 25 hour New York days and a
 * several-unit month) is checked against this renderer's reader and join by
 * src/lib/tenant-app/__tests__/usage-gridtop.test.ts and drawn through
 * Gridtop by src/lib/gui/__tests__/view-examples.test.tsx. Neither compares
 * this fixture's copy or totals with the builder's, so a change there
 * (totalCells, dayNote and the problem messages in usage-model.ts) is copied
 * here by hand.
 */
import type { Href, Json, LinkRef, ModelOf, Value } from "@/lib/gui/contract";

/** A uuid, so the host's merge offers acme.poke on the unit. */
export const UNIT = "00000000-0000-4000-8000-0000000000b4";
export const OTHER_UNIT = "00000000-0000-4000-8000-0000000000b7";
export const TODAY = "2026-11-18";
export const SYNTHETIC_NOTICE = { tone: "warning", text: "Synthetic data: these figures are generated for demonstration, not measured." } as const;
export const PROBLEMS = {
  unavailable: { title: "No data", message: "Your meter readings could not be read right now. Try again in a minute." },
  limited: { title: "No data", message: "Your use has been asked for many times in the last minute. Try again in a minute." },
  "not-offered": { title: "No data", message: "Your meter readings are not available here." },
} as const;
export type ProblemKind = keyof typeof PROBLEMS;

type State = "data" | "partial" | "no-data" | "no-meter" | "future";
type Bucket = { key: string; state: State; kwh: number | null };
type Row = ModelOf<"collection">["body"]["rows"][number];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const text = (t: string): Value => ({ t: "text", text: t });
const dash: Value = { t: "empty", text: "—" };
const energy = (kwh: number, digits: number, synthetic: boolean): Value => ({
  t: "energy",
  v: kwh,
  unit: "kWh",
  text: `${kwh.toFixed(digits)} kWh`,
  ...(synthetic ? { synthetic: true as const } : {}),
});

const utcDate = (date: string) => new Date(`${date}T12:00:00Z`);
const shortDate = (date: string) => `${Number(date.slice(8))} ${SHORT[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const longDate = (date: string) => `${WEEKDAYS[utcDate(date).getUTCDay()]} ${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const addDays = (date: string, n: number) => new Date(utcDate(date).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (month: string, n: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

type Links = { several: boolean };
const withUnit = (href: string, links: Links): Href => (links.several ? (`${href}&unit=${OTHER_UNIT}` as Href) : (href as Href));
export const monthHref = (month: string, links: Links = { several: false }) => withUnit(`/my/usage?month=${month}`, links);
export const dayHref = (date: string, links: Links = { several: false }) => withUnit(`/my/usage/day?date=${date}`, links);

const hasFigure = (b: Bucket) => (b.state === "data" || b.state === "partial") && b.kwh !== null;
function tiers(buckets: Bucket[]): (1 | 2 | 3 | 4 | null)[] {
  const max = Math.max(0, ...buckets.filter(hasFigure).map((b) => b.kwh!));
  return buckets.map((b) => (hasFigure(b) ? (max > 0 ? (Math.min(4, Math.max(1, Math.ceil((4 * b.kwh!) / max))) as 1 | 2 | 3 | 4) : 1) : null));
}

function usageValue(b: Bucket, synthetic: boolean, digits: number): Value {
  if (hasFigure(b)) return energy(b.kwh!, digits, synthetic);
  if (b.state === "partial") return dash;
  return text("No data");
}

/**
 * The footer as the builder writes it (totalOf and totalCells): the sum of
 * the buckets that have a figure, to 2 decimals under 1 kWh, with what it
 * leaves out ("So far · 1 day missing"); "No data" only when no bucket has a
 * figure, or on a problem.
 */
function footer(buckets: Bucket[], o: { synthetic: boolean; current: boolean; problem: boolean; unit: [string, string]; digits: number }) {
  const withoutData = buckets.filter((b) => b.state === "no-data").length;
  const figures = buckets.filter(hasFigure);
  const kwh = o.problem || figures.length === 0 ? null : Math.round(figures.reduce((sum, b) => sum + b.kwh! * 1000, 0)) / 1000;
  const usage = kwh === null ? text("No data") : energy(kwh, kwh < 1 ? 2 : o.digits, o.synthetic);
  const count = (n: number) => `${n} ${n === 1 ? o.unit[0] : o.unit[1]}`;
  const note = o.problem
    ? ""
    : kwh !== null
      ? [o.current ? "So far" : "", withoutData > 0 ? `${count(withoutData)} missing` : ""].filter(Boolean).join(" · ")
      : withoutData > 0
        ? `No data for ${count(withoutData)}`
        : "";
  return { cells: { usage, ...(note ? { note: text(note) } : {}) }, ext: { kwh, text: usage.text, note, withoutData } };
}

type Common = {
  synthetic?: boolean;
  /** Adds the host's synthetic notice; on by default with `synthetic`. */
  notice?: boolean;
  stale?: boolean;
  problem?: ProblemKind;
  several?: boolean;
  links?: LinkRef[];
  /** Merged over the ext's data. */
  ext?: Record<string, Json | undefined>;
  schema?: `${string}.${string}@${number}`;
};

function subtitle(label: string, o: Common) {
  if (o.problem) return `${label} · ${PROBLEMS[o.problem].message}`;
  if (o.stale) return `${label} · As read at 14:20.`;
  return label;
}

function base(view: "tenant.usage-month" | "tenant.usage-day", title: string, o: Common & { label: string }) {
  return {
    type: "view" as const,
    view,
    kind: "collection" as const,
    title,
    subtitle: subtitle(o.label, o),
    org: null,
    entity: { kind: "tenant" as const, id: UNIT, label: o.label },
    trail: [],
    actions: [],
    links: o.links ?? [],
    attached: [],
    ...((o.notice ?? o.synthetic) && o.synthetic ? { notice: { ...SYNTHETIC_NOTICE } } : {}),
  };
}

const readExt = (o: Common) => ({
  synthetic: o.synthetic ?? false,
  stale: o.stale ?? false,
  // As the server's readAtExt sets it: the instant, and the label the subtitle prints while stale.
  readAt: o.problem ? null : { at: o.stale ? "2026-11-18T11:20:00.000Z" : "2026-11-18T11:30:00.000Z", label: o.stale ? "As read at 14:20." : null },
  problem: o.problem ? { kind: o.problem, ...PROBLEMS[o.problem] } : null,
});

/** A day's use in the month: between 2 and 4.25 kWh, from the day of the month. */
const dailyKwh = (day: number) => 2 + ((day * 7) % 10) / 4;

export type MonthOptions = Common & {
  month?: string;
  /** Day 10 not read: the total sums the other days and says one is missing. */
  gap?: boolean;
  /** The unit's first meter arrives on this day; earlier days have no meter. */
  meterFrom?: number;
  /** No meter in the whole month: no rows. */
  noMeter?: boolean;
  previous?: null;
};

export function monthModel(o: MonthOptions = {}): ModelOf<"collection"> {
  const month = o.month ?? TODAY.slice(0, 7);
  const links = { several: o.several ?? false };
  const label = o.several ? "Unit 7" : "Unit 4";
  const current = month === TODAY.slice(0, 7);
  const buckets: Bucket[] = Array.from({ length: daysIn(month) }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    const day = i + 1;
    if (date > TODAY) return { key: date, state: "future", kwh: null };
    if (o.noMeter || (o.meterFrom && day < o.meterFrom)) return { key: date, state: "no-meter", kwh: null };
    if (o.problem || (o.gap && day === 10)) return { key: date, state: "no-data", kwh: null };
    if (date === TODAY) return { key: date, state: "partial", kwh: 1.86 };
    return { key: date, state: "data", kwh: dailyKwh(day) };
  });
  const synthetic = o.synthetic ?? false;
  const shown = buckets.filter((b) => b.state !== "future");
  const rows: Row[] = o.noMeter
    ? []
    : shown.map((b) => {
        const note = b.state === "partial" ? "So far today" : b.state === "no-meter" ? "No meter on this day" : null;
        return {
          id: b.key,
          cells: { date: { t: "date", v: b.key, text: shortDate(b.key) }, usage: usageValue(b, synthetic, 1), ...(note ? { note: text(note) } : {}) },
          actions: [],
        };
      });
  const total = footer(buckets, { synthetic, current, problem: o.problem !== undefined, unit: ["day", "days"], digits: 1 });
  const tier = tiers(buckets);
  const previous = addMonths(month, -1);
  const next = current ? null : addMonths(month, 1);
  const first = (new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)).getUTCDay() + 6) % 7;
  const data: Record<string, Json | undefined> = {
    month,
    title: monthLabel(month),
    today: TODAY,
    timezone: "Africa/Kampala",
    href: monthHref(month, links),
    firstWeekday: first,
    previous: o.previous === null ? null : { month: previous, label: monthLabel(previous), href: monthHref(previous, links) },
    next: next ? { month: next, label: monthLabel(next), href: monthHref(next, links) } : null,
    days: buckets.map((b, i) => ({
      date: b.key,
      day: i + 1,
      state: b.state,
      kwh: b.kwh,
      text: b.state === "future" ? "" : usageValue(b, synthetic, 1).text,
      note: b.state === "partial" ? "So far today" : b.state === "no-meter" ? "No meter on this day" : null,
      tier: tier[i],
      href: b.state === "future" ? null : dayHref(b.key, links),
    })),
    total: total.ext,
    ...readExt(o),
    ...o.ext,
  };
  return {
    ...base("tenant.usage-month", monthLabel(month), { ...o, label }),
    body: {
      columns: [
        { key: "date", label: "Day", type: "date", priority: 1 },
        { key: "usage", label: "Use", type: "energy", priority: 1 },
        { key: "note", label: "Note", type: "text", priority: 2 },
      ],
      rows,
      ...(rows.length > 0 ? { totals: total.cells } : {}),
      empty: o.noMeter ? { title: "No data", text: "No meter of this unit was in use in this month." } : { title: "No data" },
    },
    ext: { schema: o.schema ?? "tenant.usage-month@1", data: data as Json },
  };
}

/** An hour's use: between 0.05 and 0.32 kWh. */
const hourlyKwh = (i: number) => 0.05 + ((i * 5) % 10) * 0.03;

type Clock = { start: string; label: string };

/** The hours of a day: 24 in Kampala (UTC+3), or New York's 23 and 25 hour days, with offsets as the server labels them. */
function clocks(date: string, zone: "kampala" | "dst23" | "dst25"): Clock[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (zone === "kampala") {
    const start = Date.parse(`${addDays(date, -1)}T21:00:00Z`);
    return Array.from({ length: 24 }, (_, i) => ({ start: new Date(start + i * 3_600_000).toISOString(), label: `${pad(i)}:00` }));
  }
  if (zone === "dst23") {
    // 8 March 2026: 02:00 EST becomes 03:00 EDT.
    const start = Date.parse("2026-03-08T05:00:00Z");
    return Array.from({ length: 23 }, (_, i) => ({
      start: new Date(start + i * 3_600_000).toISOString(),
      label: i < 2 ? `${pad(i)}:00 GMT-5` : `${pad(i + 1)}:00 GMT-4`,
    }));
  }
  // 1 November 2026: 02:00 EDT becomes 01:00 EST, so 01:00 comes twice.
  const start = Date.parse("2026-11-01T04:00:00Z");
  return Array.from({ length: 25 }, (_, i) => ({
    start: new Date(start + i * 3_600_000).toISOString(),
    label: i < 2 ? `${pad(i)}:00 GMT-4` : `${pad(i - 1)}:00 GMT-5`,
  }));
}

export type DayOptions = Common & {
  /** New York's 23 or 25 hour day; Kampala's 18 November otherwise. */
  zone?: "dst23" | "dst25";
  /** No meter in force: no rows. */
  meters?: 0;
  /** This hour (0–13) not read: the total sums the others and says one is missing. */
  gapHour?: number;
  next?: null;
};

export function dayModel(o: DayOptions = {}): ModelOf<"collection"> {
  const zone = o.zone ?? "kampala";
  const date = zone === "dst23" ? "2026-03-08" : zone === "dst25" ? "2026-11-01" : TODAY;
  const links = { several: o.several ?? false };
  const label = o.several ? "Unit 7" : "Unit 4";
  const isToday = date === TODAY;
  const synthetic = o.synthetic ?? false;
  const hours = clocks(date, zone);
  const buckets: (Bucket & { note: string | null })[] = hours.map((h, i) => {
    if (isToday && i > 15) return { key: h.start, state: "future", kwh: null, note: null };
    if (o.meters === 0) return { key: h.start, state: "no-meter", kwh: null, note: null };
    if (o.problem || i === o.gapHour) return { key: h.start, state: "no-data", kwh: null, note: null };
    if (isToday && i === 14) return { key: h.start, state: "partial", kwh: 0.05, note: "So far" };
    if (isToday && i === 15) return { key: h.start, state: "partial", kwh: null, note: "Not read yet" };
    return { key: h.start, state: "data", kwh: hourlyKwh(i), note: null };
  });
  const rows: Row[] =
    o.meters === 0
      ? []
      : buckets
          .map((b, i) => ({ b, h: hours[i] }))
          .filter(({ b }) => b.state !== "future")
          .map(({ b, h }) => ({
            id: b.key,
            cells: { hour: text(h.label), usage: usageValue(b, synthetic, 2), ...(b.note ? { note: text(b.note) } : {}) },
            actions: [],
          }));
  const total = footer(buckets, { synthetic, current: isToday, problem: o.problem !== undefined, unit: ["hour", "hours"], digits: 2 });
  const month = date.slice(0, 7);
  const previous = addDays(date, -1);
  const next = isToday || o.next === null ? null : addDays(date, 1);
  const data: Record<string, Json | undefined> = {
    date,
    title: longDate(date),
    today: TODAY,
    timezone: zone === "kampala" ? "Africa/Kampala" : "America/New_York",
    href: dayHref(date, links),
    previous: { date: previous, label: shortDate(previous), href: dayHref(previous, links) },
    next: next ? { date: next, label: shortDate(next), href: dayHref(next, links) } : null,
    month: { month, label: monthLabel(month), href: monthHref(month, links) },
    meters: o.meters ?? 1,
    hours: buckets.map((b, i) => ({
      start: b.key,
      label: hours[i].label,
      state: b.state,
      kwh: b.kwh,
      text: b.state === "future" ? "" : usageValue(b, synthetic, 2).text,
      note: b.note,
    })),
    total: total.ext,
    ...readExt(o),
    ...o.ext,
  };
  return {
    ...base("tenant.usage-day", longDate(date), { ...o, label }),
    body: {
      columns: [
        { key: "hour", label: "Hour", type: "text", priority: 1 },
        { key: "usage", label: "Use", type: "energy", priority: 1 },
        { key: "note", label: "Note", type: "text", priority: 2 },
      ],
      rows,
      ...(rows.length > 0 ? { totals: total.cells } : {}),
      empty: o.meters === 0 ? { title: "No data", text: "No meter of this unit was in use on this day." } : { title: "No data" },
    },
    ext: { schema: o.schema ?? "tenant.usage-day@1", data: data as Json },
  };
}

/** The model with its rows no longer matching its buckets one to one. */
export function mismatch(model: ModelOf<"collection">, how: "missing" | "extra" | "future" | "duplicate"): ModelOf<"collection"> {
  const rows = model.body.rows;
  const [first] = rows;
  const days = (model.ext!.data as { days?: { date: string; state: string }[]; hours?: { start: string; state: string }[] });
  const future = (days.days?.find((d) => d.state === "future")?.date ?? days.hours?.find((h) => h.state === "future")?.start)!;
  const changed =
    how === "missing"
      ? rows.slice(1)
      : how === "extra"
        ? [...rows, { ...first, id: "1999-01-01" }]
        : how === "future"
          ? [...rows, { ...first, id: future }]
          : [...rows, first];
  return { ...model, body: { ...model.body, rows: changed } };
}

/** A month or day model with one ext field replaced. */
export const withExt = (model: ModelOf<"collection">, data: Record<string, Json | undefined>): ModelOf<"collection"> => ({
  ...model,
  ext: { ...model.ext!, data: { ...(model.ext!.data as Record<string, Json>), ...data } as Json },
});
