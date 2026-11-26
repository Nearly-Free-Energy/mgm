/**
 * site-day-evidence.ts — one site day as investigation evidence,
 * `site-day-evidence/1` (docs/investigation-evidence.md §4): the snapshot's
 * types, its strict schema, the builder that maps a computed day onto it,
 * and the mapping of a capability refusal onto a refused snapshot.
 *
 * Pure: no database, no vendor client, no clock, no server-only import, so
 * tests, the operations capability and an investigator can all import it.
 * MeteringCapability.captureSiteDay (capability.ts) reads the day and calls
 * the builder.
 *
 * The snapshot is closed: every key, `k`, cause and reason below restates
 * evidence §4's key table and §6's reasons. A new key, `k` or cause is
 * `site-day-evidence/2`, with that table and this file changed together
 * (evidence §4 "Item keys"); a new §6 reason is only added, here and there.
 */
import { z } from "zod";
import type { DeviceConfig } from "@/lib/adapters/types";
import { isCalendarDateKey } from "@/lib/timezone/day-key";
import { OPENEMS_ID_PATTERN } from "@/lib/validation/stored-id";
import { validateTimezone } from "@/lib/validation/timezone";
import type { SiteSourceEvidence, SiteSourceType, UnreadableHouseMeter } from "./capability";
import {
  EVENING_START_HOUR,
  GRID_PRESENT_MIN_V,
  HOUSE_READING_TOLERANCE_MS,
  INGESTION_LAG_MS,
  LOW_BATTERY_PCT,
  SITE_DAY_CALC_VERSION,
  type DecidingReading,
  type MinuteRange,
  type SiteDayDetail,
  type SiteDayOperations,
} from "./site-operations";

export type { MinuteRange };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SITE_DAY_EVIDENCE_SCHEMA = "site-day-evidence/1" as const;

/**
 * The only bin length `@1` defines (evidence §4 `window.res`): the daily
 * operations view reads OpenEMS's 5-minute bins, and capability.ts reads at
 * this resolution. A day in other bins is MGM's defect in a capture.
 */
export const SITE_DAY_RESOLUTION_MINUTES = 5;

/** The snapshot's top-level keys; A2's SQL test compares E7's list with these. */
export const SITE_DAY_TOP_KEYS = ["schema", "window", "units", "by", "params", "items"] as const;

/**
 * Evidence §4's item keys, in the order a snapshot holds them. They restate
 * §4's key table: a new key is `site-day-evidence/2`, with that table.
 */
export const SITE_DAY_ITEM_KEYS = [
  "src_battery",
  "src_grid",
  "src_load",
  "src_pv",
  "carry_in",
  "series",
  "timestamps",
  "dark_cut",
  "dark_lowbat",
  "dark_after_lowbat",
  "no_data",
  "meter_window",
  "meter_readings",
  "meter_outcomes",
  "m_unreadable",
  "m_id_not_storable",
  "summary",
  "read",
] as const;
export type SiteDayItemKey = (typeof SITE_DAY_ITEM_KEYS)[number];

/** Evidence §4's closed `units` map; a change is a new schema version. */
export const SITE_DAY_UNITS = {
  soc: "%",
  w: "W",
  v: "V",
  meter: "Wh",
  energy: "kWh",
  pct: "%",
  pos: "bin",
  range: "min",
} as const;

/** The thresholds the figures rest on, kept as `params` (evidence §4 "Versions"). */
export const SITE_DAY_PARAMS = {
  gridMinV: GRID_PRESENT_MIN_V,
  lowBatPct: LOW_BATTERY_PCT,
  meterTolMin: HOUSE_READING_TOLERANCE_MS / 60_000,
  eveningStartH: EVENING_START_HOUR,
  lagMin: INGESTION_LAG_MS / 60_000,
} as const;

/**
 * The provider names `by.provider` may hold: the names providers-plugin.ts
 * and fixture/plugin.ts register. A provider registered under another name
 * is refused by the schema until a new schema version names it.
 */
export const SITE_DAY_PROVIDERS = ["openems", "synthetic"] as const;
export type SiteDayProvider = (typeof SITE_DAY_PROVIDERS)[number];

const isSiteDayProvider = (name: string | null): name is SiteDayProvider =>
  (SITE_DAY_PROVIDERS as readonly (string | null)[]).includes(name);

// ---------------------------------------------------------------------------
// Types: the stored shape
// ---------------------------------------------------------------------------

type Pair = [number, number];
type Series = (number | null)[];
export type SourceKey = "src_battery" | "src_grid" | "src_load" | "src_pv";
export type DecidingPointer = { ptr: string; v: number };

export type SourceItem =
  | { c: "fact"; k: "source"; type: SiteSourceType; device: string; edge: string; component: string }
  | { c: "unavailable"; k: "source"; type: SiteSourceType; reason: "source_not_readable" | "id_not_storable" };
export type CarryInItem = { c: "fact"; k: "carry_in"; gridV: Pair | null; soc: Pair | null };
export type SeriesItem = {
  c: "fact";
  k: "series";
  soc: Series | null;
  batW: Series | null;
  gridW: Series | null;
  gridV: Series | null;
  loadW: Series | null;
  pvW: Series | null;
};
export type TimestampsItem =
  | { c: "fact"; k: "timestamps"; dropped: number }
  | { c: "unavailable"; k: "timestamps"; reason: "not_reported" };
