/**
 * The expected evidence of #133's investigation cases: for each case that
 * exists, what its `site-day-evidence/1` snapshot (docs/investigation-
 * evidence.md §4) holds beyond what the pins already say. A helper for
 * investigation-cases.test.ts (the regeneration test), not production code.
 *
 * Where each part comes from:
 * - item kinds, the ranges by cause and the summary figures rule Z nulls
 *   restate docs/investigation-cases.md §2's "Expected evidence" column;
 * - the deciding readings' pointer positions, the counter readings and the
 *   meter windows are not in §2: they are pinned from the synthetic
 *   generator, so if a scenario, the generator or §2 changes, re-derive
 *   them;
 * - the summary figures, the window's zone and bins and `timestamps` are
 *   not restated here: the regeneration test takes them from
 *   investigation-cases.pins.ts (`{ ...CLEAR_DEFAULTS, ...figures }`),
 *   which investigation-cases-doc.test.ts ties to §2.
 *
 * Every case that exists has an entry (the regeneration test checks it), so
 * whoever turns a pending case to `exists` adds its evidence here in the
 * same commit.
 */
import type {
  MinuteRange,
  SiteDayItemKey,
  SiteDayRefusalReason,
  SiteDayZone,
  SourceKey,
  SummaryFigure,
} from "../site-day-evidence";
import type { CaseFigures, CaseId } from "./investigation-cases.pins";

export type ExpectedItem =
  | { c: "fact" }
  | { c: "calculated" }
  | { c: "unavailable"; reason: string; in?: SourceKey[] };

/** A tenant meter's device number (`caseDeviceId(nn, dd)`). */
type Dd = "11" | "12" | "13";

export type CaseEvidence =
  | {
      outcome: "read";
      /**
       * Changes from CLEAR_ITEMS: an entry replaces an item's kind, null
       * removes it. The snapshot's keys equal the result exactly, with
       * `timestamps` taken from the pins, not listed here.
       */
      items?: Partial<Record<SiteDayItemKey, ExpectedItem | null>>;
      /** Default `[209, 216]` / `[281, 287]`, a 24-hour day's. */
      meterWindow?: { start: [number, number]; end: [number, number] };
      ranges?: Partial<Record<"dark_cut" | "dark_lowbat" | "dark_after_lowbat" | "no_data", MinuteRange[]>>;
      decidedBy?: Partial<Record<"dark_cut" | "dark_lowbat" | "dark_after_lowbat", string[]>>;
      ruledOut?: { grid: string | null; soc: string | null }[];
      /** The summary figures rule Z nulls (evidence §4's summary table); every other figure is the pins'. */
      nullFigures?: SummaryFigure[];
      meterOutcomes?: Partial<Record<Dd, "no_start" | "no_end" | "backwards">>;
      /** Readings checked exactly; every other meter is checked only for its component and an outcome. */
      meterReadings?: Partial<Record<Dd, { start: [number, number] | null; end: [number, number] | null }>>;
      unreadable?: { tenant_meter_unreadable?: Dd[]; id_not_storable?: Dd[] };
    }
  | {
      outcome: "refused";
      /** Exactly, besides `read`. */
      items: Partial<Record<SourceKey, ExpectedItem>>;
      read: { reason: SiteDayRefusalReason; from: { status: number; code?: string } };
      provider: "synthetic" | null;
      zoneRead: SiteDayZone | null;
      /** The refused snapshot's zone. */
      window: SiteDayZone;
    };

/**
 * A clear day's items: every source, the carry-in and series as facts, the
 * meter items, the summary; no range item, no `meters` item, no `read`.
 * `timestamps` is null here because the regeneration test takes it from the
 * pins (a fact with `dropped` when they count unreadable timestamps, else
 * `not_reported`).
 */
