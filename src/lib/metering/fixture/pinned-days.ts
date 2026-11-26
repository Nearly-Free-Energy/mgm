/**
 * pinned-days.ts — the fixture's pinned days: masks laid over the generated
 * samples of listed (microgrid, local date) days, for the investigation
 * cases a weighted scenario cannot give (docs/investigation-cases.md §1
 * "Rules that keep the set deterministic", C15 to C24).
 *
 * Pure: no clock, no I/O, no server-only import. `generateSiteSamples`
 * (site-samples.ts) reads the table. A mask only hides, resets or holds
 * values the generator has already drawn, so a pinned day's random stream,
 * battery and served load are its base day's, and every value outside a
 * mask is the base output.
 *
 * Why a table and not a new scenario: scenarios are picked by cumulative
 * weights (site-samples.ts `SCENARIOS`), so a new weight would move the
 * scenario of pinned dates whose draw falls in the moved range, and a
 * separate hash would reach every microgrid the generator serves. The table
 * lists only the case microgrids 0b to 14, which serve these cases alone,
 * so no other microgrid's day changes. pinned-days.test.ts holds the table
 * to that.
 */
import { MeteringError } from "../errors";
import { caseDeviceId, caseMicrogridId } from "./case-ids";

/** Local minutes of the day, `[start, end)`. */
export type PinnedWindow = [startMinute: number, endMinute: number];

/** What happens to one house meter's counter on a pinned day. */
export type MeterOverlay =
  /** The meter reports nothing in the window. */
  | { silent: PinnedWindow }
  /**
   * The counter restarts from zero at the first bin at or after this minute:
   * from there on it reads its base value less its base value at that bin.
   */
  | { resetAt: number }
  /** The counter stops at its value in the first bin at or after this minute. */
  | { holdFrom: number };

export type PinnedRefusal = {
  code: "METERING_UNREADABLE_TIMESTAMPS" | "METERING_UNAVAILABLE" | "METERING_INVALID_DATA";
  status: 502 | 503;
};

export type PinnedDay = {
  /** The gateway reports nothing: every series and every house counter is null. */
  gatewayDown?: PinnedWindow[];
  /**
   * The source sent these bins with timestamps it could not read: they are
   * left out of the samples and counted in `unreadableTimestamps`.
   */
  dropTimestamps?: PinnedWindow;
  /** Per house meter, by MGM device id. */
  meters?: Readonly<Record<string, MeterOverlay>>;
  /** The provider refuses any read whose window includes the day. */
  refuse?: PinnedRefusal;
};

/** Keyed by `pinnedDayKey(microgridId, date)`. */
export type PinnedDays = Readonly<Record<string, PinnedDay>>;

export const pinnedDayKey = (microgridId: string, date: string) => `${microgridId}|${date}`;

const at = (hour: number, minute = 0) => hour * 60 + minute;

/**
 * The pinned days. Each case has its own microgrid; each date's base day is
 * `clear` under `SITE_FIXTURE_SEED`, as is C21's day before, which
 * pinned-days.test.ts checks. docs/investigation-cases.md §2 states the same
 * pins; if either changes, change both.
 */
export const PINNED_DAYS: PinnedDays = {
  // C15: one tenant meter silent across the whole start search (bins 208 to
  // 216), so it has no start.
  [pinnedDayKey(caseMicrogridId("0b"), "2026-09-04")]: {
    meters: { [caseDeviceId("0b", "11")]: { silent: [at(17, 20), at(18, 5)] } },
  },
  // C16: the gateway down from 23:20 to midnight, so no meter has an end.
  [pinnedDayKey(caseMicrogridId("0c"), "2026-09-04")]: {
    gatewayDown: [[at(23, 20), at(24)]],
  },
  // C17: one meter's counter reset at 20:00, so it ends below its start.
  [pinnedDayKey(caseMicrogridId("0d"), "2026-09-03")]: {
    meters: { [caseDeviceId("0d", "12")]: { resetAt: at(20) } },
  },
  // C18: 30 bins with unreadable timestamps, 14:00 to 16:30.
  [pinnedDayKey(caseMicrogridId("0e"), "2026-09-06")]: {
    dropTimestamps: [at(14), at(16, 30)],
  },
  // C19: most timestamps unreadable. The OpenEMS provider refuses that by
  // counting (openems-provider.ts); the fixture has no such count, so the
  // day refuses directly.
  [pinnedDayKey(caseMicrogridId("0f"), "2026-09-04")]: {
    refuse: { code: "METERING_UNREADABLE_TIMESTAMPS", status: 502 },
  },
  // C20: the provider unavailable.
  [pinnedDayKey(caseMicrogridId("10"), "2026-09-02")]: {
    refuse: { code: "METERING_UNAVAILABLE", status: 503 },
  },
  // C21: the gateway down from 23:00 on the day before to 03:00.
  [pinnedDayKey(caseMicrogridId("11"), "2026-09-01")]: {
    gatewayDown: [[at(23), at(24)]],
  },
  [pinnedDayKey(caseMicrogridId("11"), "2026-09-02")]: {
    gatewayDown: [[at(0), at(3)]],
  },
  // C22: one meter's counter flat from 17:00, so it uses nothing all evening.
  [pinnedDayKey(caseMicrogridId("12"), "2026-09-05")]: {
    meters: { [caseDeviceId("12", "12")]: { holdFrom: at(17) } },
  },
  // C23: meter 12's counter reset at 20:00; meter 13 is a legacy row with no
  // component id (CASE_VARIANTS), which no overlay gives.
  [pinnedDayKey(caseMicrogridId("13"), "2026-09-03")]: {
    meters: { [caseDeviceId("13", "12")]: { resetAt: at(20) } },
  },
  // C24: the provider refuses its data as invalid.
  [pinnedDayKey(caseMicrogridId("14"), "2026-09-03")]: {
    refuse: { code: "METERING_INVALID_DATA", status: 502 },
  },
};

const REFUSAL_MESSAGES: Record<PinnedRefusal["code"], string> = {
  METERING_UNREADABLE_TIMESTAMPS:
    "Synthetic data: this day's samples are pinned as having mostly unreadable timestamps.",
  METERING_UNAVAILABLE: "Synthetic data: the metering source is pinned as unavailable on this day.",
  METERING_INVALID_DATA: "Synthetic data: this day's samples are pinned as data MGM cannot use.",
};

/** The error a pinned day's refusal throws. */
export function pinnedRefusalError(
  refusal: PinnedRefusal,
  microgridId: string,
  date: string
): MeteringError {
  return new MeteringError(REFUSAL_MESSAGES[refusal.code], refusal.code, refusal.status, {
    microgridId,
    date,
  });
}