type InputUnavailable = { c: "unavailable"; reason: "input_unavailable"; in: SourceKey[] };
type Ranges = { ranges: MinuteRange[]; min: number };
export type DarkCutItem =
  | ({ c: "calculated"; k: "dark"; cause: "known_cut"; decidedBy: DecidingPointer[] } & Ranges)
  | (InputUnavailable & { k: "dark"; cause: "known_cut" });
export type DarkLowbatItem =
  | ({ c: "calculated"; k: "dark"; cause: "low_battery"; decidedBy: DecidingPointer[] } & Ranges)
  | (InputUnavailable & { k: "dark"; cause: "low_battery" });
export type DarkAfterLowbatItem =
  | ({ c: "calculated"; k: "dark"; cause: "after_low_battery"; decidedBy: { ptr: string }[] } & Ranges)
  | (InputUnavailable & { k: "dark"; cause: "after_low_battery" });
export type NoDataItem =
  | ({
      c: "calculated";
      k: "no_data";
      ruledOut: { grid: DecidingPointer | null; soc: DecidingPointer | null }[];
    } & Ranges)
  | (InputUnavailable & { k: "no_data" });
export type MeterWindowItem = { c: "calculated"; k: "meter_window"; start: Pair | null; end: Pair | null };
export type MeterReading = { component: string; start: Pair | null; end: Pair | null };
/** Device-id keys beside `c` and `k`; read them with meterEntries(). */
export type MeterReadingsItem = { c: "fact"; k: "meter_readings" } & {
  [device: string]: MeterReading | "fact" | "meter_readings";
};
export type MeterOutcome = "no_start" | "no_end" | "backwards";
/** Device-id keys beside `c` and `k`; read them with meterEntries(). */
export type MeterOutcomesItem = { c: "calculated"; k: "meter_outcomes" } & {
  [device: string]: MeterOutcome | "calculated" | "meter_outcomes";
};
export type MetersItem = {
  c: "unavailable";
  k: "meters";
  reason: "tenant_meter_unreadable" | "id_not_storable";
  devices: string[];
};
export type SummaryItem = {
  c: "calculated";
  k: "summary";
  darkMin: number | null;
  darkInferredMin: number | null;
  noDataMin: number | null;
  knownMin: number | null;
  lightsOnPct: number | null;
  cutMin: number | null;
  tenantMetersEveningKwh: number | null;
  metersLeftOut: number;
};
export type SummaryFigure = Exclude<keyof SummaryItem, "c" | "k">;

/** Evidence §6's refusal reasons, only ever added. */
export const SITE_DAY_REFUSAL_REASONS = [
  "provider_unauthorized",
  "mixed_edges",
  "provider_not_configured",
  "provider_unsupported",
  "provider_unavailable",
  "provider_unreadable_timestamps",
  "provider_invalid_data",
  "no_site_devices",
  "site_devices_unavailable",
  "metering_disabled",
  "gate_unavailable",
  "zone_unavailable",
  "request_invalid",
  "calculation_failed",
  "internal_error",
  "unknown_refusal",
] as const;
export type SiteDayRefusalReason = (typeof SITE_DAY_REFUSAL_REASONS)[number];
export type ReadItem = {
  c: "unavailable";
  k: "read";
  reason: SiteDayRefusalReason;
  from: { status: number; code?: string };
};

type Envelope = {
  schema: typeof SITE_DAY_EVIDENCE_SCHEMA;
  units: typeof SITE_DAY_UNITS;
  params: typeof SITE_DAY_PARAMS;
};
export type SiteDayEvidenceRead = Envelope & {
  window: {
    date: string;
    tz: string;
    zone: "microgrid" | "fallback";
    t0: number;
    res: number;
    bins: number;
    caveat?: ["zone_fallback"];
  };
  by: { calc: number; provider: SiteDayProvider };
  items: {
    src_battery: SourceItem;
    src_grid: SourceItem;
    src_load: SourceItem;
    src_pv: SourceItem;
    carry_in: CarryInItem;
    series: SeriesItem;
    timestamps: TimestampsItem;
    dark_cut?: DarkCutItem;
    dark_lowbat?: DarkLowbatItem;
    dark_after_lowbat?: DarkAfterLowbatItem;
    no_data?: NoDataItem;
    meter_window: MeterWindowItem;
    meter_readings: MeterReadingsItem;
    meter_outcomes: MeterOutcomesItem;
    m_unreadable?: MetersItem;
    m_id_not_storable?: MetersItem;
    summary: SummaryItem;
  };
};
export type SiteDayEvidenceRefused = Envelope & {
  window: { date: string; tz: string; zone: "microgrid" | "fallback"; res: number; caveat?: ["zone_fallback"] };
  /**
   * `provider` is null on a refusal before a provider was selected, or when
   * the selected name is not one of SITE_DAY_PROVIDERS (evidence §4 "A
   * refused read"). If §4 comes to leave the key out instead, change
   * `refusedBy` and the refused schema's `by` line together.
   */
  by: { calc: number; provider: SiteDayProvider | null };
  items: Partial<Record<SourceKey, SourceItem>> & { read: ReadItem };
};
export type SiteDayEvidence = SiteDayEvidenceRead | SiteDayEvidenceRefused;

/** The time zone a day was read in, and whether it is the microgrid's or the UTC fallback. */
export type SiteDayZone = { tz: string; zone: "microgrid" | "fallback" };
/** An investigation operation's window (evidence §3 O2): fixed at creation, validated there. */
export type SiteDayWindow = SiteDayZone & { date: string };

/** Which of MGM's own checks on a snapshot failed (captureSiteDay records it as a defect). */
export type SiteDayDefectCheck = "schema" | "pointer" | "meter_join" | "provider_name" | "resolution";

