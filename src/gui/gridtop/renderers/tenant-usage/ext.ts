/**
 * The parts of the `tenant.usage-month@1` and `tenant.usage-day@1` exts this
 * renderer reads, as narrow structural types, and the join of each ext to
 * its model's rows. The host has already parsed each ext strictly against
 * its schema (src/lib/tenant-app/surface/usage-ext.ts, which a GUI package
 * may not import), so this only checks that the fields it uses are there
 * and hold together: any doubt returns null, and the view is drawn by the
 * kit instead.
 *
 * Pure TypeScript with no React, so a node test outside this package
 * (src/lib/tenant-app/__tests__/usage-gridtop.test.ts) runs it over the
 * server's own examples.
 */
import type { Href, Json, ModelOf, ViewModel } from "@/lib/gui/contract";

export type UsageState = "data" | "partial" | "no-data" | "no-meter" | "future";
/** A previous, next or month step: the server's label and the page it opens. */
export type Step = { label: string; href: Href };
export type Total = { text: string; note: string };
export type Problem = { kind: "unavailable" | "limited" | "not-offered"; title: string; message: string };
type Read = { synthetic: boolean; stale: boolean; problem: Problem | null };

export type MonthDay = { date: string; day: number; state: UsageState; text: string; tier: 1 | 2 | 3 | 4 | null; href: Href | null };
export type MonthExt = Read & {
  month: string;
  title: string;
  today: string;
  /** Weekday of the 1st, Monday 0 … Sunday 6. */
  firstWeekday: number;
  previous: Step | null;
  next: Step | null;
  days: MonthDay[];
  total: Total;
};

export type DayHour = { start: string; label: string; state: UsageState; kwh: number | null; text: string };
export type DayExt = Read & {
  date: string;
  title: string;
  previous: Step | null;
  next: Step | null;
  month: Step;
  meters: number;
  hours: DayHour[];
  total: Total;
};

export type Row = ModelOf<"collection">["body"]["rows"][number];
/** A model whose ext was read and whose rows match its buckets one to one. */
export type Joined<E> = { model: ModelOf<"collection">; ext: E; rowOf(key: string): Row | undefined };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const STATES: readonly Json[] = ["data", "partial", "no-data", "no-meter", "future"];
const PROBLEMS: readonly Json[] = ["unavailable", "limited", "not-offered"];

type Obj = { [key: string]: Json };
const isObject = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: Json | undefined): v is string => typeof v === "string";
const isState = (v: Json | undefined): v is UsageState => STATES.includes(v ?? null);

/**
 * A same-origin path this page may link to, or null: a string starting with
 * "/" that is not "//" and holds no backslash or control character. The
 * host checks every href it hands out the same way (isSameOriginPath in
 * src/lib/gui/host/shared/href.ts, which this chunk may not import); the
 * ext's hrefs are data the host does not check, so they are checked here.
 */
export function pageHref(v: Json | undefined): Href | null {
  if (!isString(v) || !v.startsWith("/") || v.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(v)) return null;
  return v as Href;
}

/** Each item read by `read`, or null when the value is not an array or any item fails. */
function list<T>(v: Json | undefined, read: (o: Obj, i: number) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const [i, item] of v.entries()) {
    const got = isObject(item) ? read(item, i) : null;
    if (got === null) return null;
    out.push(got);
  }
  return out;
}

/** A step, null when there is none, or undefined when it is malformed. */
function step(v: Json | undefined): Step | null | undefined {
  if (v === null) return null;
  const href = isObject(v) ? pageHref(v.href) : null;
  return isObject(v) && isString(v.label) && href ? { label: v.label, href } : undefined;
}

function total(v: Json | undefined): Total | null {
  return isObject(v) && isString(v.text) && isString(v.note) ? { text: v.text, note: v.note } : null;
}

/** The read's flags and problem, or null when malformed. An unknown problem kind is a new shape (`@2`), so it fails. */
function read(d: Obj): Read | null {
  if (typeof d.synthetic !== "boolean" || typeof d.stale !== "boolean") return null;
  const p = d.problem;
  if (p === null) return { synthetic: d.synthetic, stale: d.stale, problem: null };
  if (!isObject(p) || !PROBLEMS.includes(p.kind ?? null) || !isString(p.title) || !isString(p.message)) return null;
  return { synthetic: d.synthetic, stale: d.stale, problem: { kind: p.kind as Problem["kind"], title: p.title, message: p.message } };
}

const isTier = (v: Json | undefined): v is 1 | 2 | 3 | 4 => v === 1 || v === 2 || v === 3 || v === 4;

