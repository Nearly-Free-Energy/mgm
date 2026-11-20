import "server-only";

/**
 * Examples of the `billing.periods` view, so every GUI can be tested against
 * it: a closed period with bills beside a draft with none (which offers
 * Delete), the empty state that owns the create action, the empty state
 * while billing is off, with create disabled and the gate's notice, and a
 * microgrid in Uganda whose billing timezone is still UTC, under the time
 * zone notice. Create starts at the previous month. Built at import the way
 * the loader builds them, with a fixed clock.
 */
import type { ActionRef, ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionLink, LoadedModel } from "@/lib/gui/surface";
import { timezoneNudge } from "@/lib/timezone/nudge";
import { getDefaultDates } from "../default-dates";
import { buildPeriodsModel, CREATE_PERIOD_ACTION, DELETE_PERIOD_ACTION } from "./periods-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site" };
const fmt = createFmt({ locale: "en-GB" });
/** The examples' "now": 18 December 2026 in Kampala, so create starts at November. */
const NOW = new Date("2026-12-18T09:00:00+03:00");
const KAMPALA = getDefaultDates(NOW, "Africa/Kampala");

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
const OCTOBER = {
  id: "00000000-0000-4000-8000-0000000000b1",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  status: "closed",
  totalKwh: 1284.5,
  totalAmount: 4_216_800,
} as const;

export const PERIODS_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  buildPeriodsModel({
    microgridId: MICROGRID.id,
    currency: "UGX",
    defaults: KAMPALA,
    nudge: null,
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
      OCTOBER,
    ],
  }),
  buildPeriodsModel({ microgridId: MICROGRID.id, currency: "UGX", defaults: KAMPALA, nudge: null, fmt, periods: [] }),
  // Stored zone UTC, address in Uganda: the notice, and create in UTC's calendar.
  buildPeriodsModel({
    microgridId: MICROGRID.id,
    currency: "UGX",
    defaults: getDefaultDates(NOW, "UTC"),
    nudge: timezoneNudge({ address_country: "Uganda", lat: 0.35, lng: 32.6, timezone: "UTC" }, NOW),
    fmt,
    periods: [OCTOBER],
  }),
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
    // The gate's notice takes the place of the view's own (dispatchView in src/lib/gui/host/server/view.ts).
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const PERIODS_EXAMPLES: readonly ModelOf<"collection">[] = [
  asReceived(PERIODS_LOADED_EXAMPLES[0]),
  asReceived(PERIODS_LOADED_EXAMPLES[1]),
  asReceived(PERIODS_LOADED_EXAMPLES[1], true),
  asReceived(PERIODS_LOADED_EXAMPLES[2]),
];