/**
 * MGM's defect in building a snapshot: which check failed, where (a path
 * normalised by normaliseEvidencePath, so it holds no id or value) and,
 * for a schema failure, zod's issue code. The message is built from those
 * alone, never from a value, an id or zod's own message.
 */
export class SiteDayEvidenceDefect extends Error {
  constructor(
    readonly check: SiteDayDefectCheck,
    readonly path: string,
    readonly issue?: string
  ) {
    super(`${check} at ${path}${issue ? ` (${issue})` : ""}`);
    this.name = "SiteDayEvidenceDefect";
  }
}

// ---------------------------------------------------------------------------
// Rule Z (evidence §2 Z, §4 "Item keys")
// ---------------------------------------------------------------------------

export type RangeItemKey = "dark_cut" | "dark_lowbat" | "dark_after_lowbat" | "no_data";
export const RANGE_ITEM_KEYS: readonly RangeItemKey[] = ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"];

/**
 * The sources each range item rests on, in item-key order (evidence §4
 * "Item keys"): a gap's cause is decided by the carried grid state first
 * and the last SoC second, so `dark_cut` rests on the grid meter and the
 * other three on both. If computeSiteDayDetail's causes change, revisit.
 */
export const RANGE_ITEM_INPUTS: Readonly<Record<RangeItemKey, readonly SourceKey[]>> = {
  dark_cut: ["src_grid"],
  dark_lowbat: ["src_battery", "src_grid"],
  dark_after_lowbat: ["src_battery", "src_grid"],
  no_data: ["src_battery", "src_grid"],
};

/**
 * The range items each summary figure rests on: a figure is null when any
 * of them is stored unavailable (rule Z within `summary`, evidence §4's
 * summary table). `cutMin` rests on the three dark items, since it counts
 * inferred-dark bins; `lightsOnPct` on all four, since it is dark time over
 * known time. The kWh and the count rest on none. If §4's table changes,
 * change this with it.
 */
export const SUMMARY_RESTS_ON: Readonly<Record<SummaryFigure, readonly RangeItemKey[]>> = {
  darkMin: ["dark_cut", "dark_lowbat", "dark_after_lowbat"],
  darkInferredMin: ["dark_lowbat"],
  noDataMin: ["no_data"],
  knownMin: ["no_data"],
  lightsOnPct: ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"],
  cutMin: ["dark_cut", "dark_lowbat", "dark_after_lowbat"],
  tenantMetersEveningKwh: [],
  metersLeftOut: [],
};

// ---------------------------------------------------------------------------
// Refusals (evidence §6)
// ---------------------------------------------------------------------------

export type SiteDayRefusal =
  | { kind: "evidence"; reason: SiteDayRefusalReason; from: { status: number; code?: string } }
  | { kind: "access_refused" };

/**
 * Evidence §6's table, by capability code. METERING_CONFIGURATION is the one
 * code mapped by status too (409 is the fixture's mixed edges). If §6 adds
 * a reason, or the capability or composer adds a code, revisit.
 */
const REFUSAL_BY_CODE: Readonly<Record<string, SiteDayRefusalReason | "access_refused">> = {
  METERING_UNAUTHORIZED: "provider_unauthorized",
  METERING_CONFIGURATION: "provider_not_configured",
  metering_site_samples_unsupported: "provider_unsupported",
  METERING_UNAVAILABLE: "provider_unavailable",
  METERING_UNREADABLE_TIMESTAMPS: "provider_unreadable_timestamps",
  METERING_INVALID_DATA: "provider_invalid_data",
  metering_no_site_devices: "no_site_devices",
  metering_site_devices_unavailable: "site_devices_unavailable",
  metering_disabled: "metering_disabled",
  metering_gate_unavailable: "gate_unavailable",
  metering_timezone_unavailable: "zone_unavailable",
  metering_invalid_query: "request_invalid",
  metering_invalid_microgrid: "request_invalid",
  metering_invalid_date: "request_invalid",
  metering_invalid_org: "request_invalid",
  metering_site_day_failed: "calculation_failed",
  metering_composition_disposed: "internal_error",
  metering_composition_failed: "internal_error",
  metering_scope_mismatch: "access_refused",
  metering_forbidden: "access_refused",
  metering_unauthenticated: "access_refused",
};

/** The codes a refused snapshot may keep in `from.code`: those §6's table names. */
export const SITE_DAY_REFUSAL_CODES = Object.keys(REFUSAL_BY_CODE).filter(
  (code) => REFUSAL_BY_CODE[code] !== "access_refused"
);

/** A capability refusal as evidence §6 maps it (by code first, by status only for METERING_CONFIGURATION). */
export function siteDayRefusal(status: number, code: string): SiteDayRefusal {
  const mapped = Object.hasOwn(REFUSAL_BY_CODE, code) ? REFUSAL_BY_CODE[code] : undefined;
  if (mapped === "access_refused") return { kind: "access_refused" };
  if (mapped === undefined) return { kind: "evidence", reason: "unknown_refusal", from: { status } };
  const reason = code === "METERING_CONFIGURATION" && status === 409 ? "mixed_edges" : mapped;
  return { kind: "evidence", reason, from: { status, code } };
}

/**
 * The pair a defect in building the snapshot is stored under: the
 * computation's own failure, which §6 maps to `calculation_failed`, so
 * the cases escalate it to MGM's maintainer and it counts as one of the
 * operation's three tries. If §6 gives a defect a code of its own, change
 * this pair and add the code to REFUSAL_BY_CODE.
 */