export const CLEAR_ITEMS: Readonly<Record<SiteDayItemKey, ExpectedItem | null>> = {
  src_battery: { c: "fact" },
  src_grid: { c: "fact" },
  src_load: { c: "fact" },
  src_pv: { c: "fact" },
  carry_in: { c: "fact" },
  series: { c: "fact" },
  timestamps: null,
  dark_cut: null,
  dark_lowbat: null,
  dark_after_lowbat: null,
  no_data: null,
  meter_window: { c: "calculated" },
  meter_readings: { c: "fact" },
  meter_outcomes: { c: "calculated" },
  m_unreadable: null,
  m_id_not_storable: null,
  summary: { c: "calculated" },
  read: null,
};

/**
 * The pins' figures under their evidence names (evidence §4 `summary`: each
 * figure is the field of the same stem; the kWh is `housesEveningKwh` and
 * the count `housesEveningMetersMissing`).
 */
export const SUMMARY_FROM_FIGURES: Readonly<Record<SummaryFigure, keyof CaseFigures>> = {
  darkMin: "darkMinutes",
  darkInferredMin: "darkInferredMinutes",
  noDataMin: "noDataMinutes",
  knownMin: "knownMinutes",
  lightsOnPct: "lightsOnPct",
  cutMin: "cutMinutes",
  tenantMetersEveningKwh: "housesEveningKwh",
  metersLeftOut: "housesEveningMetersMissing",
};

const RANGE_FIGURES: SummaryFigure[] = ["darkMin", "darkInferredMin", "noDataMin", "knownMin", "lightsOnPct", "cutMin"];
const sourceUnavailable = { c: "unavailable", reason: "source_not_readable" } as const;
const inputUnavailable = (source: SourceKey): ExpectedItem => ({
  c: "unavailable",
  reason: "input_unavailable",
  in: [source],
});
const KAMPALA: SiteDayZone = { tz: "Africa/Kampala", zone: "microgrid" };

/**
 * A pinned day the fixture refuses with a provider code (C19, C20, C24): the
 * sources were read and chosen, so all four are facts; the fixture's 502
 * reaches the capture as 503 (capability.ts, `fromMeteringError`). If that
 * mapping changes, revisit.
 */
function providerRefusal(reason: SiteDayRefusalReason, code: string): CaseEvidence {
  return {
    outcome: "refused",
    items: { src_battery: { c: "fact" }, src_grid: { c: "fact" }, src_load: { c: "fact" }, src_pv: { c: "fact" } },
    read: { reason, from: { status: 503, code } },
    provider: "synthetic",
    zoneRead: KAMPALA,
    window: KAMPALA,
  };
}

/**
 * The cases' expected evidence (docs/investigation-cases.md §2). C15 to
 * C24's pointer positions and counter readings are pinned from their days
 * in `fixture/pinned-days.ts`; if a mask there changes, re-derive them.
 */
