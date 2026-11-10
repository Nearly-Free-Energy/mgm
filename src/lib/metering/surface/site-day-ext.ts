/**
 * The `metering.site-day@1` ext: what a bespoke renderer of the Operations
 * day needs beyond the tiles and the battery series, such as the chart's
 * bands, the evening strip and the footnotes.
 *
 * Strict objects at every depth and every array capped, so the host's ext
 * check (strictProblems in src/lib/gui/host/server/contribution-schema.ts)
 * passes it. The bands and the strip's segments are capped at one per bin
 * at the finest resolution on the longest day (MAX_DAY_BINS and
 * MAX_EVENING_BINS in ../site-operations.ts). computeSiteDay refuses a day
 * with more bins than those bounds, so any day it returns fits; if it stops
 * refusing them, these caps no longer hold. Every label is formatted on the server; a renderer formats
 * nothing. Times are ISO 8601 instants. A change to this shape is `@2`,
 * named by SITE_DAY_EXT_SCHEMA in ./site-day-model.ts (kept there so the
 * model, which a client component imports for formatDuration, needs no zod).
 */
import { z } from "zod";
import { isSameOriginPath } from "@/lib/gui/host/shared/href";
import { isSiteResolution, MAX_DAY_BINS, MAX_EVENING_BINS } from "../site-operations";

const iso = z.iso.datetime({ offset: true });
const label = (max: number) => z.string().max(max);
const range = z.strictObject({ start: iso, end: iso, label: label(16) });
const supply = z.enum(["battery", "battery_and_grid", "grid", "dark", "no_data"]);
const hours = z.number().min(0).max(25);
const tick = z.strictObject({ at: iso, label: label(8) });

const common = {
  date: z.iso.date(),
  today: z.iso.date(),
  timezone: label(64),
  /** The view's own path, with no query; a renderer adds ?date=YYYY-MM-DD. */
  dayHref: z.string().max(512).refine(isSameOriginPath),
  synthetic: z.boolean(),
};

export const SiteDayExt = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("day"),
    ...common,
    /** Today, read up to `readUntil` rather than to the day's end. */
    partial: z.boolean(),
    dayStart: iso,
    dayEnd: iso,
    readUntil: iso,
    eveningStart: iso,
    resolutionMinutes: z.number().int().positive().max(60).refine(isSiteResolution),
    /** "00", "03" … "24", at local hours. */
    hourMarks: z.array(tick).max(9),
    /** "18:00" … "24:00". */
    eveningTicks: z.array(tick).max(8),
    /** Null when the grid meter gave no reading. Each band is at least one bin. */
    cuts: z.array(range).max(MAX_DAY_BINS).nullable(),
    dark: z.array(range).max(MAX_DAY_BINS),
    /** One segment per change of supply, so at most one per evening bin. */
    evening: z.array(z.strictObject({ start: iso, end: iso, supply, label: label(80) })).max(MAX_EVENING_BINS),
    /** Supplies shown in the strip's key, in order: "No data" only when there was some. */
    legend: z.array(z.strictObject({ supply, label: label(32), hours: label(16) })).max(5),
    eveningHours: z.strictObject({ battery: hours, battery_and_grid: hours, grid: hours, dark: hours, no_data: hours }),
    sources: z.strictObject({
      battery: z.boolean(),
      gridMeter: z.boolean(),
      load: z.boolean(),
      pv: z.boolean(),
      houses: z.boolean(),
    }),
    thresholds: z.strictObject({ gridPresentMinV: z.number(), lowBatteryPct: z.number() }),
    /** The battery chart's accessible description. */
    chartLabel: label(400),
    /** Shown instead of the chart when no battery is registered. */
    chartEmpty: label(200).nullable(),
    /** The evening strip's accessible description. */
    eveningLabel: label(200),
    /** Shown instead of the strip before the evening window starts. */
    eveningEmpty: label(200).nullable(),
    /** The missing-data note, when there was missing data, and the definitions. */
    notes: z.array(label(800)).max(4),
  }),
  z.strictObject({
    state: z.literal("no-site-devices"),
    ...common,
    title: label(200),
    message: label(400),
  }),
]);

export type SiteDayExtData = z.infer<typeof SiteDayExt>;
