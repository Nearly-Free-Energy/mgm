import "server-only";

/**
 * The signals of the `metering.edge-status` watcher (./edge-status-signals.ts):
 * one per microgrid with a gateway (an OpenEMS edge) offline, and one per
 * microgrid with a meter on an online gateway that has sent no reading for
 * half an hour (METER_QUIET_AFTER_MS), each leading to its Edges & Devices
 * page, which lists its edges and their devices; and one per microgrid whose
 * gateways' status, or whose meters, could not be read, leading to its
 * OpenEMS Backend page, where the connection is tested and fixed.
 *
 * Fixed copy: the microgrid's name, as metering.connection writes it, and a
 * count, never an edge id, a meter's name (house meters are named after
 * their tenants) or anything the backend said. The fact is when the backend
 * answered, in the microgrid's zone: an answer may come from the cache (up
 * to five minutes old), and getEdgesStatus says nothing of when an edge was
 * last seen.
 */
import { MAX_SIGNALS_PER_SOURCE, type Fmt, type SignalOut } from "@/lib/gui/surface";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import type { EdgeStatusOutcome } from "../edge-status";

export const EDGE_STATUS_SIGNAL = "metering.edge-status";

export type EdgeStatusMicrogrid = { id: string; name: string; timezone: string | null };

export function offlineTitle(name: string, offline: number): string {
  return `${name}: ${offline} ${offline === 1 ? "gateway" : "gateways"} offline`;
}
export const unreadTitle = (name: string) => `${name}: gateway status could not be read`;
export function quietTitle(name: string, quiet: number): string {
  return `${name}: ${quiet} ${quiet === 1 ? "meter" : "meters"} not reporting`;
}
export const uncheckedTitle = (name: string) => `${name}: meter readings could not be checked`;

/** The order signals keep under the cap: what is known to be wrong before what could not be read. */
const GROUPS = ["offline:", "quiet:", "unread:", "unchecked:"];

/**
 * Per microgrid: a signal for edges offline, or one for status that could
 * not be read; and a signal for meters on online edges not reporting, or
 * one for meters that could not be checked. Nothing for a microgrid whose
 * edges are all online and whose meters all report, for a meter read with
 * no answer in time (the next load finds it in the cache), or for a
 * microgrid with no outcome. At most MAX_SIGNALS_PER_SOURCE: offline
 * gateways, quiet meters, unread status, unchecked meters, each group by
 * name, so a cut drops what could not be read before what is known to be
 * wrong.
 */
export function buildEdgeStatusSignals(
  fmt: Fmt,
  microgrids: readonly EdgeStatusMicrogrid[],
  outcomes: readonly EdgeStatusOutcome[],
  now: Date,
): SignalOut[] {
  const byId = new Map(outcomes.map((o) => [o.microgridId, o]));
  const signals = [...microgrids]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .flatMap((m): SignalOut[] => {
      const outcome = byId.get(m.id);
      if (!outcome) return [];
      const zone = m.timezone !== null && isSupportedTimezone(m.timezone) ? m.timezone : "UTC";
      const signal = (id: string, title: string, href: `/${string}`, readAt: string | null): SignalOut => ({
        id,
        kind: "alarm",
        severity: "warn",
        title,
        entity: { kind: "microgrid", id: m.id, label: m.name },
        href,
        ...(readAt ? { facts: [fmt.datetime(readAt, zone)] } : {}),
        at: readAt ?? now.toISOString(),
      });
      const edges = `/microgrids/${m.id}/setup/edges` as const;
      const backend = `/microgrids/${m.id}/setup/openems-backend` as const;
      if (outcome.state !== "read") {
        return [signal(`unread:${m.id}`, unreadTitle(m.name), backend, outcome.state === "late" ? null : outcome.readAt)];
      }
      const out: SignalOut[] = [];
      if (outcome.offline > 0) out.push(signal(`offline:${m.id}`, offlineTitle(m.name, outcome.offline), edges, outcome.readAt));
      const meters = outcome.meters;
      if (meters?.state === "read" && meters.quiet > 0) out.push(signal(`quiet:${m.id}`, quietTitle(m.name, meters.quiet), edges, meters.readAt));
      if (meters?.state === "failed") out.push(signal(`unchecked:${m.id}`, uncheckedTitle(m.name), backend, meters.readAt));
      return out;
    });
  const group = (s: SignalOut) => GROUPS.findIndex((prefix) => s.id.startsWith(prefix));
  // A stable sort keeps each group in name order.
  return signals.sort((a, b) => group(a) - group(b)).slice(0, MAX_SIGNALS_PER_SOURCE);
}
