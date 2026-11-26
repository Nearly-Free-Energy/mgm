import "server-only";

/**
 * Examples of the `payments.payment-setup` view, so every GUI can be tested
 * against it: a community with no payment provider, seen by a super admin
 * (with the link to its Payment page) and by an organization manager (told
 * to ask one); an account that cannot take payments; a sandbox account; a
 * live account; payments turned off, with the gate's notice; and a
 * readiness that could not be read. Built at import the way the loader
 * builds them.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import { periodLabel } from "@/lib/billing/surface/period-label";
import { buildPaymentSetupModel, PAYMENT_SETUP_VIEW, type SetupReadiness } from "./payment-setup-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site" };
const COMMUNITY = "00000000-0000-4000-8000-0000000000a2";
const PERIOD = { id: "00000000-0000-4000-8000-0000000000b2", start_date: "2026-11-01", end_date: "2026-11-30" };
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled payments plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice. If the
 * gate's copy changes, so may this.
 */
const PAYMENTS_DISABLED =
  "Payments are disabled for this organization. Enable them in Settings → Plugins; history is preserved, and verification and reconciliation stay available.";

const CASES: readonly { readiness: SetupReadiness; superAdmin: boolean; gated?: true }[] = [
  // The first names the section where the send queue lists it.
  { readiness: "unconfigured", superAdmin: true },
  { readiness: "unconfigured", superAdmin: false },
  { readiness: "connection_error", superAdmin: true },
  { readiness: "sandbox", superAdmin: false },
  { readiness: "ready", superAdmin: true },
  { readiness: "disabled", superAdmin: false, gated: true },
  { readiness: "unchecked", superAdmin: false },
];

/** The models as the loader returns them, before the host fills its fields. */
export const PAYMENT_SETUP_LOADED_EXAMPLES: readonly LoadedModel<"record">[] = CASES.map(({ readiness, superAdmin }) =>
  buildPaymentSetupModel({ communityId: COMMUNITY, readiness, superAdmin, fmt }),
);

/** A loaded model with the fields the host fills, as a GUI receives it; `gated` as while Payments is off. */
function asReceived(loaded: LoadedModel<"record">, gated: boolean): ModelOf<"record"> {
  return {
    ...loaded,
    type: "view",
    view: PAYMENT_SETUP_VIEW,
    kind: "record",
    org: ORG,
    // As the host builds it from the path's microgrid and period (src/lib/gui/host/server/entities.ts).
    trail: [
      { label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` },
      { label: periodLabel(fmt, PERIOD.start_date, PERIOD.end_date), href: `/microgrids/${MICROGRID.id}/billing/${PERIOD.id}` },
    ],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    ...(gated ? { notice: { tone: "warning" as const, text: PAYMENTS_DISABLED } } : {}),
  };
}

export const PAYMENT_SETUP_EXAMPLES: readonly ModelOf<"record">[] = PAYMENT_SETUP_LOADED_EXAMPLES.map((loaded, n) =>
  asReceived(loaded, CASES[n].gated === true),
);