export const SITE_DAY_DEFECT_REFUSAL = { status: 500, code: "metering_site_day_failed" } as const;

// ---------------------------------------------------------------------------
// Paths and pointers
// ---------------------------------------------------------------------------

/** Item keys whose other keys are device ids. */
const DEVICE_KEYED: ReadonlySet<string> = new Set(["meter_readings", "meter_outcomes"]);

/**
 * A key path with nothing from the content in it: an index is `[]`, a key
 * beside `c` and `k` in a device-keyed item is `<device>`, and any other
 * key that is not a schema key's shape is `<key>`. For defect messages and
 * the closed-schema test.
 */
export function normaliseEvidencePath(path: readonly PropertyKey[]): string {
  const out: string[] = [];
  path.forEach((segment, i) => {
    if (typeof segment === "number") out.push("[]");
    else if (
      i === 2 &&
      path[0] === "items" &&
      DEVICE_KEYED.has(String(path[1])) &&
      segment !== "c" &&
      segment !== "k"
    ) {
      out.push("<device>");
    } else if (typeof segment === "string" && /^[A-Za-z_]{1,32}$/.test(segment)) out.push(segment);
    else out.push("<key>");
  });
  return `/${out.join("/")}`;
}

const POS = "(0|[1-9]\\d{0,4})";
/** A deciding reading's pointer: into `series`, or the carry-in's value. */
const READING_POINTER_RE = new RegExp(`^/items/(series/(soc|gridV)/${POS}|carry_in/(soc|gridV)/1)$`);
/** An after-low-battery gap's pointer: the low-battery range it follows. */
const RANGE_POINTER_RE = new RegExp(`^/items/dark_lowbat/ranges/${POS}$`);
/** Every pointer a snapshot holds (evidence §4: RFC 6901, no escaping needed). */
export const SITE_DAY_POINTER_RE = new RegExp(
  `^/items/(series/(soc|gridV)/${POS}|carry_in/(soc|gridV)/1|dark_lowbat/ranges/${POS})$`
);

