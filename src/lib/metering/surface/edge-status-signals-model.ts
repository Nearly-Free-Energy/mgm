import "server-only";

/**
 * The signals of the `metering.edge-status` watcher (./edge-status-signals.ts):
 * one per microgrid with a gateway (an OpenEMS edge) offline, leading to its
 * Edges & Devices page, which lists each edge online or not; and one per
 * microgrid whose gateways' status could not be read, leading to its OpenEMS
 * Backend page, where the connection is tested and fixed.
 *
 * Fixed copy: the microgrid's name, as metering.connection writes it, and a
 * count, never an edge id or anything the backend said. The fact is when
 * the backend answered, in the microgrid's zone: an answer may come from the
 * cache (up to five minutes old), and getEdgesStatus says nothing of when an
 * edge was last seen. A microgrid whose meters stopped reporting while its
 * gateway is online is not reported here; that needs per-component reads.
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

/**
 * One signal per microgrid with an edge offline or whose status could not
 * be read, by name, at most MAX_SIGNALS_PER_SOURCE; nothing for one whose
 * edges are all online, or that has no outcome.
 */
export function buildEdgeStatusSignals(
  fmt: Fmt,
  microgrids: readonly EdgeStatusMicrogrid[],
  outcomes: readonly EdgeStatusOutcome[],
  now: Date,
): SignalOut[] {
  const byId = new Map(outcomes.map((o) => [o.microgridId, o]));
  return [...microgrids]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .flatMap((m): SignalOut[] => {
      const outcome = byId.get(m.id);
      if (!outcome || (outcome.state === "read" && outcome.offline === 0)) return [];
      const zone = m.timezone !== null && isSupportedTimezone(m.timezone) ? m.timezone : "UTC";
      const readAt = outcome.state === "late" ? null : outcome.readAt;
      const base = {
        kind: "alarm" as const,
        severity: "warn" as const,
        entity: { kind: "microgrid" as const, id: m.id, label: m.name },
        ...(readAt ? { facts: [fmt.datetime(readAt, zone)] } : {}),
        at: readAt ?? now.toISOString(),
      };
      return outcome.state === "read"
        ? [{ ...base, id: `offline:${m.id}`, title: offlineTitle(m.name, outcome.offline), href: `/microgrids/${m.id}/setup/edges` }]
        : [{ ...base, id: `unread:${m.id}`, title: unreadTitle(m.name), href: `/microgrids/${m.id}/setup/openems-backend` }];
    })
    .slice(0, MAX_SIGNALS_PER_SOURCE);
}
