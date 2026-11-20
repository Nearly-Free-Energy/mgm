import "server-only";

/**
 * Examples of the `tenant.usage-month` and `tenant.usage-day` views, so every
 * GUI can be tested against them, built at import the way the loader builds
 * them: the unit's links, the synthetic meter figures (the fixture
 * provider's generator, @/lib/metering/fixture/meter-energy, imported on its
 * own: the metering index is privileged and would make this surface so),
 * summed per day or hour as the capability sums them, and the calendar's
 * states (../usage-calendar.ts). "Now" is 14:30 on 18 November 2026 in
 * Kampala.
 *
 * Month: November so far, with the house meter replaced on the 10th and a
 * day the old meter did not report; October, whose read failed; November over the
 * read limit, with nothing kept and with a read kept from 14:20; February,
 * before the unit's first meter; and September, every day read.
 * Day: today so far; the day the old meter did not report three hours; a
 * day before the unit's first meter; and a day whose read failed.
 *
 * The meters are picked by what the generator gives them, as the
 * Operations day's examples pick their days, so the examples keep their
 * shape if the generator changes.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import { generateDeviceEnergySeries, METER_FIXTURE_SEED, syntheticMeterDay } from "@/lib/metering/fixture/meter-energy";
import { dayKeyInZone, localHourStarts } from "@/lib/timezone/day-key";
import type { TenantMeter, TenantUsageMonth, TenantUsageProblem } from "../types";
import {
  computeUsageDay,
  computeUsageMonth,
  datesOfMonth,
  metersOn,
  sumMeters,
  type UsageFigures,
} from "../usage-calendar";
import { buildUsageDayModel, buildUsageMonthModel } from "./usage-model";

const LOCALE = "en-GB";
const TIMEZONE = "Africa/Kampala";
/** 14:30 in Kampala. */
const NOW = Date.parse("2026-11-18T11:30:00Z");
const TODAY = dayKeyInZone(NOW, TIMEZONE);
const TENANT = { id: "00000000-0000-4000-8000-0000000000b1", displayName: "Example tenant", unitLabel: "Unit 4" };
/** The generator's input only: no model shows it. */
const MICROGRID = "00000000-0000-4000-8000-0000000000c1";
const fmt = createFmt({ locale: LOCALE });
const links = { tenantId: TENANT.id, several: false };

/** What the host shows on a model whose Values are synthetic: SYNTHETIC_NOTICE in @/lib/gui/host/server/view, which surface.test.ts compares. */
export const EXAMPLE_SYNTHETIC_NOTICE = {
  tone: "warning",
  text: "Synthetic data: these figures are generated for demonstration, not measured.",
} as const;

const between = (from: string, to: string) => datesOfMonth(from.slice(0, 7)).filter((d) => d >= from && d <= to);
const unreported = (deviceId: string, dates: string[]) =>
  dates.filter((date) => syntheticMeterDay(METER_FIXTURE_SEED, MICROGRID, deviceId, date, TIMEZONE).wh.includes(null));

/** The first of a run of example meter ids whose generated days pass `test`. */
function meterWhere(test: (deviceId: string) => boolean, not: string[] = []): string {
  for (let i = 0; i < 400; i++) {
    const id = `00000000-0000-4000-8000-${(0x200 + i).toString(16).padStart(12, "0")}`;
    if (!not.includes(id) && test(id)) return id;
  }
  throw new Error("no example meter fits");
}

/** The house meter until the 10th: one day of 1–9 November unreported. */
const HOUSE = meterWhere((id) => unreported(id, between("2026-11-01", "2026-11-09")).length === 1);
/** The day the house meter did not report. */
const GAP_DAY = unreported(HOUSE, between("2026-11-01", "2026-11-09"))[0];
/** The meter that replaced it on the 10th: every day reported, today included. */
const NEW_METER = meterWhere((id) => unreported(id, between("2026-11-10", TODAY)).length === 0, [HOUSE]);
/** A meter that reported every day of September. */
const SEPTEMBER = meterWhere((id) => unreported(id, datesOfMonth("2026-09")).length === 0);

/** A primary consumption meter link: the only kind that is the unit's use (USAGE_METER_ROLE). */
const link = (deviceId: string, name: string, effectiveFrom: string, effectiveTo: string | null = null): TenantMeter => ({
  deviceId,
  name,
  deviceType: "consumption_meter",
  role: "primary_consumption_meter",
  effectiveFrom,
  effectiveTo,
});
const LINKS: TenantMeter[] = [
  link(HOUSE, "House meter", "2026-03-01", "2026-11-10"),
  link(NEW_METER, "New house meter", "2026-11-10"),
];

const devicesOf = (ids: Iterable<string>) => [...ids].sort().map((id) => ({ id, edgeOpenemsId: "SYNTHETIC-EDGE-EXAMPLE", componentId: "meter1" }));

/** The month's figures as the capability sums them, read at `readAt`: one read of every meter in force, clipped per day. */
function monthFigures(month: string, assignments: TenantMeter[], readAt: number, stale = false): UsageFigures {
  const today = dayKeyInZone(readAt, TIMEZONE);
  const inForce = datesOfMonth(month).filter((date) => date <= today && metersOn(assignments, date).size > 0);
  const series = generateDeviceEnergySeries(
    {
      microgridId: MICROGRID,
      devices: devicesOf(new Set(inForce.flatMap((date) => [...metersOn(assignments, date)]))),
      startDate: inForce[0],
      endDate: inForce[inForce.length - 1],
      resolution: "day",
      timezone: TIMEZONE,
    },
    { nowMs: readAt },
  );
  const index = new Map(series.buckets.map((start, i) => [dayKeyInZone(start, TIMEZONE), i]));
  const values = Object.fromEntries(
    inForce.map((date) => [date, sumMeters({ ...series, synthetic: true }, metersOn(assignments, date), index.get(date))]),
  );
  return { kind: "figures", values, readAt, stale, synthetic: true };
}