export const CASE_EVIDENCE: Readonly<Partial<Record<CaseId, CaseEvidence>>> = {
  C01: { outcome: "read" },
  // Its cutMin 90 is the pins': a cut the battery carried leaves no range.
  C02: { outcome: "read" },
  C03: {
    outcome: "read",
    items: { dark_cut: { c: "calculated" } },
    ranges: { dark_cut: [[1185, 1350]] },
    decidedBy: { dark_cut: ["/items/series/gridV/236"] },
  },
  C04: {
    outcome: "read",
    items: { dark_lowbat: { c: "calculated" } },
    ranges: { dark_lowbat: [[300, 390]] },
    decidedBy: { dark_lowbat: ["/items/series/soc/59"] },
  },
  C05: {
    outcome: "read",
    items: { no_data: { c: "calculated" } },
    ranges: { no_data: [[600, 645]] },
    ruledOut: [{ grid: "/items/series/gridV/119", soc: "/items/series/soc/119" }],
  },
  // Europe/London leaves summer time: 300 bins (the pins'), so the meter window moves.
  C06: { outcome: "read", meterWindow: { start: [221, 228], end: [293, 299] } },
  C07: {
    outcome: "read",
    items: {
      src_battery: sourceUnavailable,
      dark_lowbat: inputUnavailable("src_battery"),
      dark_after_lowbat: inputUnavailable("src_battery"),
      no_data: inputUnavailable("src_battery"),
    },
    nullFigures: RANGE_FIGURES,
  },
  C08: {
    outcome: "read",
    items: {
      src_grid: sourceUnavailable,
      dark_cut: inputUnavailable("src_grid"),
      dark_lowbat: inputUnavailable("src_grid"),
      dark_after_lowbat: inputUnavailable("src_grid"),
      no_data: inputUnavailable("src_grid"),
    },
    nullFigures: RANGE_FIGURES,
  },
  C09: {
    outcome: "read",
    items: { m_unreadable: { c: "unavailable", reason: "tenant_meter_unreadable" } },
    unreadable: { tenant_meter_unreadable: ["13"] },
  },
  // Its UTC fallback zone and caveat follow from the pins.
  C10: { outcome: "read" },
  C11: { outcome: "read", items: { src_pv: sourceUnavailable } },
  C12: {
    outcome: "refused",
    items: {
      src_battery: sourceUnavailable,
      src_grid: sourceUnavailable,
      src_load: { c: "fact" },
      src_pv: { c: "fact" },
    },
    read: { reason: "no_site_devices", from: { status: 404, code: "metering_no_site_devices" } },
    provider: "synthetic",
    zoneRead: KAMPALA,
    window: KAMPALA,
  },
  C13: {
    outcome: "refused",
    items: {},
    read: { reason: "mixed_edges", from: { status: 409, code: "METERING_CONFIGURATION" } },
    provider: null,
    zoneRead: KAMPALA,
    window: KAMPALA,
  },
  C14: {
    outcome: "refused",
    items: {},
    read: { reason: "metering_disabled", from: { status: 409, code: "metering_disabled" } },
    provider: null,
    zoneRead: null,
    // The operation's window: refused before the zone read.
    window: KAMPALA,
  },
  // Meter 11 is silent over the whole start search, so its end is not searched.
  C15: {
    outcome: "read",
    meterOutcomes: { "11": "no_start" },
    meterReadings: { "11": { start: null, end: null } },
  },
  // A gateway down from 23:20: every meter's end search finds nothing.
  C16: {
    outcome: "read",
    items: { no_data: { c: "calculated" } },
    ranges: { no_data: [[1400, 1440]] },
    ruledOut: [{ grid: "/items/series/gridV/279", soc: "/items/series/soc/279" }],
    meterOutcomes: { "11": "no_end", "12": "no_end", "13": "no_end" },
  },
  // Meter 12's counter restarts from 0 at 20:00.
  C17: {
    outcome: "read",
    meterOutcomes: { "12": "backwards" },
    meterReadings: { "12": { start: [215, 19902759], end: [287, 1502] } },
  },
  // Its `timestamps` dropped 30 is the pins' `unreadableTimestamps`.
  C18: {
    outcome: "read",
    items: { no_data: { c: "calculated" } },
    ranges: { no_data: [[840, 990]] },
    ruledOut: [{ grid: "/items/series/gridV/167", soc: "/items/series/soc/167" }],
  },
  C19: providerRefusal("provider_unreadable_timestamps", "METERING_UNREADABLE_TIMESTAMPS"),
  C20: providerRefusal("provider_unavailable", "METERING_UNAVAILABLE"),
  // The gap starts the day before: the carry-in's last readings rule out dark.
  C21: {
    outcome: "read",
    items: { no_data: { c: "calculated" } },
    ranges: { no_data: [[0, 180]] },
    ruledOut: [{ grid: "/items/carry_in/gridV/1", soc: "/items/carry_in/soc/1" }],
  },
  // Meter 12's counter holds its 17:00 value: counted at 0 kWh, no outcome.
  C22: {
    outcome: "read",
    meterReadings: { "12": { start: [215, 22175129], end: [287, 22175129] } },
  },
  C23: {
    outcome: "read",
    items: { m_unreadable: { c: "unavailable", reason: "tenant_meter_unreadable" } },
    unreadable: { tenant_meter_unreadable: ["13"] },
    meterOutcomes: { "12": "backwards" },
    meterReadings: { "12": { start: [215, 22134472], end: [287, 1670] } },
  },
  C24: providerRefusal("provider_invalid_data", "METERING_INVALID_DATA"),
};
