/**
 * The OpenEMS edge-status reader (../edge-status.ts): for each microgrid, a
 * client built from its stored configuration asks getEdgesStatus about its
 * edges and, beside it, each meter's recent power history
 * (./meter-activity.ts), each through the cache in ./edge-status-cache.ts.
 * The configuration is read and decrypted once per microgrid per call, for
 * whichever of the two reads asks first.
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
import type { EdgeStatusOutcome, EdgeStatusSite, MeterActivityOutcome, MeteringEdgeStatusCapabilityContract } from "../edge-status";
import {
  cachedEdgeStatus,
  cachedMeterActivity,
  lastReadAt,
  type EdgeStatusAnswer,
  type EdgeStatusRead,
  type MeterActivityAnswer,
  type MeterActivityRead,
  type MeterRef,
} from "./edge-status-cache";
import { readMeterActivity } from "./meter-activity";

type Client = ReturnType<typeof createOpenEmsClient>;
/** A microgrid's client, built on first use and shared by its reads in one call. */
type ClientOf = () => Promise<Client>;

/**
 * The client for a microgrid's stored configuration, built once however
 * many reads ask for it. getMicrogridEmsConfig reads the row through the
 * person's own client before it decrypts anything.
 */
export function lazyClient(supabase: SupabaseClient, microgridId: string): ClientOf {
  let client: Promise<Client> | undefined;
  return () =>
    (client ??= getMicrogridEmsConfig(supabase, microgridId).then((config) => {
      // The watcher read the microgrid with a backend configured a moment ago;
      // none now (removed since) is a read that could not be made.
      if (!config) throw new Error("no OpenEMS configuration");
      return createOpenEmsClient(config);
    }));
}

/**
 * The order one call asks for its sites in: those with no kept answer
 * first, then the stalest kept answer or failure, then the rest, the order
 * given breaking ties. Reads wait for the process's slots in this order
 * (EDGE_STATUS_CONCURRENCY in ./edge-status-cache.ts), so when not every
 * site can be read before the deadline, the next load starts where this one
 * stopped instead of at the first site again.
 */
export function readingOrder(sites: readonly EdgeStatusSite[]): number[] {
  const kept = sites.map((s) => lastReadAt(s.microgridId, s.edgeIds) ?? -Infinity);
  return sites.map((_, i) => i).sort((a, b) => kept[a] - kept[b] || a - b);
}

/** The read of one microgrid's edges, as the cache calls it. Exported for tests. */
export function openEmsEdgeStatusRead(
  supabase: SupabaseClient,
  microgridId: string,
  edgeIds: readonly string[],
  clientOf: ClientOf = lazyClient(supabase, microgridId),
) {
  return async (signal: AbortSignal): Promise<EdgeStatusRead> => {
    const client = await clientOf();
    if (signal.aborted) throw new Error("timed out");
    return client.getEdgesStatus([...edgeIds], { signal });
  };
}

/** The read of one microgrid's meters, as the cache calls it. Exported for tests. */
export function openEmsMeterActivityRead(
  supabase: SupabaseClient,
  microgridId: string,
  meters: readonly MeterRef[],
  now: () => number,
  clientOf: ClientOf = lazyClient(supabase, microgridId),
  onEdgeFailure?: (error: unknown) => void,
) {
  return async (signal: AbortSignal): Promise<MeterActivityRead> => {
    const client = await clientOf();
    if (signal.aborted) throw new Error("timed out");
    return readMeterActivity(client, microgridId, meters, now(), signal, onEdgeFailure);
  };
}

/**
 * The meter outcome for a site whose status was read: the meters on the
 * edges the status answer says are online, and how many of those the meter
 * answer calls quiet. None on an online edge, no outcome: an offline
 * gateway's meters are the offline signal's to report. A failed edge
 * fails the outcome only when it is online; one the backend does not know,
 * a gateway long gone, is already offline and changes nothing.
 */
