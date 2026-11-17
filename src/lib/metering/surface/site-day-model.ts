/**
 * site-day-model.ts — the Operations day as a `metrics` view model.
 *
 * Pure: no server-only import, no clock, no I/O. The caller passes the day
 * (computeSiteDay's output), today's date in the microgrid's zone, the
 * locale and the request's Fmt. Every string the view shows is built here,
 * so any GUI can print the text as given. The chart and the evening strip,
 * which tiles cannot carry, go in the `metering.site-day@1` ext
 * (./site-day-ext.ts) for a renderer that draws them.
 *
 * Three states, each with the day navigation: the day itself, a microgrid
 * with no battery or grid meter registered, and a day the metering source
 * could not read (a problem, with the link to its fix or another try). Each
 * carries the time zone nudge's warning when the microgrid's zone needs it.
 */
import { formatRate } from "@/components/format/currency";
import { formatLocalDate } from "@/components/format/local-date";
import type { EntityRef, LinkRef, Value } from "@/lib/gui/contract";
import { markSynthetic } from "@/lib/gui/mark-synthetic";
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import { addDaysToDateKey } from "@/lib/timezone/day-key";
import type { TimezoneNudgeCopy } from "@/lib/timezone/nudge";
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
  "lights-on", "evening-supply", "soc", "setup", "problem",
] as const;

/** The longest time zone notice the ext takes; the nudge's text holds the microgrid's free-text country. */
export const TIMEZONE_NOTICE_MAX = 600;

/** The link each state carries beside the time zone notice, to the page that holds the microgrid's Edit and the nudge. */
export const TIMEZONE_LINK = "metering.set-timezone";

/**
 * A day the metering source could not read: fixed copy, never the source's
 * message, and where the fix is. A null link means there is nothing to set
 * up, only another try.
 */
export type SiteDayProblem = {
  tone: "warning" | "danger";
  title: string;
  message: string;
  link: { label: string; page: "edges" | "openems-backend" } | null;
  /** Reading the same day again may work; false when it fails the same way each time. */
  retry: boolean;
};

// The problems live here rather than beside the loader (./site-day.ts):
// the loader's import of ../compose leads back through the metering plugin
// to this view's examples (./examples.ts), which build a model from each,
// so a module that imports the loader first would see them undefined. If
// that cycle goes, they may move.
const NOT_LOADED = "Could not load this day's operations";

export const SITE_DAY_PROBLEMS = {
  mixed: {
    tone: "warning",
    title: "Synthetic and real edges are mixed",
    message: "This microgrid mixes synthetic and real edges; keep synthetic data in its own microgrid.",
    link: { label: "Go to Edges", page: "edges" },
    retry: false,
  },
  noConnection: {
    tone: "danger",
    title: NOT_LOADED,
    message: "This microgrid has no usable OpenEMS connection. Set it up under Setup → OpenEMS Backend.",
    link: { label: "Set up the OpenEMS connection", page: "openems-backend" },
    retry: false,
  },
  rejected: {
    tone: "danger",
    title: NOT_LOADED,
    message: "OpenEMS did not accept this microgrid's connection settings. Check them under Setup → OpenEMS Backend.",
    link: { label: "Check the OpenEMS connection", page: "openems-backend" },
    retry: false,
  },
  unavailable: {
    tone: "danger",
    title: NOT_LOADED,
    message: "This day's operations could not be loaded right now. Try again shortly.",
    link: null,
    retry: true,
  },
  // The day's samples could not be worked out. Reading them again fails the
  // same way, so the picker is the way on, as the capability's own copy says.
  dayFailed: {
    tone: "danger",
    title: NOT_LOADED,
    message: "This day's operations could not be worked out. Try another day.",
    link: null,
    retry: false,
  },
} as const satisfies Record<string, SiteDayProblem>;

/**
 * The metering source's failure as a problem the view shows, or null when
 * the failure is not the source's. Its 401 or 403 is OpenEMS refusing the
 * stored settings, not the person, so it is a problem rather than a refusal.
 */