/** RFC 6901 over a snapshot; undefined when the pointer does not resolve. */
export function resolveEvidencePointer(snapshot: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  let at: unknown = snapshot;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      at = at[Number(token)];
    } else if (at !== null && typeof at === "object" && Object.hasOwn(at, token)) {
      at = (at as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return at;
}

/** The device-id entries of a `meter_readings` or `meter_outcomes` item, without `c` and `k`. */
export function meterEntries<T>(item: Record<string, unknown>): [device: string, value: T][] {
  return Object.entries(item).filter(([key]) => key !== "c" && key !== "k") as [string, T][];
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export type SiteDaySnapshotInput = {
  date: string;
  /** The zone the day was read in. */
  zone: SiteDayZone;
  /** The provider's registry name; checked against SITE_DAY_PROVIDERS. */
  provider: string;
  day: SiteDayOperations;
  detail: SiteDayDetail;
  sources: SiteSourceEvidence;
  /** The tenant meters asked of the provider: readable, with storable ids. */
  houseMeters: readonly DeviceConfig[];
  unreadableMeters: readonly UnreadableHouseMeter[];
  unreadableTimestamps: number | null;
};

const SOURCE_KEYS: readonly [SourceKey, SiteSourceType][] = [
  ["src_battery", "battery"],
  ["src_grid", "grid_meter"],
  ["src_load", "inverter"],
  ["src_pv", "pv_meter"],
];

function sourceItems(sources: SiteSourceEvidence): Record<SourceKey, SourceItem> {
  const out = {} as Record<SourceKey, SourceItem>;
  for (const [key, type] of SOURCE_KEYS) {
    const source = sources[type];
    out[key] =
      "reason" in source
        ? { c: "unavailable", k: "source", type, reason: source.reason }
        : { c: "fact", k: "source", type, device: source.device, edge: source.edge, component: source.component };
  }
  return out;
}

const zoneWindow = (zone: SiteDayZone) => ({ tz: zone.tz, zone: zone.zone });
const caveatOf = (zone: SiteDayZone): { caveat?: ["zone_fallback"] } =>
  zone.zone === "fallback" ? { caveat: ["zone_fallback"] } : {};


const copyPair = (pair: readonly [number, number] | null): Pair | null => (pair ? [pair[0], pair[1]] : null);

/**
 * A successful read as a `site-day-evidence/1` snapshot (evidence §4): the
 * facts copied, the range items under rule Z, every deciding reading as a
 * pointer checked against the value it points at, and each tenant meter's
 * component id joined from the sources the read asked for. Throws
 * SiteDayEvidenceDefect when the day cannot be stored as `@1` defines it,
 * which is MGM's defect (captureSiteDay records it as a refused read).
 */
export function buildSiteDaySnapshot(input: SiteDaySnapshotInput): SiteDayEvidenceRead {
  const { day, detail } = input;
  if (!isSiteDayProvider(input.provider)) throw new SiteDayEvidenceDefect("provider_name", "/by/provider");
  if (day.resolutionMinutes !== SITE_DAY_RESOLUTION_MINUTES) {
    throw new SiteDayEvidenceDefect("resolution", "/window/res");
  }
  const sources = sourceItems(input.sources);
  const isFact = (key: SourceKey) => sources[key].c === "fact";
  const battery = isFact("src_battery");
  const grid = isFact("src_grid");
  const series = (values: (number | null)[], available: boolean) => (available ? [...values] : null);

  const items: Record<string, unknown> = { ...sources };
  items.carry_in = {
    c: "fact",
    k: "carry_in",
    gridV: grid ? copyPair(detail.carry_in.gridV) : null,
    soc: battery ? copyPair(detail.carry_in.soc) : null,
  } satisfies CarryInItem;
  items.series = {
    c: "fact",
    k: "series",
    soc: series(detail.series.soc, battery),
    batW: series(detail.series.batW, battery),
    gridW: series(detail.series.gridW, grid),
    gridV: series(detail.series.gridV, grid),
    loadW: series(detail.series.loadW, isFact("src_load")),
    pvW: series(detail.series.pvW, isFact("src_pv")),
  } satisfies SeriesItem;
  items.timestamps = (
    input.unreadableTimestamps === null
      ? { c: "unavailable", k: "timestamps", reason: "not_reported" }
      : { c: "fact", k: "timestamps", dropped: input.unreadableTimestamps }
  ) satisfies TimestampsItem;

  const snapshotSoFar = { items } as const;
  const pointerOf = (reading: DecidingReading, at: string): DecidingPointer => {
    const ptr =
      reading.pos >= 0
        ? `/items/series/${reading.series}/${reading.pos}`
        : `/items/carry_in/${reading.series}/1`;
    const ok =
      reading.pos >= 0
        ? resolveEvidencePointer(snapshotSoFar, ptr) === reading.v
        : (() => {
            const carried = (items.carry_in as CarryInItem)[reading.series];
            return carried !== null && carried[0] === reading.pos && carried[1] === reading.v;
          })();
    if (!ok) throw new SiteDayEvidenceDefect("pointer", at);
    return { ptr, v: reading.v };
  };

  const hasGap = RANGE_ITEM_KEYS.some((key) => detail[key].ranges.length > 0);
  const unavailableIn = (key: RangeItemKey) => RANGE_ITEM_INPUTS[key].filter((source) => !isFact(source));
  const stored: Partial<Record<RangeItemKey, "calculated" | "unavailable">> = {};
  for (const key of RANGE_ITEM_KEYS) {
    const missing = unavailableIn(key);
    if (missing.length > 0) {
      if (!hasGap) continue;
      stored[key] = "unavailable";
      const kc = key === "no_data" ? { k: "no_data" } : { k: "dark", cause: DARK_CAUSE[key] };
      items[key] = { c: "unavailable", ...kc, reason: "input_unavailable", in: [...missing] };
      continue;
    }
    const computed = detail[key];
    if (computed.ranges.length === 0) continue;
    stored[key] = "calculated";
    const ranges = computed.ranges.map(([start, end]): MinuteRange => [start, end]);
    const base = `/items/${key}`;
    if (key === "no_data") {
      items[key] = {
        c: "calculated",
        k: "no_data",
        ranges,
        min: computed.min,
        ruledOut: detail.no_data.ruledOut.map(({ grid: g, soc }) => ({
          grid: g ? pointerOf(g, `${base}/ruledOut/[]/grid`) : null,
          soc: soc ? pointerOf(soc, `${base}/ruledOut/[]/soc`) : null,
        })),
      } satisfies NoDataItem;
    } else if (key === "dark_after_lowbat") {
      const lowbat = detail.dark_lowbat.ranges;
      items[key] = {
        c: "calculated",
        k: "dark",
        cause: "after_low_battery",
        ranges,
        min: computed.min,
        decidedBy: detail.dark_after_lowbat.decidedBy.map(({ lowbatRange }) => {
          if (!Number.isInteger(lowbatRange) || lowbatRange < 0 || lowbatRange >= lowbat.length) {
            throw new SiteDayEvidenceDefect("pointer", `${base}/decidedBy/[]`);
          }
          return { ptr: `/items/dark_lowbat/ranges/${lowbatRange}` };
        }),
      } satisfies DarkAfterLowbatItem;
    } else {
      const decidedBy = (key === "dark_cut" ? detail.dark_cut : detail.dark_lowbat).decidedBy;
      items[key] = {
        c: "calculated",
        k: "dark",
        cause: DARK_CAUSE[key],
        ranges,
        min: computed.min,
        decidedBy: decidedBy.map((r) => pointerOf(r, `${base}/decidedBy/[]`)),
      };
    }
  }
  // An after-low-battery pointer names a range of the stored dark_lowbat item.
  if (stored.dark_after_lowbat === "calculated" && stored.dark_lowbat !== "calculated") {
    throw new SiteDayEvidenceDefect("pointer", "/items/dark_after_lowbat/decidedBy/[]");
  }

  items.meter_window = {
    c: "calculated",
    k: "meter_window",
    start: copyPair(detail.meter_window?.start ?? null),
    end: copyPair(detail.meter_window?.end ?? null),
  } satisfies MeterWindowItem;

  const componentOf = new Map(input.houseMeters.map((m) => [m.id, m.componentId]));
  const byId = <T>(record: Record<string, T>) =>
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const readings: Record<string, unknown> = { c: "fact", k: "meter_readings" };
  for (const [id, reading] of byId(detail.meter_readings)) {
    const component = componentOf.get(id);
    if (component === undefined) throw new SiteDayEvidenceDefect("meter_join", "/items/meter_readings/<device>");
    readings[id] = { component, start: copyPair(reading.start), end: copyPair(reading.end) };
  }
  items.meter_readings = readings;
  const outcomes: Record<string, unknown> = { c: "calculated", k: "meter_outcomes" };
  for (const [id, outcome] of byId(detail.meter_outcomes)) outcomes[id] = outcome;
  items.meter_outcomes = outcomes;

  for (const [key, reason] of [
    ["m_unreadable", "tenant_meter_unreadable"],
    ["m_id_not_storable", "id_not_storable"],
  ] as const) {
    const devices = input.unreadableMeters
      .filter((m) => m.reason === reason)
      .map((m) => m.id)
      .sort();
    if (devices.length > 0) items[key] = { c: "unavailable", k: "meters", reason, devices } satisfies MetersItem;
  }

  const restsOnUnavailable = (figure: SummaryFigure) =>
    SUMMARY_RESTS_ON[figure].some((key) => stored[key] === "unavailable");
  const figure = (name: SummaryFigure, value: number | null) => (restsOnUnavailable(name) ? null : value);
  items.summary = {
    c: "calculated",
    k: "summary",
    darkMin: figure("darkMin", day.darkMinutes),
    darkInferredMin: figure("darkInferredMin", day.darkInferredMinutes),
    noDataMin: figure("noDataMin", day.noDataMinutes),
    knownMin: figure("knownMin", day.knownMinutes),
    lightsOnPct: figure("lightsOnPct", day.lightsOnPct),
    cutMin: figure("cutMin", day.cutMinutes),
    tenantMetersEveningKwh: figure("tenantMetersEveningKwh", day.housesEveningKwh),
    metersLeftOut: day.housesEveningMetersMissing,
  } satisfies SummaryItem;

  // In SITE_DAY_ITEM_KEYS' order.
  const ordered: Record<string, unknown> = {};
  for (const key of SITE_DAY_ITEM_KEYS) if (key in items) ordered[key] = items[key];

  return {
    schema: SITE_DAY_EVIDENCE_SCHEMA,
    window: {
      date: input.date,
      ...zoneWindow(input.zone),
      t0: day.dayStartMs,
      res: day.resolutionMinutes,
      // The bins read: a read that ends before the day holds fewer, and is
      // never stored (evidence §3 E4, `window_not_closed`).
      bins: day.soc.length,
      ...caveatOf(input.zone),
    },
    units: { ...SITE_DAY_UNITS },
    by: { calc: SITE_DAY_CALC_VERSION, provider: input.provider },
    params: { ...SITE_DAY_PARAMS },
    items: ordered as SiteDayEvidenceRead["items"],
  };
}

const DARK_CAUSE = {
  dark_cut: "known_cut",
  dark_lowbat: "low_battery",
  dark_after_lowbat: "after_low_battery",
} as const;

/**
 * `by` on a refused snapshot: the provider when one was selected and is one
 * SITE_DAY_PROVIDERS names, else null (evidence §4 "A refused read").
 */
function refusedBy(provider: string | null): SiteDayEvidenceRefused["by"] {
  return { calc: SITE_DAY_CALC_VERSION, provider: isSiteDayProvider(provider) ? provider : null };
}

/**
 * A refused read as a snapshot (evidence §4 "A refused read"): the window's
 * date, zone and resolution but no `t0` or `bins`, the sources known before
 * the refusal, and the `read` item. `date` is always the operation's window
 * date (evidence §3 O2), never the query's; `zone` is the read's, or the
 * operation's when the refusal came before or at the zone read. Exported for
 * the operations step too, which builds this for a composer refusal before
 * any capability exists.
 */
export function buildRefusedSiteDaySnapshot(input: {
  date: string;
  zone: SiteDayZone;
  /** Null: none selected. A name SITE_DAY_PROVIDERS does not hold is stored as null. */
  provider: string | null;
  /** Null: not read before the refusal. */
  sources: SiteSourceEvidence | null;
  refusal: Extract<SiteDayRefusal, { kind: "evidence" }>;
}): SiteDayEvidenceRefused {
  const items: Record<string, unknown> = input.sources ? { ...sourceItems(input.sources) } : {};
  items.read = {
    c: "unavailable",
    k: "read",
    reason: input.refusal.reason,
    from:
      input.refusal.from.code === undefined
        ? { status: input.refusal.from.status }
        : { status: input.refusal.from.status, code: input.refusal.from.code },
  } satisfies ReadItem;
  return {
    schema: SITE_DAY_EVIDENCE_SCHEMA,
    window: {
      date: input.date,
      ...zoneWindow(input.zone),
      res: SITE_DAY_RESOLUTION_MINUTES,
      ...caveatOf(input.zone),
    },
    units: { ...SITE_DAY_UNITS },
    by: refusedBy(input.provider),
    params: { ...SITE_DAY_PARAMS },
    items: items as SiteDayEvidenceRefused["items"],
  };
}

// ---------------------------------------------------------------------------
// The strict schema (evidence §4 "Closed schema")
// ---------------------------------------------------------------------------

/** A device id: the 8-4-4-4-12 hex shape Postgres `uuid` accepts, whatever its version. */
const deviceId = z.guid();
const openEmsId = z.string().regex(OPENEMS_ID_PATTERN);
const date = z.string().refine(isCalendarDateKey);
const timezone = z.string().refine((tz) => !validateTimezone(tz));
const num = z.number();
const int = z.number().int();
const count = int.nonnegative();
const position = int;
const reading = z.tuple([position, num]);
const binPair = z.tuple([count, count]);
const series = z.array(num.nullable()).nullable();
const sourceKey = z.enum(["src_battery", "src_grid", "src_load", "src_pv"]);
const zoneValue = z.enum(["microgrid", "fallback"]);
const caveat = z.tuple([z.literal("zone_fallback")]).optional();
const units = z.strictObject(
  Object.fromEntries(Object.entries(SITE_DAY_UNITS).map(([k, v]) => [k, z.literal(v)])) as {
    [K in keyof typeof SITE_DAY_UNITS]: z.ZodLiteral<(typeof SITE_DAY_UNITS)[K]>;
  }
);
const params = z.strictObject({
  gridMinV: num,
  lowBatPct: num,
  meterTolMin: num,
  eveningStartH: num,
  lagMin: num,
});
const calc = int.positive();
const provider = z.enum(SITE_DAY_PROVIDERS);
const readingPointer = z.strictObject({ ptr: z.string().regex(READING_POINTER_RE), v: num });
const rangePointer = z.strictObject({ ptr: z.string().regex(RANGE_POINTER_RE) });
const minuteRange = z.tuple([count, count]).refine(([start, end]) => end > start);
const ranges = z.array(minuteRange).min(1);

const sourceItem = (type: SiteSourceType) =>
  z.discriminatedUnion("c", [
    z.strictObject({
      c: z.literal("fact"),
      k: z.literal("source"),
      type: z.literal(type),
      device: deviceId,
      edge: openEmsId,
      component: openEmsId,
    }),
    z.strictObject({
      c: z.literal("unavailable"),
      k: z.literal("source"),
      type: z.literal(type),
      reason: z.enum(["source_not_readable", "id_not_storable"]),
    }),
  ]);
const sourceItems_ = {
  src_battery: sourceItem("battery"),
  src_grid: sourceItem("grid_meter"),
  src_load: sourceItem("inverter"),
  src_pv: sourceItem("pv_meter"),
};

const inputUnavailable = {
  c: z.literal("unavailable"),
  reason: z.literal("input_unavailable"),
  in: z.array(sourceKey).min(1),
};
const darkItem = <C extends string, D extends z.ZodType>(cause: C, decidedBy: D) =>
  z.discriminatedUnion("c", [
    z.strictObject({
      c: z.literal("calculated"),
      k: z.literal("dark"),
      cause: z.literal(cause),
      ranges,
      min: count,
      decidedBy: z.array(decidedBy),
    }),
    z.strictObject({ ...inputUnavailable, k: z.literal("dark"), cause: z.literal(cause) }),
  ]);
const noDataItem = z.discriminatedUnion("c", [
  z.strictObject({
    c: z.literal("calculated"),
    k: z.literal("no_data"),
    ranges,
    min: count,
    ruledOut: z.array(z.strictObject({ grid: readingPointer.nullable(), soc: readingPointer.nullable() })),
  }),
  z.strictObject({ ...inputUnavailable, k: z.literal("no_data") }),
]);
const metersItem = (reason: "tenant_meter_unreadable" | "id_not_storable") =>
  z.strictObject({
    c: z.literal("unavailable"),
    k: z.literal("meters"),
    reason: z.literal(reason),
    devices: z.array(deviceId).min(1),
  });
const meterReading = z.strictObject({
  component: openEmsId,
  start: reading.nullable(),
  end: reading.nullable(),
});
/** Every key beside `c` and `k` is a device id. */
const deviceKeyed = (ctx: z.core.$RefinementCtx, item: Record<string, unknown>) => {
  for (const key of Object.keys(item)) {
    if (key === "c" || key === "k") continue;
    if (!deviceId.safeParse(key).success) ctx.addIssue({ code: "custom", path: [key], message: "device key" });
  }
};
const meterReadingsItem = z
  .strictObject({ c: z.literal("fact"), k: z.literal("meter_readings") })
  .catchall(meterReading)
  .superRefine((item, ctx) => deviceKeyed(ctx, item));
const meterOutcomesItem = z
  .strictObject({ c: z.literal("calculated"), k: z.literal("meter_outcomes") })
  .catchall(z.enum(["no_start", "no_end", "backwards"]))
  .superRefine((item, ctx) => deviceKeyed(ctx, item));
const nullableNum = num.nullable();
const summaryItem = z.strictObject({
  c: z.literal("calculated"),
  k: z.literal("summary"),
  darkMin: nullableNum,
  darkInferredMin: nullableNum,
  noDataMin: nullableNum,
  knownMin: nullableNum,
  lightsOnPct: nullableNum,
  cutMin: nullableNum,
  tenantMetersEveningKwh: nullableNum,
  metersLeftOut: count,
});
const readItem = z
  .strictObject({
    c: z.literal("unavailable"),
    k: z.literal("read"),
    reason: z.enum(SITE_DAY_REFUSAL_REASONS),
    from: z.strictObject({
      status: int,
      code: z.enum(SITE_DAY_REFUSAL_CODES as [string, ...string[]]).optional(),
    }),
  })
  .refine((item) => {
    // The reason is the one §6 gives the code and status; only an unknown
    // code is stored without its code.
    const mapped = siteDayRefusal(item.from.status, item.from.code ?? "");
    return mapped.kind === "evidence" && mapped.reason === item.reason;
  });

const aligned = (ctx: z.core.$RefinementCtx, items: Record<string, unknown>) => {
  for (const key of RANGE_ITEM_KEYS) {
    const item = items[key] as
      | { c: string; ranges?: MinuteRange[]; min?: number; decidedBy?: unknown[]; ruledOut?: unknown[] }
      | undefined;
    if (!item || item.c !== "calculated" || !item.ranges) continue;
    const list = item.decidedBy ?? item.ruledOut ?? [];
    if (list.length !== item.ranges.length) {
      ctx.addIssue({ code: "custom", path: ["items", key], message: "aligned" });
    }
    if (item.min !== item.ranges.reduce((sum, [start, end]) => sum + end - start, 0)) {
      ctx.addIssue({ code: "custom", path: ["items", key, "min"], message: "min" });
    }
  }
};

const caveatMatchesZone = (window: { zone: string; caveat?: unknown }) =>
  (window.zone === "fallback") === (window.caveat !== undefined);

const readSchema = z
  .strictObject({
    schema: z.literal(SITE_DAY_EVIDENCE_SCHEMA),
    window: z
      .strictObject({
        date,
        tz: timezone,
        zone: zoneValue,
        t0: int,
        res: z.literal(SITE_DAY_RESOLUTION_MINUTES),
        bins: count,
        caveat,
      })
      .refine(caveatMatchesZone),
    units,
    by: z.strictObject({ calc, provider }),
    params,
    items: z.strictObject({
      ...sourceItems_,
      carry_in: z.strictObject({
        c: z.literal("fact"),
        k: z.literal("carry_in"),
        gridV: z.tuple([int.negative(), num]).nullable(),
        soc: z.tuple([int.negative(), num]).nullable(),
      }),
      series: z.strictObject({
        c: z.literal("fact"),
        k: z.literal("series"),
        soc: series,
        batW: series,
        gridW: series,
        gridV: series,
        loadW: series,
        pvW: series,
      }),
      timestamps: z.discriminatedUnion("c", [
        z.strictObject({ c: z.literal("fact"), k: z.literal("timestamps"), dropped: count }),
        z.strictObject({ c: z.literal("unavailable"), k: z.literal("timestamps"), reason: z.literal("not_reported") }),
      ]),
      dark_cut: darkItem("known_cut", readingPointer).optional(),
      dark_lowbat: darkItem("low_battery", readingPointer).optional(),
      dark_after_lowbat: darkItem("after_low_battery", rangePointer).optional(),
      no_data: noDataItem.optional(),
      meter_window: z
        .strictObject({
          c: z.literal("calculated"),
          k: z.literal("meter_window"),
          start: binPair.nullable(),
          end: binPair.nullable(),
        })
        .refine(
          ({ start, end }) =>
            (start === null) === (end === null) && (!start || start[0] <= start[1]) && (!end || end[0] <= end[1])
        ),
      meter_readings: meterReadingsItem,
      meter_outcomes: meterOutcomesItem,
      m_unreadable: metersItem("tenant_meter_unreadable").optional(),
      m_id_not_storable: metersItem("id_not_storable").optional(),
      summary: summaryItem,
    }),
  })
  .superRefine((snapshot, ctx) => {
    aligned(ctx, snapshot.items);
    // Each series holds one value per bin read, or is null whole.
    for (const [name, values] of Object.entries(snapshot.items.series)) {
      if (Array.isArray(values) && values.length !== snapshot.window.bins) {
        ctx.addIssue({ code: "custom", path: ["items", "series", name], message: "bins" });
      }
    }
    // Every pointer resolves to the value it repeats, or to a range.
    const check = (pointer: { ptr: string; v?: number } | null, path: PropertyKey[]) => {
      if (!pointer) return;
      const at = resolveEvidencePointer(snapshot, pointer.ptr);
      const ok = pointer.v === undefined ? Array.isArray(at) : at === pointer.v;
      if (!ok) ctx.addIssue({ code: "custom", path, message: "pointer" });
    };
    for (const key of ["dark_cut", "dark_lowbat", "dark_after_lowbat"] as const) {
      const item = snapshot.items[key];
      if (item?.c === "calculated") {
        (item.decidedBy as { ptr: string; v?: number }[]).forEach((p, i) =>
          check(p, ["items", key, "decidedBy", i])
        );
      }
    }
    const noData = snapshot.items.no_data;
    if (noData?.c === "calculated") {
      noData.ruledOut.forEach(({ grid, soc }, i) => {
        check(grid, ["items", "no_data", "ruledOut", i, "grid"]);
        check(soc, ["items", "no_data", "ruledOut", i, "soc"]);
      });
    }
  });

const refusedSchema = z.strictObject({
  schema: z.literal(SITE_DAY_EVIDENCE_SCHEMA),
  window: z
    .strictObject({
      date,
      tz: timezone,
      zone: zoneValue,
      res: z.literal(SITE_DAY_RESOLUTION_MINUTES),
      caveat,
    })
    .refine(caveatMatchesZone),
  units,
  // Evidence §4 "A refused read": null before a provider is selected.
  by: z.strictObject({ calc, provider: provider.nullable() }),
  params,
  items: z.strictObject({
    src_battery: sourceItems_.src_battery.optional(),
    src_grid: sourceItems_.src_grid.optional(),
    src_load: sourceItems_.src_load.optional(),
    src_pv: sourceItems_.src_pv.optional(),
    read: readItem,
  }),
});

/** A successful read's snapshot. */
export const siteDayEvidenceReadSchema = readSchema;
/** A refused read's snapshot. */
export const siteDayEvidenceRefusedSchema = refusedSchema;
/** Any `site-day-evidence/1` snapshot: strict at every level, no message text. */
export const siteDayEvidenceSchema = z.union([readSchema, refusedSchema]);

/**
 * The first issue of a failed parse as a defect: its normalised path and
 * zod's issue code, never zod's message or `keys`, which quote what failed.
 */
export function schemaDefect(error: z.ZodError): SiteDayEvidenceDefect {
  const issue = error.issues[0];
  return new SiteDayEvidenceDefect("schema", normaliseEvidencePath(issue?.path ?? []), issue?.code);
}
