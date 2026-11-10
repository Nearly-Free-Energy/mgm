/**
 * site-day-model.ts — the Operations day as a `metrics` view model.
 *
 * Pure: no server-only import, no clock, no I/O. The caller passes the day
 * (computeSiteDay's output), today's date in the microgrid's zone, the
 * locale and the request's Fmt. Every string the Operations page's client
 * component (src/components/operations/daily-operations.tsx) formats is
 * built here instead, with the same copy, so any GUI can print the text
 * as given. The chart and the evening strip, which tiles cannot carry, go
 * in the `metering.site-day@1` ext (./site-day-ext.ts) for a renderer that
 * draws them.
 */
import { formatRate } from "@/components/format/currency";
import { formatLocalDate } from "@/components/format/local-date";
import type { EntityRef, LinkRef, Value } from "@/lib/gui/contract";
import { markSynthetic } from "@/lib/gui/mark-synthetic";
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import { addDaysToDateKey } from "@/lib/timezone/day-key";
import {
  EVENING_START_HOUR,
  GRID_PRESENT_MIN_V,
  LOW_BATTERY_PCT,
  SOC_CHECK_HOUR,
  type EveningSupply,
  type SiteDayOperations,
  type TimeRange,
} from "../site-operations";
import type { SiteDayExtData } from "./site-day-ext";

/** The ext this model carries; its shape is SiteDayExt in ./site-day-ext.ts. */
export const SITE_DAY_EXT_SCHEMA = "metering.site-day@1" as const;

/** Every tile and series key the view emits. */
export const SITE_DAY_KEYS = [
  "solar", "houses-evening", "battery-evening", "cuts", "cut-time", "lowest-soc", "soc-17",
  "lights-on", "evening-supply", "soc", "setup",
] as const;

type Tile = LoadedModel<"metrics">["body"]["tiles"][number];
type Microgrid = { id: string; name: string };

/** "4h 10m", "45m", "0m". */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const SUPPLY_LABEL: Record<EveningSupply, string> = {
  battery: "Battery",
  battery_and_grid: "Battery + grid",
  grid: "Grid alone",
  dark: "Dark",
  no_data: "No data",
};
const SUPPLY_ORDER: EveningSupply[] = ["battery", "battery_and_grid", "grid", "dark", "no_data"];
const HOUR_MS = 3_600_000;

const dayHref = (id: string) => `/microgrids/${encodeURIComponent(id)}/operations` as const;
const iso = (ms: number) => new Date(ms).toISOString();

