import "server-only";

/**
 * The `metering.edge-status` watcher: the organization's microgrids with an
 * OpenEMS gateway (edge) offline now, with a meter on an online gateway that
 * has stopped reporting, or whose gateways' status or meters could not be
 * read (./edge-status-signals-model.ts). Where `metering.connection` reports
 * the stored result of the last Discover or connection test, this asks the
 * backend, through a cache (mgm#287, decision 3 on #230; ADR-006 decision 9).
 *
 * 1. One read of the organization's microgrids with a backend configured
 *    and at least one edge, through the person's own client (row-level
 *    security), with the organization filter explicit, because a super
 *    admin's row-level security shows every organization. The columns read
 *    are in MICROGRID_PUBLIC_COLUMNS (@/lib/types/microgrid-columns), with
 *    each edge's meters (METER_DEVICE_TYPES with a component id). Every
 *    such microgrid is examined, up to EDGE_STATUS_MICROGRID_BOUND; a failed
 *    read, or one that reaches the bound, throws, so the host lists the
 *    watcher as unchecked rather than leaving microgrids out unseen.
 * 2. With none, nothing else runs: no composition and no backend read, so
 *    an organization without OpenEMS (a local database, the browser smoke)
 *    costs one query and stays deterministic.
 * 3. composeMetering settles the session (getUser), the person's access to
 *    the organization and metering being on, and only then is a reader
 *    built (../infrastructure/openems-edge-status.ts), which decrypts each
 *    microgrid's stored credential on a cache miss. A composition refused
 *    throws (unchecked).
 * 4. Each microgrid's status and, beside it, its meters' recent history
 *    are read (../infrastructure/meter-activity.ts). Each answer is cached
 *    (five minutes, a failure one minute),
 *    a read under way is shared, at most a few run at once in the process,
 *    microgrids never read or read longest ago go first, and a read still
 *    under way at this watcher's deadline finishes into the cache for the
 *    next load. A microgrid whose read failed, timed out or gave no answer in
 *    time is a signal that its status could not be read, not a reason to
 *    call the whole watcher unchecked. A meter read that failed is a signal
 *    that the meters could not be checked; one with no answer in time is
 *    left for the next load, which finds it in the cache (the gateway
 *    signals already say whether the backend answers at all).
 * 5. At most MAX_SIGNALS_PER_SOURCE signals go back, offline gateways first,
 *    then quiet meters (./edge-status-signals-model.ts).
 *
 * The host runs this only while metering is on for the organization
 * (collectOrganizationSignals skips a watcher whose plugin gate answers 409,
 * and contribution-schema.ts refuses `whilePluginOff` on any watcher but
 * Payments'), and composeMetering checks again before any backend read.
 */
import type { SignalOut, SurfaceRequest } from "@/lib/gui/surface";
import { composeMetering } from "../compose";
import type { EdgeStatusSite } from "../edge-status";
import { METER_DEVICE_TYPES } from "../infrastructure/meter-activity";
import { createEdgeStatusReader } from "../infrastructure/openems-edge-status";
import { buildEdgeStatusSignals, type EdgeStatusMicrogrid } from "./edge-status-signals-model";

/**
 * The watcher's budget: the session check and the composition (getUser, the
 * person's roles, the plugin state), the microgrid read, then one round of
 * backend reads of up to EDGE_STATUS_READ_TIMEOUT_MS (2 s,
 * ../infrastructure/edge-status-cache.ts). The host's default 1.5 s would not
 * fit a single read's timeout; more than 3 s would hold Today's first load
 * (it takes signals) for longer than a cached answer is worth.
 */
export const EDGE_STATUS_BUDGET_MS = 3_000;
/** Kept back from the budget for the host's parse of the answer: the watcher stops waiting this long before it ends. */
const EDGE_STATUS_MARGIN_MS = 250;
/**
 * The most microgrids with OpenEMS one organization may have for the
 * watcher to examine them all. It reads one row more, and throws when that
 * row comes back, so an organization past the bound shows the watcher as
 * unchecked rather than some microgrids as silently fine. Below PostgREST's
 * `max_rows` (1000, supabase/config.toml), which would otherwise cut the
 * read short without saying so; if that setting drops below this bound
 * plus one, lower the bound with it.
 */
export const EDGE_STATUS_MICROGRID_BOUND = 500;

type MicrogridRow = {
  id: string;
  name: string;
  timezone: string | null;
  edges: { openems_edge_id: string | null; devices: { openems_component_id: string | null; device_type: string }[] | null }[] | null;
};

const METER_TYPES: ReadonlySet<string> = new Set(METER_DEVICE_TYPES);

export async function loadEdgeStatusSignals(req: SurfaceRequest, o: { now?: () => number } = {}): Promise<SignalOut[]> {
  const now = o.now ?? Date.now;
  const deadlineMs = now() + EDGE_STATUS_BUDGET_MS - EDGE_STATUS_MARGIN_MS;
  const { data, error } = await req.supabase
    .from("microgrids")
    .select("id, name, timezone, communities!inner(org_id), edges!inner(openems_edge_id, devices(openems_component_id, device_type))")
    .eq("communities.org_id", req.organizationId)
    .not("ems_type", "is", null)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(EDGE_STATUS_MICROGRID_BOUND + 1);
  if (error) throw new Error("metering.edge-status: the microgrids could not be read");
  if ((data ?? []).length > EDGE_STATUS_MICROGRID_BOUND) throw new Error("metering.edge-status: too many microgrids to examine");
  const microgrids: EdgeStatusMicrogrid[] = [];
  const sites: EdgeStatusSite[] = [];
  for (const m of (data ?? []) as unknown as MicrogridRow[]) {
    const edgeIds = [...new Set((m.edges ?? []).flatMap((e) => (typeof e.openems_edge_id === "string" && e.openems_edge_id !== "" ? [e.openems_edge_id] : [])))];
    if (edgeIds.length === 0) continue;
    const meters = (m.edges ?? []).flatMap((e) =>
      typeof e.openems_edge_id === "string" && e.openems_edge_id !== ""
        ? (e.devices ?? []).flatMap((d) =>
            METER_TYPES.has(d.device_type) && typeof d.openems_component_id === "string" && d.openems_component_id !== ""
              ? [{ edgeId: e.openems_edge_id as string, componentId: d.openems_component_id }]
              : [],
          )
        : [],
    );
    microgrids.push({ id: m.id, name: m.name, timezone: m.timezone });
    sites.push({ microgridId: m.id, edgeIds, meters });
  }
  if (sites.length === 0) return [];

  const composed = await composeMetering({ supabase: req.supabase, organizationId: req.organizationId });
  if (!composed.ok) throw new Error(`metering.edge-status: the capability could not be composed (${composed.status})`);
  try {
    const outcomes = await createEdgeStatusReader(composed.data, req.supabase, { now }).getEdgeStatuses(sites, deadlineMs);
    return buildEdgeStatusSignals(req.fmt, microgrids, outcomes, req.now);
  } finally {
    await composed.data.dispose();
  }
}
