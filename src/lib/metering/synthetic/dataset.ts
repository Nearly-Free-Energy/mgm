/**
 * The synthetic demonstration dataset (issue #44): neutral households and
 * meters with obviously fake identifiers. Pure data, no server imports.
 *
 * Everything here is invented. Identifiers carry the SYNTHETIC- prefix so a
 * synthetic meter can never be mistaken for, or routed as, a real one.
 * `supabase/scripts/load-synthetic-demo.sql` creates exactly these rows;
 * `__tests__/dataset.test.ts` keeps the two in step.
 */

/** Prefix of the demonstration edge's `openems_edge_id` (the routing marker). */
export const SYNTHETIC_EDGE_ID = "SYNTHETIC-EDGE-001";
export const SYNTHETIC_EDGE_ID_PREFIX = "SYNTHETIC-EDGE-";
export const SYNTHETIC_COMPONENT_PREFIX = "SYNTHETIC-METER-";

/** The month the demonstration readings are intended for. */
export const DEMO_PERIOD = {
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  timezone: "Africa/Kampala",
} as const;

/**
 * - `low` / `typical` / `high`: complete data, different daily usage bands.
 * - `interior-gap`: days with no reading in the middle of the month. The
 *   meter is a cumulative register, so usage is still known.
 * - `boundary-gap`: no reading on the closing day. Usage cannot be
 *   established; the result is null, never zero.
 * - `no-data`: the meter never reported. Null, never zero.
 */
export type SyntheticProfile =
  | "low"
  | "typical"
  | "high"
  | "interior-gap"
  | "boundary-gap"
  | "no-data";

export type SyntheticMeter = {
  componentId: string;
  householdName: string;
  unitLabel: string;
  profile: SyntheticProfile;
};

const PROFILES: readonly SyntheticProfile[] = [
  "low",
  "typical",
  "typical",
  "high",
  "typical",
  "interior-gap",
  "boundary-gap",
  "no-data",
];

export const SYNTHETIC_METERS: readonly SyntheticMeter[] = PROFILES.map(
  (profile, index) => {
    const n = String(index + 1).padStart(3, "0");
    return {
      componentId: `${SYNTHETIC_COMPONENT_PREFIX}${n}`,
      householdName: `Synthetic Household ${n}`,
      unitLabel: `SYN-${n}`,
      profile,
    };
  }
);

/** Days (inclusive) without a reading for the `interior-gap` meter. */
export const INTERIOR_GAP = { from: "2026-09-10", to: "2026-09-12" } as const;
/** The one day without a reading for the `boundary-gap` meter. */
export const BOUNDARY_GAP_DAY = "2026-09-30";

export function findSyntheticMeter(componentId: string): SyntheticMeter | undefined {
  return SYNTHETIC_METERS.find((meter) => meter.componentId === componentId);
}