export function siteDayProblem(failure: { status: number; code: string }): SiteDayProblem | null {
  const { status, code } = failure;
  // The synthetic provider's refusal of a microgrid with synthetic and real
  // edges (src/lib/metering/fixture/plugin.ts); if its status or code changes, revisit.
  if (code === "METERING_CONFIGURATION") return status === 409 ? SITE_DAY_PROBLEMS.mixed : SITE_DAY_PROBLEMS.noConnection;
  if (code === "METERING_UNAUTHORIZED") return SITE_DAY_PROBLEMS.rejected;
  if (code.startsWith("METERING_")) return SITE_DAY_PROBLEMS.unavailable;
  // getSiteDay's own failures after the plugin gate, in
  // src/lib/metering/capability.ts: reading the site's devices
  // (openSiteReader), which may pass, and computing the day
  // (siteReadFailed), which fails the same way each time. A date the
  // capability refuses (metering_invalid_date) can only mean it worked out
  // today in another zone than the loader, which already clamped the date,
  // so it is a passing failure too. None is the person's or the gate's, so
  // the day keeps its picker; if getSiteDay gains another such failure or
  // renames these, revisit.
  if (code === "metering_site_devices_unavailable" || code === "metering_invalid_date") return SITE_DAY_PROBLEMS.unavailable;
  if (code === "metering_site_day_failed") return SITE_DAY_PROBLEMS.dayFailed;
  return null;
}

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
const setupHref = (id: string, page: "edges" | "openems-backend") => `/microgrids/${encodeURIComponent(id)}/setup/${page}` as const;
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

/** The notice as the ext carries it, cut to the ext's bound. */
function timezoneNotice(nudge: TimezoneNudgeCopy | null | undefined): SiteDayExtData["timezoneNotice"] {
  if (!nudge) return null;
  const text = nudge.text.length > TIMEZONE_NOTICE_MAX ? `${nudge.text.slice(0, TIMEZONE_NOTICE_MAX - 1)}…` : nudge.text;
  return { title: nudge.title, text };
}

/**
 * The link beside the notice. It goes to Setup → Edges because the
 * microgrid layout (src/app/(gui)/microgrids/[id]/layout.tsx) shows the
 * nudge and its Set timezone button above the Setup pages; if they move off
 * that layout, revisit.
 */
function timezoneLinks(id: string, nudge: TimezoneNudgeCopy | null | undefined): LinkRef[] {
  return nudge ? [{ id: TIMEZONE_LINK, label: "Set timezone", href: setupHref(id, "edges") }] : [];
}

export function buildSiteDayModel(
  day: SiteDayOperations,
  o: { microgrid: Microgrid; today: string; locale: string; fmt: Fmt; nudge?: TimezoneNudgeCopy | null },
): LoadedModel<"metrics"> {
  const { microgrid, today, locale, fmt, nudge } = o;
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
    ? `Needs tenant meters · ${batteryShare}`
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
    timezoneNotice: timezoneNotice(nudge),
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
    links: [...dayLinks(microgrid.id, day.date, today), ...timezoneLinks(microgrid.id, nudge)],
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
  nudge?: TimezoneNudgeCopy | null;
}): LoadedModel<"metrics"> {
  const { microgrid, date, today, timezone, locale, fmt, nudge } = o;
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
    timezoneNotice: timezoneNotice(nudge),
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
      { id: "metering.edges", label: "Go to Edges", href: setupHref(microgrid.id, "edges") },
      ...dayLinks(microgrid.id, date, today),
      ...timezoneLinks(microgrid.id, nudge),
    ],
    ext: { schema: SITE_DAY_EXT_SCHEMA, data: ext },
  };
}

/**
 * The day the metering source could not read: the problem's copy, the link
 * to its fix first, and the day navigation, so another day can still be
 * chosen. A problem with no fix to link is retried; the ext says so.
 */
export function buildSiteDayProblemModel(o: {
  microgrid: Microgrid;
  date: string;
  today: string;
  timezone: string;
  locale: string;
  fmt: Fmt;
  problem: SiteDayProblem;
  nudge?: TimezoneNudgeCopy | null;
}): LoadedModel<"metrics"> {
  const { microgrid, date, today, timezone, locale, fmt, problem, nudge } = o;
  const ext: SiteDayExtData = {
    state: "problem",
    date,
    today,
    timezone,
    dayHref: dayHref(microgrid.id),
    synthetic: false,
    timezoneNotice: timezoneNotice(nudge),
    tone: problem.tone,
    title: problem.title,
    message: problem.message,
    retry: problem.retry,
  };
  const fix: LinkRef[] = problem.link
    ? [{ id: `metering.${problem.link.page}`, label: problem.link.label, href: setupHref(microgrid.id, problem.link.page) }]
    : [];
  return {
    title: "Operations",
    subtitle: `${dayLabel(date, locale)} · ${timezone}`,
    entity: entity(microgrid),
    body: { tiles: [{ key: "problem", label: problem.title, value: fmt.text(problem.message) }] },
    actions: [],
    links: [...fix, ...dayLinks(microgrid.id, date, today), ...timezoneLinks(microgrid.id, nudge)],
    ext: { schema: SITE_DAY_EXT_SCHEMA, data: ext },
  };
}
