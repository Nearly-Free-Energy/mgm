import "server-only";

/**
 * The `billing.period-missing` watcher: the organization's microgrids with a
 * metered tenant last month and no billing period for it
 * (./period-missing-model.ts).
 *
 * Reads through the person's own client (row-level security), composing no
 * capability: microgrids and communities on the organization's access,
 * billing_periods FOR ALL on user_can_access_microgrid, tenants and
 * tenant_devices on the tenant's microgrid, as the billing pages read them.
 * If their policies change, revisit what this shows. The organization filter
 * is explicit on the microgrids and periods reads, because a super admin's
 * row-level security shows every organization; the tenant reads take
 * microgrid ids from the first.
 *
 * Three reads at most, in order: the organization's microgrids; the
 * organization's periods with a day in any of their expected months; then,
 * only for microgrids with no such period, whether any tenant had a primary
 * meter assignment during the month, one bounded read per microgrid, a few
 * at a time, until MAX_SIGNALS_PER_SOURCE are found. Usually every
 * microgrid has its period and the third read never runs.
 *
 * The host runs this only while billing is on for the organization: no
 * period can be created while billing is off.
 *
 * A failed read throws, and so does a read that reaches its bound, so the
 * host lists the watcher as unchecked rather than as having nothing to
 * report; the error itself is not passed on.
 */
import { MAX_SIGNALS_PER_SOURCE, type SignalOut, type SurfaceRequest } from "@/lib/gui/surface";
import { overlapsPeriod, type PeriodDates } from "../meter-coverage";
import { buildPeriodMissingSignals, expectedMonth, periodTouches, type MissingMicrogrid } from "./period-missing-model";

/** The most microgrids one organization may have for this watcher to check them all. */
const MICROGRID_ROWS = 500;
/**
 * The most periods with a day in last month the organization may have for one
 * read. Below PostgREST's row cap (`max_rows = 1000` in supabase/config.toml,
 * as on the hosted project), which would cut a longer answer short without an
 * error: a read of PERIOD_ROWS + 1 rows must be able to come back whole, so a
 * full one is reported as unchecked rather than taken for missing periods. If
 * that cap is lowered, lower this below it.
 */
const PERIOD_ROWS = 999;
/** Microgrids whose tenants are read at once. */
const TENANT_READS_AT_ONCE = 10;
/**
 * The assignment role the bill engine bills from (generate.ts's tenant read,
 * and meterCoverage in ../meter-coverage.ts). If the engine reads another
 * role, revisit.
 */
const METERED_ROLE = "primary_consumption_meter";

type MicrogridRow = { id: string; name: string; timezone: string };
type PeriodRow = { microgrid_id: string; start_date: string; end_date: string };
type AssignmentRow = { effective_from: string | null; effective_to: string | null };

/** Whether any tenant of the microgrid had a primary meter assignment on some day of `month`. */
async function hadMeteredTenant(req: SurfaceRequest, microgridId: string, month: PeriodDates): Promise<boolean> {
  const { data, error } = await req.supabase
    .from("tenant_devices")
    .select("effective_from, effective_to, tenants!inner(microgrid_id)")
    .eq("role", METERED_ROLE)
    .eq("tenants.microgrid_id", microgridId)
    // overlapsPeriod's test, in SQL, so one row answers; the rows are checked with it again below.
    .lte("effective_from", month.end_date)
    .or(`effective_to.is.null,effective_to.gt.${month.start_date}`)
    .limit(1);
  if (error) throw new Error("billing.period-missing: the tenants could not be read");
  return ((data ?? []) as AssignmentRow[]).some((a) => overlapsPeriod(a, month));
}

export async function loadPeriodMissing(req: SurfaceRequest): Promise<SignalOut[]> {
  const microgrids = await req.supabase
    .from("microgrids")
    .select("id, name, timezone, communities!inner(org_id)")
    .eq("communities.org_id", req.organizationId)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(MICROGRID_ROWS + 1);
  if (microgrids.error) throw new Error("billing.period-missing: the microgrids could not be read");
  const rows = (microgrids.data ?? []) as unknown as MicrogridRow[];
  if (rows.length > MICROGRID_ROWS) throw new Error("billing.period-missing: too many microgrids to check");

  const expected = rows.flatMap((m) => {
    const month = expectedMonth(m.timezone, req.now);
    return month ? [{ microgrid: m, month }] : [];
  });
  if (expected.length === 0) return [];

  // Every expected month is the previous month of a date within a day of UTC's, so this window is a month or two at most.
  const from = expected.reduce((min, e) => (e.month.start_date < min ? e.month.start_date : min), expected[0].month.start_date);
  const to = expected.reduce((max, e) => (e.month.end_date > max ? e.month.end_date : max), expected[0].month.end_date);
  const periods = await req.supabase
    .from("billing_periods")
    .select("microgrid_id, start_date, end_date, microgrids!inner(communities!inner(org_id))")
    .eq("microgrids.communities.org_id", req.organizationId)
    .lte("start_date", to)
    .gte("end_date", from)
    .limit(PERIOD_ROWS + 1);
  if (periods.error) throw new Error("billing.period-missing: the periods could not be read");
  const periodRows = (periods.data ?? []) as unknown as PeriodRow[];
  if (periodRows.length > PERIOD_ROWS) throw new Error("billing.period-missing: too many periods to check");

  const without = expected.filter(({ microgrid, month }) => !periodRows.some((p) => p.microgrid_id === microgrid.id && periodTouches(p, month)));
  const missing: MissingMicrogrid[] = [];
  for (let i = 0; i < without.length && missing.length < MAX_SIGNALS_PER_SOURCE; i += TENANT_READS_AT_ONCE) {
    const batch = without.slice(i, i + TENANT_READS_AT_ONCE);
    const metered = await Promise.all(batch.map(({ microgrid, month }) => hadMeteredTenant(req, microgrid.id, month)));
    batch.forEach(({ microgrid }, j) => {
      if (metered[j]) missing.push({ id: microgrid.id, name: microgrid.name, timezone: microgrid.timezone });
    });
  }
  return buildPeriodMissingSignals(req.fmt, missing, req.now);
}
