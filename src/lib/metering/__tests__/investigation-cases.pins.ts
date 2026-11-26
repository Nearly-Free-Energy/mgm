/**
 * The pins of #133's investigation cases (docs/investigation-cases.md §1
 * and §2): each microgrid's variant of the device set, and each case's
 * microgrid, date, scenario and expected read. A helper for
 * investigation-cases.test.ts (the regeneration test) and, once A2-5 adds
 * it, the seed's static test, not production code: the identifiers
 * themselves are in `fixture/case-ids.ts`, which the fixture may read.
 *
 * Variants 01 to 0a and cases C01 to C14 restate docs/investigation-cases.md
 * §1 and §2; if either changes, change both. Variants 0b to 14 and the
 * pending cases' microgrids and dates are A2-4's pins, which §1 and §2 do
 * not hold yet (both say "pending"); when A2-4 writes them there, revisit
 * this comment. A2-3 fills each case's `evidence`, and A2-12 its `result`.
 */
import type { SiteScenario } from "../fixture/site-samples";
import type { SiteSourceAvailability } from "../site-operations";

/** `[start, end)` in minutes after the local day's start (evidence §4 "Times"). */
export type MinuteRange = [start: number, end: number];

type CaseNumber =
  | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
  | "13" | "14" | "15" | "16" | "17" | "18" | "19" | "20" | "21" | "22" | "23" | "24";
export type CaseId = `C${CaseNumber}`;

/** How a case microgrid differs from the full device set (§1 "Variants"). */
export type CaseVariant = {
  zone: string;
  org: "A" | "B";
  /** Devices (`dd`) the microgrid does not have. */
  omit: string[];
  /** Devices (`dd`) stored as legacy rows, with a NULL component id. */
  legacy: string[];
  /** Edges besides the microgrid's synthetic one. */
  extraEdges: string[];
};

/** The figures of a successful read that §2 states, by `SiteDayRead` field. */
export type CaseFigures = {
  darkMinutes: number;
  darkInferredMinutes: number;
  noDataMinutes: number;
  knownMinutes: number;
  lightsOnPct: number;
  cutMinutes: number | null;
  housesEveningMetersMissing: number;
  housesEveningKwh: number;
  dark: MinuteRange[];
  cuts: MinuteRange[] | null;
  /** The day's bins: `soc.length`. */
  bins: number;
  zone: "microgrid" | "fallback";
  /** The zone the day was read in: the stored one, or UTC when it falls back. */
  timezone: string;
  unreadableTimestamps: number | null;
  /**
   * Which site sources were readable. The only figure that marks C11 (§1:
   * the solar meter changes no other), and the source configuration of
   * C07, C08 and C09.
   */
  sources: SiteSourceAvailability;
};

export type CaseRead =
  | {
      ok: true;
      /** Every field not listed is `CLEAR_DEFAULTS`'s; every case lists its kWh. */
      figures: Partial<CaseFigures> & Pick<CaseFigures, "housesEveningKwh">;
    }
  | { ok: false; status: number; code: string };

export type InvestigationCase = {
  id: CaseId;
  /** The microgrid's number, hexadecimal (`caseMicrogridId`). */
  microgrid: string;
  date: string;
  /**
   * The scenario `siteScenario` draws for the day. A pending case's day is
   * the base its overlay (A2-4) applies to.
   */
  scenario: SiteScenario;
  /** A2-3 fills it. */
  evidence?: unknown;
  /** A2-12 fills it. */
  result?: unknown;
} & (
  | { mechanism: "exists"; read: CaseRead }
  /** A pending case has no read: A2-4 pins it with its scenario and flips the mechanism. */
  | { mechanism: "pending"; read: null }
);

const KAMPALA = "Africa/Kampala";
const plain = (overrides: Partial<CaseVariant> = {}): CaseVariant => ({
  zone: KAMPALA,
  org: "A",
  omit: [],
  legacy: [],
  extraEdges: [],
  ...overrides,
});

/**
 * Every case microgrid, 01 to 14 in hexadecimal. 0b to 14 serve the pending
 * cases, one each (A2-4's pinned days); 13 holds C23's legacy meter.
 */
export const CASE_VARIANTS: Readonly<Record<string, CaseVariant>> = {
  "01": plain(),
  "02": plain({ zone: "Europe/London" }),
  "03": plain({ omit: ["01"] }),
  "04": plain({ omit: ["02"] }),
  "05": plain({ legacy: ["13"] }),
  // Stored as text; the capability reads the day in UTC.
  "06": plain({ zone: "Not/AZone" }),
  "07": plain({ legacy: ["04"] }),
  "08": plain({ omit: ["01", "02"] }),
  "09": plain({ extraEdges: ["edge0"] }),
  "0a": plain({ org: "B" }),
  "0b": plain(),
  "0c": plain(),
  "0d": plain(),
  "0e": plain(),
  "0f": plain(),
  "10": plain(),
  "11": plain(),
  "12": plain(),
  "13": plain({ legacy: ["13"] }),
  "14": plain(),
};

/**
 * #291 §2's clear day, for every figure a case does not list. kWh has no
 * clear-day default: every successful case states its own.
 */
export const CLEAR_DEFAULTS: Omit<CaseFigures, "housesEveningKwh"> = {
  darkMinutes: 0,
  darkInferredMinutes: 0,
  noDataMinutes: 0,
  knownMinutes: 1440,
  lightsOnPct: 100,
  cutMinutes: 0,
  housesEveningMetersMissing: 0,
  dark: [],
  cuts: [],
  bins: 288,
  zone: "microgrid",
  timezone: "Africa/Kampala",
  unreadableTimestamps: null,
  sources: {
    battery: true,
    gridMeter: true,
    load: true,
    pv: true,
    houses: true,
    houseMetersUnreadable: 0,
  },
};

