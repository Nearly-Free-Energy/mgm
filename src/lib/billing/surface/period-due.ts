import "server-only";

/**
 * The `billing.period-due` watcher: the organization's draft billing
 * periods whose last day has passed in the period's own time zone, each as
 * one signal (./period-due-model.ts).
 *
 * Reads through the person's own client (row-level security), composing
 * no capability: billing_periods and billing_line_items are FOR ALL on
 * user_can_access_microgrid, microgrids and communities on the
 * organization's access, as the billing pages read them. If their policies
 * change, revisit what this shows. The organization filter is explicit,
 * because a super admin's row-level security shows every organization.
 *
 * The host runs this only while billing is on for the organization: a
 * period cannot be closed or billed while billing is off, so its signals
 * are left out then, not listed as unchecked.
 *
 * A failed read throws, so the host lists the watcher as unchecked rather
 * than as having nothing to report; the error itself is not passed on.
 */
import { MAX_SIGNALS_PER_SOURCE, type SignalOut, type SurfaceRequest } from "@/lib/gui/surface";
import { addDaysToDateKey, dayKeyInZone } from "@/lib/timezone/day-key";
import { buildPeriodDueSignals, type DuePeriodInput } from "./period-due-model";

/**
 * Why two reads. Every zone's date is within a day of UTC's, so a period
 * ending before yesterday's UTC date has ended in every zone, and one
 * ending after today's UTC date has ended in none. Only periods ending on
 * those two UTC dates depend on their zone, and they share their dates
 * with periods in other zones that have ended, so a single read cut at a
 * row count could fill with periods that have not ended and drop ones
 * that have. The first read takes periods that have certainly ended,
 * oldest first, up to the signal cap; only if it is short does the second
 * read take the two edge dates whole, and the model keeps those that have
 * ended in their own zone.
 *
 * EDGE_ROWS bounds the second read. If an organization has that many draft
 * periods ending on those two dates, the read cannot tell which have
 * ended, so it throws and the host lists the watcher as unchecked rather
 * than leaving due periods out.
 */
const EDGE_ROWS = MAX_SIGNALS_PER_SOURCE * 10;

const COLUMNS =
  "id, microgrid_id, start_date, end_date, timezone, billing_line_items(count), microgrids!inner(id, name, communities!inner(org_id))";

type Embedded<T> = T | T[] | null;
type PeriodRow = {
  id: string;
  microgrid_id: string;
  start_date: string;
  end_date: string;
  timezone: string;
  billing_line_items: { count: number }[] | null;
  microgrids: Embedded<{ id: string; name: string }>;
};
const one = <T>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

const toInput = (row: PeriodRow): DuePeriodInput => ({
  id: row.id,
  microgridId: row.microgrid_id,
  microgridName: one(row.microgrids)?.name ?? "",
  startDate: row.start_date,
  endDate: row.end_date,
  timezone: row.timezone,
  bills: row.billing_line_items?.[0]?.count ?? 0,
});

export async function loadPeriodDue(req: SurfaceRequest): Promise<SignalOut[]> {
  const today = dayKeyInZone(req.now, "UTC");
  const yesterday = addDaysToDateKey(today, -1);
  const drafts = () =>
    req.supabase.from("billing_periods").select(COLUMNS).eq("status", "draft").eq("microgrids.communities.org_id", req.organizationId);

  const ended = await drafts()
    .lt("end_date", yesterday)
    .order("end_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_SIGNALS_PER_SOURCE);
  if (ended.error) throw new Error("billing.period-due: the periods could not be read");
  const periods = ((ended.data ?? []) as unknown as PeriodRow[]).map(toInput);

  if (periods.length < MAX_SIGNALS_PER_SOURCE) {
    const edge = await drafts()
      .gte("end_date", yesterday)
      .lte("end_date", today)
      .order("end_date", { ascending: true })
      .order("id", { ascending: true })
      .limit(EDGE_ROWS);
    if (edge.error) throw new Error("billing.period-due: the periods could not be read");
    const rows = (edge.data ?? []) as unknown as PeriodRow[];
    if (rows.length >= EDGE_ROWS) throw new Error("billing.period-due: too many periods end on the latest dates to tell which have ended");
    periods.push(...rows.map(toInput));
  }
  return buildPeriodDueSignals(req.fmt, periods, req.now);
}
