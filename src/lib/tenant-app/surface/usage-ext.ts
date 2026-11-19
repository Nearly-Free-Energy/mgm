/**
 * The `tenant.usage-month@1` and `tenant.usage-day@1` exts: what a bespoke
 * renderer of a tenant's calendar and day needs beyond the rows, such as
 * every day of the month (future ones too) with its state, figure and shade
 * tier, the weekday the month starts on, and where the previous, next and
 * current periods are (RFC mgm#197 § 4).
 *
 * The hrefs here are data: the host's model parse checks no href under
 * `ext` (DATA_KEYS in @/lib/gui/host/server/parse), so they may name the
 * /my pages before they are released (RFC mgm#197: released by PR 5). If
 * that parse starts checking hrefs inside an ext, these are refused until
 * the pages are released. Each is a same-origin path the renderer still
 * checks before following it. The models carry no LinkRef or row href to
 * those pages until then.
 *
 * Strict objects at every depth and every array capped, so the host's ext
 * check (strictProblems in @/lib/gui/host/server/contribution-schema) passes
 * it. Every label is formatted on the server; a renderer formats nothing.
 * Times are ISO 8601 instants. Field names carry no word the GUI surface
 * test reads as a secret. A change to either shape after a renderer reads
 * it is `@2`, named by the constants in ./usage-model.ts.
 */
import { z } from "zod";
import { isSameOriginPath } from "@/lib/gui/host/shared/href";

const href = z.string().max(512).refine(isSameOriginPath);
const kwh = z.number().nonnegative().nullable();
const label = (max: number) => z.string().max(max);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const instant = z.iso.datetime({ offset: true });
const state = z.enum(["data", "partial", "no-data", "no-meter", "future"]);
/** Why the view shows no figures: the copy is TENANT_USAGE_PROBLEMS' (./usage-model.ts). */
const problem = z
  .strictObject({ kind: z.enum(["unavailable", "limited", "not-offered"]), title: label(40), message: label(200) })
  .nullable();
const total = (buckets: number) =>
  z.strictObject({
    kwh,
    /** The total as the rows' footer prints it: "54.3 kWh", or "No data". */
    text: label(32),
    /** "So far", "No data for 2 days", or "". */
    note: label(40),
    /** Buckets with a meter in force and no figure: why `kwh` is null. */
    withoutData: z.number().int().min(0).max(buckets),
  });
const read = {
  /** Generated, not measured (the synthetic metering provider). */
  synthetic: z.boolean(),
  /** The figures are an earlier read, served because the unit is over its read limit. */
  stale: z.boolean(),
  /** When the metering source was read; null when nothing was read. */
  readAt: instant.nullable(),
  problem,
};

export const TenantUsageMonthExt = z.strictObject({
  month,
  /** "November 2026". */
  title: label(40),
  today: z.iso.date(),
  timezone: label(64),
  /** This view, for another try. */
  href,
  /** Weekday of the 1st, Monday 0 … Sunday 6, for a week-aligned grid. */
  firstWeekday: z.number().int().min(0).max(6),
  /** Null at the earliest month the view shows. */
  previous: z.strictObject({ month, label: label(40), href }).nullable(),
  /** Null for the current month. */
  next: z.strictObject({ month, label: label(40), href }).nullable(),
  /** Every day of the month, in order. */
  days: z
    .array(
      z.strictObject({
        date: z.iso.date(),
        day: z.number().int().min(1).max(31),
        state,
        kwh,
        /** The figure as the rows print it: "2.4 kWh", "No data", "—", or "" for a future day. */
        text: label(32),
        /** Shade tier relative to the month's highest day, 1–4; null without a figure. */
        tier: z.number().int().min(1).max(4).nullable(),
        /** The day view; null for a future day. */
        href: href.nullable(),
      }),
    )
    .max(31),
  total: total(31),
  ...read,
});

export const TenantUsageDayExt = z.strictObject({
  date: z.iso.date(),
  /** "Wednesday 18 November 2026". */
  title: label(60),
  today: z.iso.date(),
  timezone: label(64),
  /** This view, for another try. */
  href,
  /** Null at the earliest day the view shows. */
  previous: z.strictObject({ date: z.iso.date(), label: label(40), href }).nullable(),
  /** Null for today. */
  next: z.strictObject({ date: z.iso.date(), label: label(40), href }).nullable(),
  /** The month view holding this day. */
  month: z.strictObject({ month, label: label(40), href }),
  /** Meters of the unit in force on the day. */
  meters: z.number().int().min(0).max(50),
  /** Every local hour of the day (23 to 25), in order. */
  hours: z
    .array(
      z.strictObject({
        start: instant,
        /** "14:00", or "01:00 GMT-4" on a 23- or 25-hour day; 24 leaves room for any locale. */
        label: label(24),
        state,
        kwh,
        /** "0.08 kWh", "No data", "—", or "" for a future hour. */
        text: label(32),
      }),
    )
    .max(25),
  total: total(25),
  ...read,
});

export type TenantUsageMonthExtData = z.infer<typeof TenantUsageMonthExt>;
export type TenantUsageDayExtData = z.infer<typeof TenantUsageDayExt>;