const SOURCES = CLEAR_DEFAULTS.sources;

const pending = (id: CaseId, microgrid: string, date: string): InvestigationCase => ({
  id,
  microgrid,
  date,
  mechanism: "pending",
  scenario: "clear",
  read: null,
});

/**
 * The 24 cases. kWh and percentages are stored as computed, unrounded; the
 * test compares kWh within 0.0005 and `lightsOnPct` within 0.005, and
 * minutes, bins and ranges exactly.
 *
 * C07 and C08 hold `computeSiteDay`'s own figures. §2's `null` summary
 * figures for them come from rule Z, which A2-3 applies to the evidence
 * summary only, so these stay true after it.
 */
export const CASES: readonly InvestigationCase[] = [
  {
    id: "C01", microgrid: "01", date: "2026-09-04", mechanism: "exists", scenario: "clear",
    read: { ok: true, figures: { housesEveningKwh: 6.715 } },
  },
  {
    id: "C02", microgrid: "01", date: "2026-09-01", mechanism: "exists", scenario: "evening-cut",
    read: { ok: true, figures: { cutMinutes: 90, cuts: [[1150, 1240]], housesEveningKwh: 6.773 } },
  },
  {
    id: "C03", microgrid: "01", date: "2026-09-02", mechanism: "exists", scenario: "long-cut-dark",
    read: {
      ok: true,
      figures: {
        darkMinutes: 165, dark: [[1185, 1350]], lightsOnPct: 88.54166666666667,
        cutMinutes: 240, cuts: [[1110, 1350]], housesEveningKwh: 3.077,
      },
    },
  },
  {
    id: "C04", microgrid: "01", date: "2026-10-01", mechanism: "exists", scenario: "floor-at-dawn",
    read: {
      ok: true,
      figures: {
        darkMinutes: 90, darkInferredMinutes: 90, dark: [[300, 390]], lightsOnPct: 93.75,
        cutMinutes: 90, cuts: [[300, 390]], housesEveningKwh: 6.711,
      },
    },
  },
  {
    id: "C05", microgrid: "01", date: "2026-09-15", mechanism: "exists", scenario: "gateway-gap",
    read: { ok: true, figures: { noDataMinutes: 45, knownMinutes: 1395, housesEveningKwh: 6.684 } },
  },
  {
    id: "C06", microgrid: "02", date: "2026-10-25", mechanism: "exists", scenario: "clear",
    read: {
      ok: true,
      figures: { bins: 300, knownMinutes: 1500, timezone: "Europe/London", housesEveningKwh: 6.632 },
    },
  },
  {
    id: "C07", microgrid: "03", date: "2026-09-11", mechanism: "exists", scenario: "floor-at-dawn",
    read: {
      ok: true,
      figures: {
        noDataMinutes: 90, knownMinutes: 1350, sources: { ...SOURCES, battery: false },
        housesEveningKwh: 6.734,
      },
    },
  },
  {
    id: "C08", microgrid: "04", date: "2026-09-03", mechanism: "exists", scenario: "long-cut-dark",
    read: {
      ok: true,
      figures: {
        darkMinutes: 170, darkInferredMinutes: 170, dark: [[1180, 1350]], lightsOnPct: 88.19444444444444,
        cutMinutes: null, cuts: null, sources: { ...SOURCES, gridMeter: false },
        housesEveningKwh: 2.9850000000000003,
      },
    },
  },
  {
    id: "C09", microgrid: "05", date: "2026-09-03", mechanism: "exists", scenario: "clear",
    read: {
      ok: true,
      figures: {
        housesEveningMetersMissing: 1, sources: { ...SOURCES, houseMetersUnreadable: 1 },
        housesEveningKwh: 6.725,
      },
    },
  },
  {
    id: "C10", microgrid: "06", date: "2026-09-01", mechanism: "exists", scenario: "clear",
    read: {
      ok: true,
      figures: { zone: "fallback", timezone: "UTC", housesEveningKwh: 6.7379999999999995 },
    },
  },
  {
    id: "C11", microgrid: "07", date: "2026-09-01", mechanism: "exists", scenario: "clear",
    read: { ok: true, figures: { sources: { ...SOURCES, pv: false }, housesEveningKwh: 6.679 } },
  },
  {
    id: "C12", microgrid: "08", date: "2026-09-01", mechanism: "exists", scenario: "clear",
    read: { ok: false, status: 404, code: "metering_no_site_devices" },
  },
  {
    id: "C13", microgrid: "09", date: "2026-09-01", mechanism: "exists", scenario: "clear",
    read: { ok: false, status: 409, code: "METERING_CONFIGURATION" },
  },
  {
    id: "C14", microgrid: "0a", date: "2026-09-01", mechanism: "exists", scenario: "clear",
    read: { ok: false, status: 409, code: "metering_disabled" },
  },
  // Pending: one microgrid each, on a day whose base is clear (A2-4).
  pending("C15", "0b", "2026-09-04"),
  pending("C16", "0c", "2026-09-04"),
  pending("C17", "0d", "2026-09-03"),
  pending("C18", "0e", "2026-09-06"),
  pending("C19", "0f", "2026-09-04"),
  pending("C20", "10", "2026-09-02"),
  pending("C21", "11", "2026-09-02"),
  pending("C22", "12", "2026-09-05"),
  pending("C23", "13", "2026-09-03"),
  pending("C24", "14", "2026-09-03"),
];