/** The date as the day picker heads it: "Thu, 05 Nov 2026". */
function dayLabel(date: string, locale: string): string {
  return formatLocalDate(new Date(`${date}T12:00:00Z`), locale, {
    weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
}

/** Previous day always; next day and today only when they are not ahead of or equal to the day shown. */
function dayLinks(id: string, date: string, today: string): LinkRef[] {
  const href = (d: string) => `${dayHref(id)}?date=${d}` as const;
  const next = addDaysToDateKey(date, 1);
  return [
    { id: "metering.day-previous", label: "Previous day", href: href(addDaysToDateKey(date, -1)) },
    ...(next <= today ? [{ id: "metering.day-next" as const, label: "Next day", href: href(next) }] : []),
    ...(date !== today ? [{ id: "metering.day-today" as const, label: "Today", href: href(today) }] : []),
  ];
}

function entity(microgrid: Microgrid): EntityRef {
  return { kind: "microgrid", id: microgrid.id, label: microgrid.name };
}

export function buildSiteDayModel(
  day: SiteDayOperations,
  o: { microgrid: Microgrid; today: string; locale: string; fmt: Fmt },
): LoadedModel<"metrics"> {
  const { microgrid, today, locale, fmt } = o;
  const clock = (ms: number) =>
    formatLocalDate(new Date(ms), locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: day.timezone });
  const until = (ms: number) => (ms >= day.dayEndMs ? "24:00" : clock(ms));
  const kwh = (v: number, derived?: boolean) => fmt.energy(v * 1000, derived ? { derived: true } : undefined);
  const value = (v: number | null, build: (v: number) => Value) => (v === null ? fmt.empty() : build(v));
  const withText = (v: Value, text: string): Value => ({ ...v, text });
  const status = (when: boolean, s: "cut" | "floor" | "dark") => (when ? { status: fmt.status("siteDay", s) } : {});
  const hoursText = (h: number) => `${formatRate(h, locale, { minDigits: 1, maxDigits: 1 })} h`;
  const span = (r: TimeRange) => `${clock(r.startMs)}–${until(r.endMs)}`;

  const partial = day.readUntilMs < day.dayEndMs;
  const evening = `${clock(day.eveningStartMs)}–24:00`;
  const { pv, load, battery, gridMeter, houses } = day.sources;
  const cutCount = day.cuts?.length ?? null;

  const solarHint =
    day.solarKwh !== null
      ? day.solarEstimated ? "≈ inverter output − grid − battery" : "Solar meter"
      : pv ? "No solar meter readings"
      : load && battery && gridMeter ? "No complete inverter, grid and battery readings"
      : "Needs a solar meter, or an inverter output meter with the battery and grid meter";

  // Before the window opens there is nothing to compare: say when it starts
  // rather than show the battery's zero beside an empty figure.
  const beforeEvening = day.readUntilMs <= day.eveningStartMs;
  const batteryShare = beforeEvening
    ? `From ${clock(day.eveningStartMs)}`
    : !battery ? "No battery registered"
    : day.eveningDischargeKwh === null ? "No battery readings"
    : `Battery supplied ${kwh(day.eveningDischargeKwh).text}`;
  const missing = day.housesEveningMetersMissing;
  const housesHint = !houses
    ? `Needs household meters · ${batteryShare}`
    : missing > 0 ? `${batteryShare} · ${missing} ${missing === 1 ? "meter" : "meters"} without data`
    : batteryShare;

  const darkText =
    day.darkMinutes > 0
      ? `Dark ${formatDuration(day.darkMinutes)}` +
        (day.darkInferredMinutes > 0 ? ` (${formatDuration(day.darkInferredMinutes)} inferred from a low battery)` : "")
      : "No dark time";
  const lightsHint = day.noDataMinutes > 0 ? `${darkText} · No data ${formatDuration(day.noDataMinutes)}` : darkText;

  const shown = SUPPLY_ORDER.filter((s) => s !== "no_data" || day.eveningHours.no_data > 0);
  const legend = shown.map((s) => ({ supply: s, label: SUPPLY_LABEL[s], hours: hoursText(day.eveningHours[s]) }));
  const eveningEmpty = day.evening.length === 0 ? "The evening window has not started yet." : null;

  const lowest = day.lowestSoc;
  const tiles: Tile[] = [
    { key: "solar", label: "Solar", value: value(day.solarKwh, (v) => kwh(v, day.solarEstimated)), hint: solarHint },
    { key: "houses-evening", label: `Houses used ${evening}`, value: value(day.housesEveningKwh, kwh), hint: housesHint },
    {
      key: "battery-evening",
      label: `Battery supplied ${evening}`,
      value: beforeEvening || !battery ? fmt.empty() : value(day.eveningDischargeKwh, kwh),
      ...(beforeEvening || !battery || day.eveningDischargeKwh === null ? { hint: batteryShare } : {}),
    },
    {
      key: "cuts",
      label: "Power cuts",
      value: value(cutCount, (v) => fmt.number(v)),
      hint: cutCount === null ? "Needs a grid meter" : "Cuts / time without grid power",
      ...status((cutCount ?? 0) > 0, "cut"),
    },
    {
      key: "cut-time",
      label: "Time without grid power",
      value: value(cutCount === null ? null : (day.cutMinutes ?? 0), (v) => withText(fmt.number(v, "min"), formatDuration(v))),
    },
    {
      key: "lowest-soc",
      label: "Lowest battery",
      value: value(lowest?.pct ?? null, (v) => fmt.percent(v)),
      hint: lowest ? `At ${clock(lowest.atMs)}${lowest.duringCut ? ", in a cut" : ""}` : "Needs a battery",
      ...status(!!lowest && lowest.pct <= LOW_BATTERY_PCT, "floor"),
    },
    {
      key: "soc-17",
      label: `Battery at ${SOC_CHECK_HOUR}:00`,
      value: value(day.socAtCheckHour, (v) => fmt.percent(v)),
      hint: day.socAtCheckHour === null ? `No reading at ${SOC_CHECK_HOUR}:00` : "Before the evening window",
    },
    {
      key: "lights-on",
      label: "Lights on",
      // One decimal, which Fmt.percent does not offer.
      value: value(day.lightsOnPct, (v) => withText(fmt.percent(v), `${formatRate(v, locale, { minDigits: 1, maxDigits: 1 })}%`)),
      hint: lightsHint,
      ...status(day.darkMinutes > 0, "dark"),
    },
    {
      key: "evening-supply",
      label: `Who served the houses, ${evening}`,
      value: fmt.text(eveningEmpty ?? legend.map((l) => `${l.label} ${l.hours}`).join(" · ")),
    },
  ];

  const chartLabel = [
    `Battery level from ${clock(day.dayStartMs)} to ${until(day.readUntilMs)}.`,
    lowest ? `Lowest ${Math.round(lowest.pct)}% at ${clock(lowest.atMs)}.` : "",
    cutCount ? `${cutCount} power ${cutCount === 1 ? "cut" : "cuts"}.` : "",
    day.dark.length ? `Houses dark for ${formatDuration(day.darkMinutes)}.` : "",
  ].filter(Boolean).join(" ");

  const notes = [
    ...(day.noDataMinutes > 0
      ? [
          `No data for ${formatDuration(day.noDataMinutes)} (gateway or connection down while the grid was on and the battery above ${LOW_BATTERY_PCT}%, or not yet known); that time is not counted as dark.`,
        ]
      : []),
    `A power cut is any grid phase below ${GRID_PRESENT_MIN_V} V over a ${day.resolutionMinutes}-minute reading. Dark means the gateway went silent during a cut: the battery had cut off and the houses had no power. When it went silent with the battery at or below ${LOW_BATTERY_PCT}%, the houses are taken to be dark and the grid off, since the gateway cannot outlive the battery; that time is shown as inferred. Lights on is the share of the day that was not dark, leaving out time with no data. Times are ${day.timezone}.`,
  ];

  const range = (r: TimeRange) => ({ start: iso(r.startMs), end: iso(r.endMs), label: span(r) });
  const ext: SiteDayExtData = {
    state: "day",
    date: day.date,
    today,
    timezone: day.timezone,
    dayHref: dayHref(microgrid.id),
    synthetic: day.synthetic === true,
    partial,
    dayStart: iso(day.dayStartMs),
    dayEnd: iso(day.dayEndMs),
    readUntil: iso(day.readUntilMs),
    eveningStart: iso(day.eveningStartMs),
    resolutionMinutes: day.resolutionMinutes,
    hourMarks: day.hourMarks.map(({ hour, atMs }) => ({ at: iso(atMs), label: String(hour).padStart(2, "0") })),
    eveningTicks: Array.from({ length: 24 - EVENING_START_HOUR + 1 }, (_, i) => ({
      at: iso(Math.min(day.eveningStartMs + i * HOUR_MS, day.dayEndMs)),
      label: `${EVENING_START_HOUR + i}:00`,
    })),
    cuts: day.cuts?.map(range) ?? null,
    dark: day.dark.map(range),
    evening: day.evening.map((s) => ({
      start: iso(s.startMs),
      end: iso(s.endMs),
      supply: s.supply,
      label: `${SUPPLY_LABEL[s.supply]}, ${clock(s.startMs)}–${clock(s.endMs)}`,
    })),
    legend,
    eveningHours: { ...day.eveningHours },
    sources: { battery, gridMeter, load, pv, houses },
    thresholds: { gridPresentMinV: GRID_PRESENT_MIN_V, lowBatteryPct: LOW_BATTERY_PCT },
    chartLabel,
    chartEmpty: battery ? null : "No battery is registered on this microgrid.",
    eveningLabel: legend.map((l) => `${l.label} ${l.hours}`).join(", "),
    eveningEmpty,
    notes,
  };

  const model: LoadedModel<"metrics"> = {
    title: "Operations",
    subtitle: `${partial ? `Today so far, up to ${clock(day.readUntilMs)}` : dayLabel(day.date, locale)} · ${day.timezone}`,
    entity: entity(microgrid),
    body: {
      tiles,
      // A null point is a gap that breaks the line.
      ...(battery ? { series: [{ key: "soc", label: "Battery level", unit: "%", points: day.soc.map((p) => [iso(p.atMs), p.pct] as [string, number | null]) }] } : {}),
    },
    actions: [],
    links: dayLinks(microgrid.id, day.date, today),
    ext: { schema: SITE_DAY_EXT_SCHEMA, data: ext },
  };
  return day.synthetic ? markSynthetic(model) : model;
}

/** The day when the microgrid has no battery or grid meter registered: what to set up, and where. */
export function buildNoSiteDevicesModel(o: {
  microgrid: Microgrid;
  date: string;
  today: string;
  timezone: string;
  locale: string;
  fmt: Fmt;
}): LoadedModel<"metrics"> {
  const { microgrid, date, today, timezone, locale, fmt } = o;
  const title = "Register the battery and grid meter";
  const message =
    "This view reads the site's battery and grid meter from OpenEMS. Discover them on the microgrid's edge and set their types to Battery and Grid meter. For a solar estimate, also set the meter on the inverter's output to Inverter.";
  const ext: SiteDayExtData = {
    state: "no-site-devices",
    date,
    today,
    timezone,
    dayHref: dayHref(microgrid.id),
    synthetic: false,
    title,
    message,
  };
  return {
    title: "Operations",
    subtitle: `${dayLabel(date, locale)} · ${timezone}`,
    entity: entity(microgrid),
    body: { tiles: [{ key: "setup", label: title, value: fmt.text(message) }] },
    actions: [],
    links: [
      { id: "metering.edges", label: "Go to Edges", href: `/microgrids/${encodeURIComponent(microgrid.id)}/setup/edges` },
      ...dayLinks(microgrid.id, date, today),
    ],
    ext: { schema: SITE_DAY_EXT_SCHEMA, data: ext },
  };
}
