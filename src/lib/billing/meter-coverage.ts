/**
 * Whether a tenant's primary meter links let MGM read a billing period from
 * the meter, as the bill engine decides it with effective-dated
 * assignments (`requireEffectiveDatedAssignments` and
 * `allowUsageOnlyReadings`, which composeBilling always sets).
 *
 * Pure. The engine (./generate.ts) uses the two date tests below, and
 * billing.generate-from-meters' prepare (./surface/period-review.ts) uses
 * `meterCoverage`, so what the confirmation says will be read from meters
 * and what the engine reads cannot drift apart.
 *
 * Assignments are half-open DATE ranges [effective_from, effective_to);
 * billing_periods stores an inclusive end date.
 */

export type AssignmentDates = { effective_from?: string | null; effective_to?: string | null };
export type PeriodDates = { start_date: string; end_date: string };

/** The assignment covers some day of the period. One without a start date covers none. */
export function overlapsPeriod(a: AssignmentDates, period: PeriodDates): boolean {
  return (
    Boolean(a.effective_from) &&
    a.effective_from! <= period.end_date &&
    (a.effective_to === null || a.effective_to === undefined || a.effective_to > period.start_date)
  );
}

/** The assignment covers every day of the period. */
export function coversPeriod(a: AssignmentDates, period: PeriodDates): boolean {
  return (
    Boolean(a.effective_from) &&
    a.effective_from! <= period.start_date &&
    (a.effective_to === null || a.effective_to === undefined || a.effective_to > period.end_date)
  );
}

type One<T> = T | T[] | null | undefined;
const one = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export type PrimaryMeterLink = AssignmentDates & {
  devices: One<{ openems_component_id: string | null; edges: One<{ openems_edge_id: string | null }> }>;
};

/**
 * - "metered": exactly one primary link covers the whole period, and its
 *   meter has an OpenEMS component on an edge with an OpenEMS id; the engine
 *   reads it (and reports `no_meter_reading` if the meter has no data).
 * - "assignment_gap": primary links exist, but none overlaps the period, or
 *   not exactly one covers it all; the engine reports
 *   `meter_assignment_continuity`.
 * - "no_meter": no primary link, or the covering meter has no OpenEMS ids;
 *   the engine reports `unmetered_no_manual`.
 * If the engine's choice of meter changes (generate.ts, the tenant loop
 * before "Compute the processed tenant set"), change this with it.
 */
export type MeterCoverage = "metered" | "assignment_gap" | "no_meter";

export function meterCoverage(primaryLinks: readonly PrimaryMeterLink[], period: PeriodDates): MeterCoverage {
  if (primaryLinks.length === 0) return "no_meter";
  const overlapping = primaryLinks.filter((l) => overlapsPeriod(l, period));
  if (overlapping.length === 0) return "assignment_gap";
  const covering = overlapping.filter((l) => coversPeriod(l, period));
  if (covering.length !== 1) return "assignment_gap";
  const device = one(covering[0].devices);
  const edge = one(device?.edges);
  if (!device?.openems_component_id || !edge?.openems_edge_id) return "no_meter";
  return "metered";
}
