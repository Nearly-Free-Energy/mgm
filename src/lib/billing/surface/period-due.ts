import "server-only";

/**
 * The `billing.period-due` watcher: the organization's draft billing
 * periods whose last day has passed in the period's own time zone, each as
 * one signal (./period-due-model.ts).
 *
 * One read through the person's own client (row-level security), composing
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
import { dayKeyInZone } from "@/lib/timezone/day-key";
import { buildPeriodDueSignals, type DuePeriodInput } from "./period-due-model";

/**
 * Rows read, oldest first. A period that has not ended in its own zone can
 * only end on the latest dates the read returns (every zone's date is
 * within a day of UTC's), so twice the signal cap always holds the oldest
 * that have.
 */
const MAX_ROWS = MAX_SIGNALS_PER_SOURCE * 2;

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

export async function loadPeriodDue(req: SurfaceRequest): Promise<SignalOut[]> {
  // No zone's date is more than a day ahead of UTC's, so a period that has
  // ended anywhere ended on or before today's UTC date; the model keeps
  // those that ended in their own zone.
  const { data, error } = await req.supabase
    .from("billing_periods")
    .select("id, microgrid_id, start_date, end_date, timezone, billing_line_items(count), microgrids!inner(id, name, communities!inner(org_id))")
    .eq("status", "draft")
    .eq("microgrids.communities.org_id", req.organizationId)
    .lte("end_date", dayKeyInZone(req.now, "UTC"))
    .order("end_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_ROWS);
  if (error) throw new Error("billing.period-due: the periods could not be read");
  const periods: DuePeriodInput[] = ((data ?? []) as unknown as PeriodRow[]).map((row) => ({
    id: row.id,
    microgridId: row.microgrid_id,
    microgridName: one(row.microgrids)?.name ?? "",
    startDate: row.start_date,
    endDate: row.end_date,
    timezone: row.timezone,
    bills: row.billing_line_items?.[0]?.count ?? 0,
  }));
  return buildPeriodDueSignals(req.fmt, periods, req.now);
}
