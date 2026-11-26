/**
 * Text that a metering route and the prepare step of its action
 * (./surface/actions.ts) both show, written once so the two cannot drift
 * apart: a person reads in the host's step what the route would answer.
 *
 * Client-safe, with no imports.
 */

/**
 * PUT /api/microgrids/[id]/openems-backend's 409 while the microgrid has a
 * draft billing period, which metering.save-connection's prepare refuses
 * with too.
 */
export const CONNECTION_DRAFT_PERIOD_REFUSAL =
  "Close or delete the draft period first. Changing the OpenEMS backend requires rediscovering devices and would invalidate readings from the current period.";

/**
 * The same route's 409 while the microgrid has closed billing periods and no
 * name is typed, which metering.save-connection's prepare shows as the
 * ceremony's warning.
 */
export function connectionClosedPeriodsWarning(closed: number): string {
  return `This microgrid has ${closed} closed billing period${closed === 1 ? "" : "s"}. Changing the OpenEMS backend may affect historical invoice verification if edge IDs differ after rediscovery. Type the microgrid name to confirm.`;
}

/** DELETE /api/edges/[id]'s 409 for an edge with no name to type, which metering.delete-edge's prepare refuses with too. */
export const EDGE_UNNAMED_REFUSAL = "Unnamed entity cannot be typed-to-confirm.";
