import "server-only";

/**
 * Examples of the `billing.current-periods` view, so every GUI can be tested
 * against it: a microgrid with a draft period, one with a closed period and
 * one with none; no microgrids; and the same list while billing is off,
 * with the gate's notice. Built at import the way the loader builds them.
 * All data is synthetic.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import { buildCurrentPeriodsModel, CURRENT_PERIODS_VIEW } from "./current-periods-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled billing plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice. If the
 * gate's copy changes, so may this.
 */
const BILLING_DISABLED =
  "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.";

const LOADED: readonly LoadedModel<"collection">[] = [
  buildCurrentPeriodsModel(fmt, [
    {
      microgridId: "00000000-0000-4000-8000-0000000000a1",
      microgridName: "Example site",
      period: { id: "00000000-0000-4000-8000-0000000000b1", start_date: "2026-11-01", end_date: "2026-11-30", status: "draft", bills: 42 },
    },
    {
      microgridId: "00000000-0000-4000-8000-0000000000a2",
      microgridName: "Kiwumu",
      period: { id: "00000000-0000-4000-8000-0000000000b2", start_date: "2026-10-01", end_date: "2026-10-31", status: "closed", bills: 17 },
    },
    { microgridId: "00000000-0000-4000-8000-0000000000a3", microgridName: "New site", period: null },
  ]),
  buildCurrentPeriodsModel(fmt, []),
];

function asReceived(loaded: LoadedModel<"collection">, disabled = false): ModelOf<"collection"> {
  return {
    ...loaded,
    type: "view",
    view: CURRENT_PERIODS_VIEW,
    kind: "collection",
    org: ORG,
    trail: [],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    body: { ...loaded.body, rows: loaded.body.rows.map((row) => ({ ...row, actions: [] })), empty: { title: loaded.body.empty.title, ...(loaded.body.empty.text ? { text: loaded.body.empty.text } : {}) } },
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const CURRENT_PERIODS_EXAMPLES: readonly ModelOf<"collection">[] = [
  asReceived(LOADED[0]),
  asReceived(LOADED[1]),
  asReceived(LOADED[0], true),
];
