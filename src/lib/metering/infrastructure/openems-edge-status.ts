/**
 * The OpenEMS edge-status reader (../edge-status.ts): for each microgrid, a
 * client built from its stored configuration asks getEdgesStatus about its
 * edges, through the cache in ./edge-status-cache.ts.
 *
 * It decrypts stored credentials (getMicrogridEmsConfig), so it is handed
 * out only for a composition of the metering capability: composeMetering has
 * asked Supabase Auth about the session (getUser), checked the person's
 * access to the organization and found metering on, as CLAUDE.md
 * "Session checks before privilege" requires. getMicrogridEmsConfig reads
 * each microgrid's row through the person's own client before any decrypt,
 * so a microgrid they cannot see is never read for them. The structured log
 * carries counts, an MGM error code and durations only: never a credential,
 * an edge id or the backend's text.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import type { MeteringComposition } from "../compose";
import type { EdgeStatusOutcome, EdgeStatusSite, MeteringEdgeStatusCapabilityContract } from "../edge-status";
import { cachedEdgeStatus, type EdgeStatusRead } from "./edge-status-cache";

/**
 * Microgrids read at once by one call. An organization with more waits for
 * a free slot, and a microgrid whose turn comes too late to finish by the
 * deadline is "late" this time and read on a later load, when the others
 * come from the cache.
 */
export const EDGE_STATUS_CONCURRENCY = 4;

/** The read of one microgrid's edges, as the cache calls it. Exported for tests. */
export function openEmsEdgeStatusRead(supabase: SupabaseClient, microgridId: string, edgeIds: readonly string[]) {
  return async (signal: AbortSignal): Promise<EdgeStatusRead> => {
    const config = await getMicrogridEmsConfig(supabase, microgridId);
    // The watcher read the microgrid with a backend configured a moment ago;
    // none now (removed since) is a read that could not be made.
    if (!config) throw new Error("no OpenEMS configuration");
    if (signal.aborted) throw new Error("timed out");
    return createOpenEmsClient(config).getEdgesStatus([...edgeIds], { signal });
  };
}

function logFailure(authorized: MeteringComposition, microgridId: string, startedAt: number, error: unknown) {
  console.warn(
    JSON.stringify({
      event: "metering.edge_status_failed",
      organization_id: authorized.scope.organizationId,
      microgrid_id: microgridId,
      code: error instanceof OpenEmsError ? error.code : "other",
      duration_ms: Date.now() - startedAt,
    }),
  );
}

/**
 * A reader for the organization `authorized` was composed for. The caller
 * passes only microgrids it read for that organization through `supabase`,
 * the person's own client, which is also the composition's.
 */
export function createEdgeStatusReader(
  authorized: MeteringComposition,
  supabase: SupabaseClient,
  o: { now?: () => number; read?: typeof openEmsEdgeStatusRead } = {},
): MeteringEdgeStatusCapabilityContract {
  const now = o.now ?? Date.now;
  const makeRead = o.read ?? openEmsEdgeStatusRead;
  return {
    async getEdgeStatuses(sites: readonly EdgeStatusSite[], deadlineMs: number): Promise<EdgeStatusOutcome[]> {
      const out: EdgeStatusOutcome[] = new Array(sites.length);
      let next = 0;
      const worker = async () => {
        while (next < sites.length) {
          const i = next++;
          const { microgridId, edgeIds } = sites[i];
          const read = makeRead(supabase, microgridId, edgeIds);
          const logged = async (signal: AbortSignal) => {
            const startedAt = Date.now();
            try {
              return await read(signal);
            } catch (error) {
              logFailure(authorized, microgridId, startedAt, error);
              throw error;
            }
          };
          const answer = await cachedEdgeStatus(microgridId, edgeIds, logged, { deadlineMs, now });
          out[i] =
            answer.state === "late"
              ? { microgridId, state: "late" }
              : answer.state === "failed"
                ? { microgridId, state: "failed", readAt: new Date(answer.readAt).toISOString() }
                : { microgridId, state: "read", total: answer.total, offline: answer.offline, readAt: new Date(answer.readAt).toISOString() };
        }
      };
      await Promise.all(Array.from({ length: Math.min(EDGE_STATUS_CONCURRENCY, sites.length) }, worker));
      return out;
    },
  };
}
