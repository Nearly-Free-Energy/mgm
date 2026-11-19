import "server-only";

/**
 * Examples of the `billing.periods` view, so every GUI can be tested against
 * it: a closed period with bills beside a draft with none (which offers
 * Delete), the empty state that owns the create action, and the empty state
 * while billing is off, with create disabled and the gate's notice. Built at
 * import the way the loader builds them.
 */
import type { ActionRef, ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionLink, LoadedModel } from "@/lib/gui/surface";
import { buildPeriodsModel, CREATE_PERIOD_ACTION, DELETE_PERIOD_ACTION } from "./periods-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site" };
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled billing plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice and as the
 * reason on billing's own actions. If the gate's copy changes, so may this.
 */
const BILLING_DISABLED =
  "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.";

const TITLES: Record<string, string> = {
  [CREATE_PERIOD_ACTION.id]: CREATE_PERIOD_ACTION.title,
  [DELETE_PERIOD_ACTION.id]: DELETE_PERIOD_ACTION.title,
};
/** The host marks typed and DELETE actions as dangerous (src/lib/gui/host/shared/merge-actions.ts). */
const DANGER = new Set<string>([DELETE_PERIOD_ACTION.id]);

/** The models as the loader returns them, before the host fills its fields. */
export const PERIODS_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  buildPeriodsModel({
    microgridId: MICROGRID.id,
    currency: "UGX",
    fmt,
    periods: [
      {
        id: "00000000-0000-4000-8000-0000000000b2",
        start_date: "2026-11-01",
        end_date: "2026-11-30",
        status: "draft",
        totalKwh: null,
        totalAmount: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        start_date: "2026-10-01",
        end_date: "2026-10-31",
        status: "closed",
        totalKwh: 1284.5,
        totalAmount: 4_216_800,
      },
    ],
  }),
  buildPeriodsModel({ microgridId: MICROGRID.id, currency: "UGX", fmt, periods: [] }),
];

const resolve =
  (disabled: boolean) =>
  (link: ActionLink): ActionRef => ({
    ...link,
    label: link.label ?? TITLES[link.action],
    ...(DANGER.has(link.action) ? { tone: "danger" as const } : {}),
    ...(disabled ? { enabled: false, reason: BILLING_DISABLED } : { enabled: true }),
  });

/** A loaded model with the fields the host fills, as a GUI receives it; `disabled` as while billing is off. */
function asReceived(loaded: LoadedModel<"collection">, disabled = false): ModelOf<"collection"> {
  const ref = resolve(disabled);
  const { empty } = loaded.body;
  return {
    ...loaded,
    type: "view",
    view: "billing.periods",
    kind: "collection",
    org: ORG,
    // The host fills the entity from the path when a loader gives none.
    entity: { kind: "microgrid", id: MICROGRID.id, label: MICROGRID.name },
    trail: [{ label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` }],
    actions: loaded.actions.map(ref),
    links: loaded.links ?? [],
    attached: [],
    body: {
      ...loaded.body,
      rows: loaded.body.rows.map((row) => ({ ...row, actions: row.actions.map(ref) })),
      empty: { title: empty.title, ...(empty.text ? { text: empty.text } : {}), ...(empty.action ? { action: ref(empty.action) } : {}) },
    },
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const PERIODS_EXAMPLES: readonly ModelOf<"collection">[] = [
  asReceived(PERIODS_LOADED_EXAMPLES[0]),
  asReceived(PERIODS_LOADED_EXAMPLES[1]),
  asReceived(PERIODS_LOADED_EXAMPLES[1], true),
];
