import "server-only";

/**
 * Examples of the `billing.close-checklist` view, so every GUI can be tested
 * against it: a draft ready to close; one with tenants who have no bill and
 * a bill with no usage, to acknowledge when closing; one with no bills, and
 * one with a total that is not a whole number, both blocked, with Close
 * disabled with the reason availability gives; a closed period, with the
 * CSV export the legacy close dialog offered; and the ready draft while
 * billing is off, with the gate's notice and Close disabled. Built at import
 * the way the loader builds them.
 */
import type { ActionRef, ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionLink, LoadedModel } from "@/lib/gui/surface";
import { CLOSE_ACKNOWLEDGEMENTS, fractionalTotalsMessage, periodName, type CloseAcknowledgementId, type CloseReview } from "../close";
import { buildCloseChecklistModel, CLOSE_PERIOD_ACTION, type CloseChecklistInput } from "./close-checklist-model";
import { CLOSE_PERIOD_REFUSALS } from "./close-checklist";
import { periodLabel } from "./period-label";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site", timezone: "Africa/Kampala" };
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled billing plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice and as the
 * reason on billing's own actions. If the gate's copy changes, so may this.
 */
const BILLING_DISABLED =
  "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const OCTOBER = { id: id(0xb1), start_date: "2026-10-01", end_date: "2026-10-31", closed_at: null, timezone: "Africa/Kampala" };
const tenants = (names: string[]) => names.map((tenantName, n) => ({ tenantId: id(0xc1 + n), tenantName }));

const review = (o: Partial<CloseReview> = {}): CloseReview => {
  const acks: CloseAcknowledgementId[] = ["totals_reviewed"];
  if ((o.unbilled ?? []).length > 0) acks.push("tenants_without_bills");
  if ((o.unmetered ?? []).length > 0) acks.push("bills_without_usage");
  return {
    periodId: OCTOBER.id,
    microgridId: MICROGRID.id,
    status: "draft",
    startDate: OCTOBER.start_date,
    endDate: OCTOBER.end_date,
    currency: "UGX",
    billCount: 12,
    totalAmount: 4_216_800,
    usageKwh: 1284.5,
    unbilled: [],
    unmetered: [],
    fractionalTotals: [],
    name: periodName(OCTOBER.start_date, OCTOBER.end_date) ?? "October 2026",
    acknowledgements: acks.map((a) => ({ id: a, label: CLOSE_ACKNOWLEDGEMENTS[a] })),
    digest: "v1:example",
    ...o,
  };
};

const input = (o: Partial<CloseChecklistInput> = {}): CloseChecklistInput => ({
  microgrid: MICROGRID,
  period: OCTOBER,
  review: review(),
  sources: { edge: 11, manual: 1 },
  fmt,
  ...o,
});

const UNBILLED = tenants(["Akello Grace", "Kato Joseph", "Nakato Ruth", "Okello Daniel", "Byaruhanga Peter", "Namubiru Sarah", "Ssempala Isaac"]);
const FRACTIONAL = tenants(["Mugisha Alex"]);

/** The models as the loader returns them, before the host fills its fields. */
export const CLOSE_CHECKLIST_LOADED_EXAMPLES: readonly LoadedModel<"flow">[] = [
  // Ready: every tenant billed, every bill with usage.
  buildCloseChecklistModel(input()),
  // Seven tenants with no bill and one bill with no usage: acknowledged when closing.
  buildCloseChecklistModel(
    input({
      review: review({ billCount: 5, totalAmount: 1_204_000, usageKwh: 402.25, unbilled: UNBILLED, unmetered: tenants(["Atim Joy"]) }),
      sources: { edge: 3, manual: 2 },
    }),
  ),
  // No bills yet: blocked.
  buildCloseChecklistModel(
    input({ review: review({ billCount: 0, totalAmount: 0, usageKwh: 0, unbilled: UNBILLED }), sources: { edge: 0, manual: 0 } }),
  ),
  // A total that is not a whole number: blocked until the bill is regenerated.
  buildCloseChecklistModel(input({ review: review({ fractionalTotals: FRACTIONAL, totalAmount: 4_216_800.5 }) })),
  // Closed: the bills are final, and the CSV for URA is a link away.
  buildCloseChecklistModel(
    input({ period: { ...OCTOBER, closed_at: "2026-11-05T13:00:00+00:00" }, review: review({ status: "closed" }) }),
  ),
];

/** The reason availability gives Close on each loaded example, or true. */
const AVAILABLE: readonly (true | string)[] = [
  true,
  true,
  CLOSE_PERIOD_REFUSALS.noBills.message,
  fractionalTotalsMessage(FRACTIONAL),
  // A closed period offers no Close.
  true,
];

/** As the host resolves Close: its label, the danger tone of a ceremony action (merge-actions.ts), and its availability. */
const resolve =
  (available: true | string, disabled: boolean) =>
  (link: ActionLink): ActionRef => ({
    ...link,
    label: link.label ?? CLOSE_PERIOD_ACTION.title,
    tone: "danger",
    ...(disabled
      ? { enabled: false, reason: BILLING_DISABLED }
      : available === true
        ? { enabled: true }
        : { enabled: false, reason: available }),
  });

/** A loaded model with the fields the host fills, as a GUI receives it; `disabled` as while billing is off. */
function asReceived(loaded: LoadedModel<"flow">, available: true | string, disabled = false): ModelOf<"flow"> {
  const ref = resolve(available, disabled);
  return {
    ...loaded,
    type: "view",
    view: "billing.close-checklist",
    kind: "flow",
    org: ORG,
    // As the host builds it from the path's microgrid and period (src/lib/gui/host/server/entities.ts).
    trail: [
      { label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` },
      { label: periodLabel(fmt, OCTOBER.start_date, OCTOBER.end_date), href: `/microgrids/${MICROGRID.id}/billing/${OCTOBER.id}` },
    ],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    body: { steps: loaded.body.steps.map(({ action, ...step }) => (action ? { ...step, action: ref(action) } : step)) },
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const CLOSE_CHECKLIST_EXAMPLES: readonly ModelOf<"flow">[] = [
  ...CLOSE_CHECKLIST_LOADED_EXAMPLES.map((loaded, n) => asReceived(loaded, AVAILABLE[n])),
  asReceived(CLOSE_CHECKLIST_LOADED_EXAMPLES[0], true, true),
];