/** The day's figures per hour, read at `readAt`. */
function dayFigures(date: string, assignments: TenantMeter[], readAt: number): UsageFigures {
  const devices = metersOn(assignments, date);
  const series = generateDeviceEnergySeries(
    { microgridId: MICROGRID, devices: devicesOf(devices), startDate: date, endDate: date, resolution: "hour", timezone: TIMEZONE },
    { nowMs: readAt },
  );
  const index = new Map(series.buckets.map((start, i) => [start, i]));
  const values = Object.fromEntries(
    localHourStarts(date, TIMEZONE).map((start) => [String(start), sumMeters({ ...series, synthetic: true }, devices, index.get(start))]),
  );
  return { kind: "figures", values, readAt, stale: false, synthetic: true };
}

const problem = (kind: TenantUsageProblem): UsageFigures => ({ kind: "problem", problem: kind });

function computedMonth(month: string, figures: UsageFigures, assignments: TenantMeter[] = LINKS): TenantUsageMonth {
  return computeUsageMonth({ tenant: TENANT, timezone: TIMEZONE, month, today: TODAY, nowMs: NOW, assignments, figures });
}

function month(month: string, figures: UsageFigures, assignments: TenantMeter[] = LINKS): LoadedModel<"collection"> {
  return buildUsageMonthModel(computedMonth(month, figures, assignments), { fmt, locale: LOCALE, links });
}

function day(date: string, figures: UsageFigures, assignments: TenantMeter[] = LINKS): LoadedModel<"collection"> {
  const computed = computeUsageDay({ tenant: TENANT, timezone: TIMEZONE, date, today: TODAY, nowMs: NOW, assignments, figures });
  return buildUsageDayModel(computed, { fmt, locale: LOCALE, links });
}

const SEPTEMBER_LINKS = [link(SEPTEMBER, "House meter", "2026-08-01")];

/**
 * The current month as the tenant home reads it (../surface/examples.ts):
 * November so far with the day the old meter did not report, and the unit
 * with no meter, for which nothing is read.
 */
export const EXAMPLE_MONTHS_SO_FAR: { november: TenantUsageMonth; noMeter: TenantUsageMonth } = {
  november: computedMonth("2026-11", monthFigures("2026-11", LINKS, NOW)),
  noMeter: computedMonth("2026-11", { kind: "none" }, []),
};

/** The month view's models as the loader returns them, before the host fills its fields. */
export const TENANT_USAGE_MONTH_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  month("2026-11", monthFigures("2026-11", LINKS, NOW)),
  month("2026-10", problem("unavailable")),
  month("2026-11", problem("limited")),
  month("2026-11", monthFigures("2026-11", LINKS, Date.parse("2026-11-18T11:20:00Z"), true)),
  month("2026-02", { kind: "none" }),
  month("2026-09", monthFigures("2026-09", SEPTEMBER_LINKS, NOW), SEPTEMBER_LINKS),
];

/** The day view's models as the loader returns them, before the host fills its fields. */
export const TENANT_USAGE_DAY_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  day(TODAY, dayFigures(TODAY, LINKS, NOW)),
  day(GAP_DAY, dayFigures(GAP_DAY, LINKS, NOW)),
  day("2026-02-20", { kind: "none" }),
  day("2026-11-17", problem("unavailable")),
];

/** Whether any Value of the body is marked synthetic, as the host decides its notice (hasSynthetic in @/lib/gui/host/server/view). */
function synthetic(loaded: LoadedModel<"collection">): boolean {
  const values = [...loaded.body.rows.flatMap((row) => Object.values(row.cells)), ...Object.values(loaded.body.totals ?? {})];
  return values.some((value) => value.synthetic === true);
}

/**
 * Each loaded model with the fields the host fills for a tenant view, as a
 * GUI receives it: no organization, trail, attached views or actions, and
 * the synthetic notice when a figure is generated (dispatchTenantView).
 */
function received(view: "tenant.usage-month" | "tenant.usage-day", loaded: LoadedModel<"collection">): ModelOf<"collection"> {
  return {
    ...loaded,
    // The host resolves the rows' and the empty state's actions too; a
    // tenant view gets none, and these models link none.
    body: {
      ...loaded.body,
      rows: loaded.body.rows.map((row) => ({ ...row, actions: [] })),
      empty: { title: loaded.body.empty.title, ...(loaded.body.empty.text ? { text: loaded.body.empty.text } : {}) },
    },
    type: "view",
    view,
    kind: "collection",
    org: null,
    trail: [],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    ...(synthetic(loaded) ? { notice: { ...EXAMPLE_SYNTHETIC_NOTICE } } : {}),
  };
}

export const TENANT_USAGE_MONTH_EXAMPLES: readonly ModelOf<"collection">[] = TENANT_USAGE_MONTH_LOADED_EXAMPLES.map((loaded) =>
  received("tenant.usage-month", loaded),
);
export const TENANT_USAGE_DAY_EXAMPLES: readonly ModelOf<"collection">[] = TENANT_USAGE_DAY_LOADED_EXAMPLES.map((loaded) =>
  received("tenant.usage-day", loaded),
);

/** The example meters' ids and the microgrid's, which no example may show (surface.test.ts). */
export const EXAMPLE_HIDDEN_IDS: readonly string[] = [MICROGRID, HOUSE, NEW_METER, SEPTEMBER];
