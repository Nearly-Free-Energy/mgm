import "server-only";

/**
 * Examples of the `metering.edge-status` watcher's signals, built by its own
 * model with a fixed clock, so they are what it returns: a microgrid with
 * two gateways offline, and one whose gateways' status could not be read.
 * All data is synthetic.
 */
import { createFmt } from "@/lib/gui/fmt";
import type { SignalOut } from "@/lib/gui/surface";
import { buildEdgeStatusSignals } from "./edge-status-signals-model";

const KIWUMU = "00000000-0000-4000-8000-0000000000c1";
const LWAMATA = "00000000-0000-4000-8000-0000000000c2";

export const EDGE_STATUS_EXAMPLES: readonly SignalOut[] = buildEdgeStatusSignals(
  createFmt({ locale: "en-GB" }),
  [
    { id: KIWUMU, name: "Kiwumu", timezone: "Africa/Kampala" },
    { id: LWAMATA, name: "Lwamata", timezone: "Africa/Kampala" },
  ],
  [
    { microgridId: KIWUMU, state: "read", total: 3, offline: 2, readAt: "2026-11-20T08:57:00.000Z" },
    { microgridId: LWAMATA, state: "failed", readAt: "2026-11-20T08:59:30.000Z" },
  ],
  new Date("2026-11-20T09:00:00Z"),
);
