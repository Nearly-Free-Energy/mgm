/**
 * The part of the `metering.site-day@1` ext this renderer reads, as a narrow
 * structural type. The host has already parsed the ext strictly against its
 * schema (SiteDayExt in src/lib/metering/surface/site-day-ext.ts, which a GUI
 * package may not import), so this only checks the fields it uses are there.
 * Times arrive as ISO instants and are read here into milliseconds.
 */
import type { Json, ViewModel } from "@/lib/gui/contract";

export type Supply = "battery" | "battery_and_grid" | "grid" | "dark" | "no_data";
export type Span = { startMs: number; endMs: number; label: string };
export type Tick = { atMs: number; label: string };

/** What the battery chart and the evening strip draw from the ext; every label in it is the server's. */
export type DayChart = {
  dayStartMs: number;
  dayEndMs: number;
  readUntilMs: number;
  eveningStartMs: number;
  resolutionMinutes: number;
  hourMarks: Tick[];
  eveningTicks: Tick[];
  /** Null when the grid meter gave no reading. */
  cuts: Span[] | null;
  dark: Span[];
  evening: (Span & { supply: Supply })[];
  legend: { supply: Supply; label: string; hours: string }[];
  chartLabel: string;
  chartEmpty: string | null;
  eveningLabel: string;
  eveningEmpty: string | null;
};

/** The time zone nudge's warning, shown in every state; its link is the model's. */
export type TimezoneNotice = { title: string; text: string };

type Common = { date: string; today: string; timezone: string; dayHref: string; synthetic: boolean; timezoneNotice: TimezoneNotice | null };
export type SiteDayExt =
  | (Common & DayChart & { state: "day"; notes: string[] })
  | (Common & { state: "no-site-devices"; title: string; message: string })
  | (Common & { state: "problem"; tone: "warning" | "danger"; title: string; message: string; retry: boolean });

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SUPPLIES: readonly Json[] = ["battery", "battery_and_grid", "grid", "dark", "no_data"];

type Obj = { [key: string]: Json };
const isObject = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: Json | undefined): v is string => typeof v === "string";
const orNull = (v: Json | undefined) => (v === null ? null : isString(v) ? v : undefined);

/** An instant in milliseconds, or NaN. */
const ms = (v: Json | undefined) => (isString(v) ? Date.parse(v) : NaN);

/** Each item read by `read`, or null when the value is not an array or any item fails. */
function list<T>(v: Json | undefined, read: (o: Obj) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const got = isObject(item) ? read(item) : null;
    if (got === null) return null;
    out.push(got);
  }
  return out;
}

const tick = (o: Obj): Tick | null => (isString(o.label) && !Number.isNaN(ms(o.at)) ? { atMs: ms(o.at), label: o.label } : null);
function span(o: Obj): Span | null {
  const startMs = ms(o.start);
  const endMs = ms(o.end);
  return isString(o.label) && !Number.isNaN(startMs) && !Number.isNaN(endMs) ? { startMs, endMs, label: o.label } : null;
}
const isSupply = (v: Json | undefined): v is Supply => SUPPLIES.includes(v ?? null);

function readChart(d: Obj): DayChart | null {
  const [dayStartMs, dayEndMs, readUntilMs, eveningStartMs] = [d.dayStart, d.dayEnd, d.readUntil, d.eveningStart].map(ms);
  if ([dayStartMs, dayEndMs, readUntilMs, eveningStartMs].some(Number.isNaN) || dayEndMs <= dayStartMs || dayEndMs <= eveningStartMs) return null;
  if (typeof d.resolutionMinutes !== "number" || !(d.resolutionMinutes > 0)) return null;
  const hourMarks = list(d.hourMarks, tick);
  const eveningTicks = list(d.eveningTicks, tick);
  const cuts = d.cuts === null ? null : list(d.cuts, span);
  const dark = list(d.dark, span);
  const evening = list(d.evening, (o) => {
    const s = span(o);
    return s && isSupply(o.supply) ? { ...s, supply: o.supply } : null;
  });
  const legend = list(d.legend, (o) =>
    isSupply(o.supply) && isString(o.label) && isString(o.hours) ? { supply: o.supply, label: o.label, hours: o.hours } : null,
  );
  const chartEmpty = orNull(d.chartEmpty);
  const eveningEmpty = orNull(d.eveningEmpty);
  if (!hourMarks || !eveningTicks || (d.cuts !== null && !cuts) || !dark || !evening || !legend) return null;
  if (!isString(d.chartLabel) || !isString(d.eveningLabel) || chartEmpty === undefined || eveningEmpty === undefined) return null;
  return {
    dayStartMs, dayEndMs, readUntilMs, eveningStartMs, resolutionMinutes: d.resolutionMinutes,
    hourMarks, eveningTicks, cuts, dark, evening, legend,
    chartLabel: d.chartLabel, chartEmpty, eveningLabel: d.eveningLabel, eveningEmpty,
  };
}

/** The notice, null when there is none, or undefined when it is malformed. */
function readNotice(v: Json | undefined): TimezoneNotice | null | undefined {
  if (v === null) return null;
  return isObject(v) && isString(v.title) && isString(v.text) ? { title: v.title, text: v.text } : undefined;
}

/** The ext, or null when it is missing or lacks a field this renderer reads. */
export function readSiteDayExt(ext: ViewModel["ext"]): SiteDayExt | null {
  const d = ext?.data;
  if (!isObject(d) || !isString(d.date) || !isString(d.today) || !DATE.test(d.date) || !DATE.test(d.today)) return null;
  if (!isString(d.timezone) || !isString(d.dayHref) || !d.dayHref.startsWith("/") || typeof d.synthetic !== "boolean") return null;
  const timezoneNotice = readNotice(d.timezoneNotice);
  if (timezoneNotice === undefined) return null;
  const common: Common = { date: d.date, today: d.today, timezone: d.timezone, dayHref: d.dayHref, synthetic: d.synthetic, timezoneNotice };
  if (d.state === "day" && Array.isArray(d.notes) && d.notes.every(isString)) {
    const chart = readChart(d);
    return chart && { ...common, ...chart, state: "day", notes: d.notes };
  }
  if (d.state === "no-site-devices" && isString(d.title) && isString(d.message)) {
    return { ...common, state: "no-site-devices", title: d.title, message: d.message };
  }
  if (d.state === "problem" && (d.tone === "warning" || d.tone === "danger") && isString(d.title) && isString(d.message) && typeof d.retry === "boolean") {
    return { ...common, state: "problem", tone: d.tone, title: d.title, message: d.message, retry: d.retry };
  }
  return null;
}

/** Joins class names; not ../../ui/cx, for the reason ./renderer.tsx gives. */
export const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