export function meterOutcome(
  meters: readonly MeterRef[],
  status: Extract<EdgeStatusAnswer, { state: "read" }>,
  answer: MeterActivityAnswer,
): MeterActivityOutcome | undefined {
  const online = new Set(status.online);
  const key = (m: MeterRef) => JSON.stringify([m.edgeId, m.componentId]);
  const asked = new Set(meters.filter((m) => online.has(m.edgeId)).map(key));
  if (asked.size === 0) return undefined;
  if (answer.state === "late") return { state: "late" };
  if (answer.state === "failed" || answer.failedEdges.some((edgeId) => online.has(edgeId))) {
    return { state: "failed", readAt: new Date(answer.readAt).toISOString() };
  }
  const quiet = new Set(answer.quiet.map(key).filter((k) => asked.has(k)));
  return { state: "read", total: asked.size, quiet: quiet.size, readAt: new Date(answer.readAt).toISOString() };
}

function logFailure(authorized: MeteringComposition, event: string, microgridId: string, startedAt: number, error: unknown) {
  console.warn(
    JSON.stringify({
      event,
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
  o: { now?: () => number; read?: typeof openEmsEdgeStatusRead; readMeters?: typeof openEmsMeterActivityRead } = {},
): MeteringEdgeStatusCapabilityContract {
  const now = o.now ?? Date.now;
  const makeRead = o.read ?? openEmsEdgeStatusRead;
  const makeMeterRead = o.readMeters ?? openEmsMeterActivityRead;
  /** Logs a failure with an MGM code and rethrows it, for the cache to record. */
  const logged =
    <T>(event: string, microgridId: string, read: (signal: AbortSignal) => Promise<T>) =>
    async (signal: AbortSignal): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await read(signal);
      } catch (error) {
        logFailure(authorized, event, microgridId, startedAt, error);
        throw error;
      }
    };
  return {
    async getEdgeStatuses(sites: readonly EdgeStatusSite[], deadlineMs: number): Promise<EdgeStatusOutcome[]> {
      const out: EdgeStatusOutcome[] = new Array(sites.length);
      // Every site asks at once, in reading order, its status read and then
      // its meter read; the cache's process-wide slots decide how many reads
      // run, so overlapping calls share the bound. A site's two reads run side
      // by side and share its client.
      await Promise.all(
        readingOrder(sites).map(async (i) => {
          const { microgridId, edgeIds, meters } = sites[i];
          const clientOf = lazyClient(supabase, microgridId);
          const statusRead = logged("metering.edge_status_failed", microgridId, makeRead(supabase, microgridId, edgeIds, clientOf));
          const status = cachedEdgeStatus(microgridId, edgeIds, statusRead, { deadlineMs, now });
          let meterStartedAt = 0;
          const meterRead = makeMeterRead(supabase, microgridId, meters, now, clientOf, (error) =>
            logFailure(authorized, "metering.meter_activity_edge_failed", microgridId, meterStartedAt, error),
          );
          const meterAnswer =
            meters.length === 0
              ? null
              : cachedMeterActivity(
                  microgridId,
                  meters,
                  logged("metering.meter_activity_failed", microgridId, (signal) => {
                    meterStartedAt = Date.now();
                    return meterRead(signal);
                  }),
                  { deadlineMs, now },
                );
          const answer = await status;
          if (answer.state === "late") out[i] = { microgridId, state: "late" };
          else if (answer.state === "failed") out[i] = { microgridId, state: "failed", readAt: new Date(answer.readAt).toISOString() };
          else {
            const metersOut = meterAnswer ? meterOutcome(meters, answer, await meterAnswer) : undefined;
            out[i] = {
              microgridId,
              state: "read",
              total: answer.total,
              offline: answer.offline,
              readAt: new Date(answer.readAt).toISOString(),
              ...(metersOut ? { meters: metersOut } : {}),
            };
          }
        }),
      );
      return out;
    },
  };
}
