import "server-only";

/**
 * The loader of the `billing.current-periods` view
 * (./current-periods-model.ts): the organization's microgrids, by name,
 * each with its newest billing period and how many bills it holds.
 *
 * Reads through the person's own client (row-level security) and composes
 * no capability: microgrids and communities are read on the organization's
 * access, billing_periods and billing_line_items FOR ALL on
 * user_can_access_microgrid, as the billing pages read them. If their
 * policies change, revisit what this shows. The organization filter is
 * explicit, because a super admin's row-level security shows every
 * organization. The microgrid columns are named, never `*`
 * (no-microgrid-star-select.test.ts).
 *
 * Loads while billing is off, with the gate's notice, on its own page; the
 * host leaves the tile off Today then (attachedViews in
 * src/lib/gui/host/server/view.ts drops a disabled plugin's tiles). A
 * refusal carries fixed copy, never a database message.
 */
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { buildCurrentPeriodsModel, MAX_CURRENT_PERIODS, type CurrentPeriodInput } from "./current-periods-model";

const COLUMNS =
  "id, name, communities!inner(org_id), billing_periods(id, start_date, end_date, status, billing_line_items(count))";

type Row = {
  id: string;
  name: string;
  billing_periods:
    | { id: string; start_date: string; end_date: string; status: "draft" | "closed"; billing_line_items: { count: number }[] | null }[]
    | null;
};

export const CURRENT_PERIODS_UNAVAILABLE = {
  ok: false,
  status: 503,
  message: "Could not load the billing periods right now. Try again shortly.",
} as const;

export async function loadCurrentPeriods(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const { data, error } = await req.supabase
    .from("microgrids")
    .select(COLUMNS)
    .eq("communities.org_id", req.organizationId)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    // The newest period of each microgrid only.
    .order("start_date", { referencedTable: "billing_periods", ascending: false })
    .order("id", { referencedTable: "billing_periods", ascending: false })
    .limit(1, { referencedTable: "billing_periods" })
    .limit(MAX_CURRENT_PERIODS + 1);
  if (error || !data) return CURRENT_PERIODS_UNAVAILABLE;
  const microgrids: CurrentPeriodInput[] = (data as unknown as Row[]).map((row) => {
    const period = row.billing_periods?.[0];
    return {
      microgridId: row.id,
      microgridName: row.name,
      period: period
        ? {
            id: period.id,
            start_date: period.start_date,
            end_date: period.end_date,
            status: period.status,
            bills: period.billing_line_items?.[0]?.count ?? 0,
          }
        : null,
    };
  });
  return { ok: true, model: buildCurrentPeriodsModel(req.fmt, microgrids) };
}