/** The month ext, or null when it is missing or lacks a field this renderer reads. */
export function readUsageMonthExt(ext: ViewModel["ext"]): MonthExt | null {
  const d = ext?.data;
  if (!isObject(d) || !isString(d.month) || !MONTH.test(d.month) || !isString(d.title)) return null;
  if (!isString(d.today) || !DATE.test(d.today)) return null;
  const firstWeekday = d.firstWeekday;
  if (typeof firstWeekday !== "number" || !Number.isInteger(firstWeekday) || firstWeekday < 0 || firstWeekday > 6) return null;
  const previous = step(d.previous);
  const next = step(d.next);
  const flags = read(d);
  const sum = total(d.total);
  const month = d.month;
  const days = list(d.days, (o, i): MonthDay | null => {
    if (!isString(o.date) || !DATE.test(o.date) || !o.date.startsWith(`${month}-`) || o.day !== i + 1) return null;
    if (!isState(o.state) || !isString(o.text) || !(o.tier === null || isTier(o.tier))) return null;
    // A day up to today is drawn as a link to its page; a future day links nowhere.
    const href = o.state === "future" ? null : pageHref(o.href);
    if (o.state !== "future" && !href) return null;
    return { date: o.date, day: i + 1, state: o.state, text: o.text, tier: o.tier, href };
  });
  if (previous === undefined || next === undefined || !flags || !sum || !days || days.length < 28 || days.length > 31) return null;
  return { month, title: d.title, today: d.today, firstWeekday, previous, next, days, total: sum, ...flags };
}

/** The day ext, or null when it is missing or lacks a field this renderer reads. */
export function readUsageDayExt(ext: ViewModel["ext"]): DayExt | null {
  const d = ext?.data;
  if (!isObject(d) || !isString(d.date) || !DATE.test(d.date) || !isString(d.title)) return null;
  if (typeof d.meters !== "number" || !Number.isInteger(d.meters) || d.meters < 0) return null;
  const previous = step(d.previous);
  const next = step(d.next);
  const month = step(d.month);
  const flags = read(d);
  const sum = total(d.total);
  const hours = list(d.hours, (o): DayHour | null => {
    const at = isString(o.start) ? Date.parse(o.start) : NaN;
    if (Number.isNaN(at) || !isString(o.label) || !isState(o.state) || !isString(o.text)) return null;
    if (!(o.kwh === null || (typeof o.kwh === "number" && Number.isFinite(o.kwh) && o.kwh >= 0))) return null;
    return { start: new Date(at).toISOString(), label: o.label, state: o.state, kwh: o.kwh, text: o.text };
  });
  if (previous === undefined || next === undefined || !month || !flags || !sum || !hours || hours.length < 23 || hours.length > 25) return null;
  return { date: d.date, title: d.title, previous, next, month, meters: d.meters, hours, total: sum, ...flags };
}

/**
 * The rows by id when they match the buckets up to now one to one, or null.
 * Either there are no rows, or each row's id is the key of exactly one
 * bucket that is not in the future and each such bucket has a row; a
 * missing, extra or doubled row means the model does not hold together,
 * and the kit's view, which shows every row, draws it instead. A row with
 * actions or links of its own has nowhere to go here, so it falls back too.
 */
function join(model: ModelOf<"collection">, keys: string[], cells: string[]): Map<string, Row> | null {
  const { rows } = model.body;
  const byId = new Map<string, Row>();
  for (const row of rows) {
    if (byId.has(row.id) || row.actions.length > 0 || (row.links?.length ?? 0) > 0) return null;
    if (!cells.every((key) => row.cells[key] !== undefined)) return null;
    byId.set(row.id, row);
  }
  if (rows.length === 0) return byId;
  if (keys.length !== byId.size || !keys.every((key) => byId.has(key))) return null;
  return byId;
}

// The row ids are the ext's `date` (a month) and `start` (a day), as
// buildUsageMonthModel and buildUsageDayModel set them
// (src/lib/tenant-app/surface/usage-model.ts, both from toISOString for an
// hour); if they change, revisit.

/** The month model, read and joined, or null when the kit's view should draw it. */
export function readUsageMonth(model: ViewModel): Joined<MonthExt> | null {
  if (model.kind !== "collection") return null;
  const ext = readUsageMonthExt(model.ext);
  const rows = ext && join(model, ext.days.filter((d) => d.state !== "future").map((d) => d.date), ["date", "usage"]);
  return ext && rows ? { model, ext, rowOf: (key) => rows.get(key) } : null;
}

/** The day model, read and joined, or null when the kit's view should draw it. */
export function readUsageDay(model: ViewModel): Joined<DayExt> | null {
  if (model.kind !== "collection") return null;
  const ext = readUsageDayExt(model.ext);
  const rows = ext && join(model, ext.hours.filter((h) => h.state !== "future").map((h) => h.start), ["hour", "usage"]);
  return ext && rows ? { model, ext, rowOf: (key) => rows.get(key) } : null;
}

/** Joins class names; not ../../ui/cx, for the reason ./renderer.tsx gives. */
export const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
