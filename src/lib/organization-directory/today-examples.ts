import "server-only";

/**
 * Examples of Today (`org.today`), so every GUI can be tested against it:
 * signals from billing, metering and payments, most urgent first, with a
 * tile; nothing to do, with the tile; one signal shown of two while a
 * source did not answer; and signals that could not be collected. Built at import
 * the way the loader builds them, from signals as the host collects them.
 * All data is synthetic.
 */
import type { ModelOf, Signal, Signals } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import { buildTodayModel, TODAY_VIEW } from "./today-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = "00000000-0000-4000-8000-0000000000a1";
const PERIOD = "00000000-0000-4000-8000-0000000000b1";
const fmt = createFmt({ locale: "en-GB" });

const SIGNALS: Signal[] = [
  {
    id: `payments.reconcile:${PERIOD}`,
    source: "payments.reconcile",
    kind: "your-move",
    severity: "critical",
    title: "Example site: 1 payment in October 2026 needs reconciliation",
    href: `/microgrids/${MICROGRID}/billing/${PERIOD}/payments`,
    at: "2026-11-19T08:00:00.000Z",
  },
  {
    id: `billing.period-due:${PERIOD}`,
    source: "billing.period-due",
    kind: "your-move",
    severity: "warn",
    title: "Example site: October 2026 is not closed",
    facts: [fmt.text("1–31 Oct 2026")],
    href: `/microgrids/${MICROGRID}/billing/${PERIOD}/close`,
    at: "2026-10-31T21:00:00.000Z",
    due: "2026-11-01",
  },
  {
    id: `metering.connection:${MICROGRID}`,
    source: "metering.connection",
    kind: "alarm",
    severity: "warn",
    title: "Example site: OpenEMS could not be reached",
    href: `/microgrids/${MICROGRID}/setup/openems-backend`,
    at: "2026-11-20T06:00:00.000Z",
  },
];

const signals = (o: Partial<Signals>): Signals => ({
  type: "signals",
  org: ORG,
  count: 0,
  top: [],
  checked: ["billing.period-due", "metering.connection", "payments.failed", "payments.reconcile"],
  unchecked: [],
  ...o,
});

/** The models as the loader returns them, before the host fills its fields. */
export const TODAY_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  buildTodayModel(fmt, signals({ count: SIGNALS.length, top: SIGNALS })),
  buildTodayModel(fmt, signals({})),
  buildTodayModel(
    fmt,
    signals({ count: 2, top: [SIGNALS[1]], checked: ["billing.period-due", "payments.failed", "payments.reconcile"], unchecked: ["metering.connection"] }),
  ),
  buildTodayModel(fmt, null),
];

/** A loaded model with the fields the host fills, as a GUI receives it. Today's rows carry no actions. */
function asReceived(loaded: LoadedModel<"collection">, attached: ModelOf<"collection">["attached"] = []): ModelOf<"collection"> {
  return {
    ...loaded,
    type: "view",
    view: TODAY_VIEW,
    kind: "collection",
    org: ORG,
    trail: [],
    actions: [],
    links: loaded.links ?? [],
    attached,
    body: { ...loaded.body, rows: loaded.body.rows.map((row) => ({ ...row, actions: [] })), empty: { title: loaded.body.empty.title, ...(loaded.body.empty.text ? { text: loaded.body.empty.text } : {}) } },
  };
}

/** A tile another plugin attaches, as the host lists it (billing.current-periods). */
const TILE = { view: "billing.current-periods", title: "Current billing periods", href: `/billing?org=${ORG}`, hint: "tile" } as const;

export const TODAY_EXAMPLES: readonly ModelOf<"collection">[] = [
  asReceived(TODAY_LOADED_EXAMPLES[0], [TILE]),
  asReceived(TODAY_LOADED_EXAMPLES[1], [TILE]),
  asReceived(TODAY_LOADED_EXAMPLES[2]),
  asReceived(TODAY_LOADED_EXAMPLES[3]),
];
