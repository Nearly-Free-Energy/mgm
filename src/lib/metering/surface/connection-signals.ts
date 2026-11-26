import "server-only";

/**
 * The `metering.connection` watcher: the organization's microgrids whose
 * last OpenEMS connection check failed (./connection-signals-model.ts).
 *
 * One read of the microgrids through the person's own client (row-level
 * security), with no capability composed and no vendor call: the watcher
 * runs on every load of the signals, which an interface may poll, so it
 * reads the last check's stored result rather than asking OpenEMS. That is
 * why it reports a failed check, not stale readings: whether an edge is
 * online or a meter has reported lately is known only by asking OpenEMS.
 * Offline edges are the `metering.edge-status` watcher's, from a cached
 * read (./edge-status-signals.ts); a quiet meter is follow-up work. The columns read are in
 * MICROGRID_PUBLIC_COLUMNS (@/lib/types/microgrid-columns); the error text
 * is not read, since the signal's copy is fixed. The organization filter is
 * explicit, because a super admin's row-level security shows every
 * organization.
 *
 * A failed read throws, so the host lists the watcher as unchecked rather
 * than as having nothing to report; the error itself is not passed on.
 */
import { MAX_SIGNALS_PER_SOURCE, type SignalOut, type SurfaceRequest } from "@/lib/gui/surface";
import { FAILING_DISCOVER_STATUSES } from "../backend-health";
import { buildConnectionSignals, type ConnectionInput } from "./connection-signals-model";

type MicrogridRow = {
  id: string;
  name: string;
  timezone: string | null;
  ems_type: string | null;
  ems_last_discover_status: string | null;
  ems_last_discover_at: string | null;
  created_at: string;
};

export async function loadConnectionSignals(req: SurfaceRequest): Promise<SignalOut[]> {
  const { data, error } = await req.supabase
    .from("microgrids")
    .select("id, name, timezone, ems_type, ems_last_discover_status, ems_last_discover_at, created_at, communities!inner(org_id)")
    .eq("communities.org_id", req.organizationId)
    .not("ems_type", "is", null)
    .in("ems_last_discover_status", [...FAILING_DISCOVER_STATUSES])
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_SIGNALS_PER_SOURCE);
  if (error) throw new Error("metering.connection: the microgrids could not be read");
  const microgrids: ConnectionInput[] = ((data ?? []) as unknown as MicrogridRow[]).map((m) => ({
    id: m.id,
    name: m.name,
    timezone: m.timezone,
    emsType: m.ems_type,
    status: m.ems_last_discover_status,
    checkedAt: m.ems_last_discover_at,
    createdAt: m.created_at,
  }));
  return buildConnectionSignals(req.fmt, microgrids);
}
