/**
 * The cached edge-status read (mgm#287, decision 3 on #230): whether each
 * OpenEMS edge (gateway) of a microgrid is online now, asked of the
 * microgrid's metering backend at most once per cache period
 * (./infrastructure/edge-status-cache.ts), for the `metering.edge-status`
 * watcher (./surface/edge-status-signals.ts).
 *
 * A reader is handed out only for a composition of the metering capability
 * (createEdgeStatusReader in ./infrastructure/openems-edge-status.ts takes
 * one), so composeMetering has settled the session with getUser, checked the
 * person's access to the organization and found metering on before any
 * stored credential is decrypted. The contract is named as one so that
 * gui-surface.test.ts holds every surface module to its listed reads
 * (LOADER_READS there), as it does the capability's own.
 *
 * Only counts come back: no edge id, name or vendor text, so nothing the
 * backend says reaches a signal (ADR-007 decision 6: vendor text is
 * untrusted). Online is all getEdgesStatus answers; when an edge was last
 * seen, or whether an online edge's meters still report, needs other reads
 * and is follow-up work.
 */

/** A microgrid to ask about, with the OpenEMS ids of its edges as MGM stores them. */
export type EdgeStatusSite = { microgridId: string; edgeIds: readonly string[] };

export type EdgeStatusOutcome =
  /**
   * The backend answered, now or within the cache period: `total` edges
   * asked about, `offline` of them not online, an edge the answer leaves out
   * counting as offline (as Discover counts it). `readAt` is when it
   * answered, which a cached outcome puts before now.
   */
  | { microgridId: string; state: "read"; total: number; offline: number; readAt: string }
  /**
   * The read failed or timed out, now or within the shorter period a failure
   * is kept, so a failing backend is not asked again on every poll.
   */
  | { microgridId: string; state: "failed"; readAt: string }
  /**
   * No answer by the deadline. A read that had started goes on to its own
   * timeout and its answer is kept for the next load; one still waiting for
   * a slot never starts.
   */
  | { microgridId: string; state: "late" };

export interface MeteringEdgeStatusCapabilityContract {
  /**
   * One outcome per site, in the order given, by `deadlineMs` (epoch
   * milliseconds). Sites with no kept answer are read first, then the
   * stalest, and no read starts after the deadline. It throws nothing for a
   * backend's failure: that is the site's outcome.
   */
  getEdgeStatuses(sites: readonly EdgeStatusSite[], deadlineMs: number): Promise<EdgeStatusOutcome[]>;
}
