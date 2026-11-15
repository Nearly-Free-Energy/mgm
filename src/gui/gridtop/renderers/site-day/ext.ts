/**
 * The part of the `metering.site-day@1` ext this renderer reads, as a narrow
 * structural type. The host has already parsed the ext strictly against its
 * schema (SiteDayExt in src/lib/metering/surface/site-day-ext.ts, which a GUI
 * package may not import), so this only checks the fields it uses are there.
 * The battery chart and the evening strip read more of it.
 */
import type { Json, ViewModel } from "@/lib/gui/contract";

type Common = { date: string; today: string; timezone: string; dayHref: string; synthetic: boolean };
export type SiteDayExt =
  | (Common & { state: "day"; notes: string[] })
  | (Common & { state: "no-site-devices"; title: string; message: string });

export const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (v: Json | undefined): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: Json | undefined): v is string => typeof v === "string";

/** The ext, or null when it is missing or lacks a field this renderer reads. */
export function readSiteDayExt(ext: ViewModel["ext"]): SiteDayExt | null {
  const d = ext?.data;
  if (!isObject(d) || !isString(d.date) || !isString(d.today) || !DATE.test(d.date) || !DATE.test(d.today)) return null;
  if (!isString(d.timezone) || !isString(d.dayHref) || !d.dayHref.startsWith("/") || typeof d.synthetic !== "boolean") return null;
  const common: Common = { date: d.date, today: d.today, timezone: d.timezone, dayHref: d.dayHref, synthetic: d.synthetic };
  if (d.state === "day" && Array.isArray(d.notes) && d.notes.every(isString)) return { ...common, state: "day", notes: d.notes };
  if (d.state === "no-site-devices" && isString(d.title) && isString(d.message)) {
    return { ...common, state: "no-site-devices", title: d.title, message: d.message };
  }
  return null;
}

/** Joins class names; not ../../ui/cx, for the reason ./renderer.tsx gives. */
export const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
