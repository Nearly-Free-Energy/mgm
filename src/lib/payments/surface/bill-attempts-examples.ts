import "server-only";

/**
 * Examples of the `payments.bill-attempts` view, so every GUI can be tested
 * against it: a period's bills (whose title names the period review's tab);
 * one bill with an attempt that needs reconciliation, where the receipts
 * fall short, so Accept exact receipts is unavailable; one bill paid
 * online after a superseded checkout; an unpaid bill whose only checkout
 * has an unknown outcome; a bill with no attempts; a period with no
 * bills; and the second again while Payments is off, with the gate's
 * notice and its actions as when Payments is on, since their routes accept
 * them then (whilePluginOff in ../surface.ts). Built at import the way the loader
 * builds them. Each history is one PaymentsCapability can produce: a new
 * checkout is refused on a paid bill and beside any open, verified or held
 * attempt (createCheckout, fn_payment_reserve_checkout), so a paid bill
 * never has a later attempt. If those refusals change, so may these.
 */
import type { ActionRef, ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionLink, LoadedModel } from "@/lib/gui/surface";
import { periodLabel } from "@/lib/billing/surface/period-label";
import {
  ACCEPT_RECEIPTS_ACTION,
  buildBillAttemptsModel,
  buildBillsIndexModel,
  RECORD_ADJUSTMENT_ACTION,
  reconcileReason,
  REFRESH_ATTEMPT_ACTION,
  type BillAttempt,
  type BillHistory,
} from "./bill-attempts-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site", currency: "UGX" };
const fmt = createFmt({ locale: "en-GB" });
const TZ = "Africa/Kampala";

/**
 * A copy of the gate's copy for a disabled payments plugin
 * (src/lib/runtime/gate.ts), which the host shows as the view's notice while
 * Payments is off. If the gate's copy changes, so may this.
 */
const PAYMENTS_DISABLED =
  "Payments are disabled for this organization. Enable them in Settings → Plugins; history and reconciliation are preserved.";

const TITLES: Record<string, string> = Object.fromEntries(
  [REFRESH_ATTEMPT_ACTION, RECORD_ADJUSTMENT_ACTION, ACCEPT_RECEIPTS_ACTION].map((a) => [a.id, a.title]),
);

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const PERIOD = { id: id(0xb2), start_date: "2026-11-01", end_date: "2026-11-30" };
const BILLS = [
  { id: id(0xd1), tenantName: "Akello Grace", total_amount: 5000, payment_status: "link_generated" as const },
  { id: id(0xd2), tenantName: "Byaruhanga Peter", total_amount: 24000, payment_status: "paid" as const },
  { id: id(0xd3), tenantName: "Kato Joseph", total_amount: 31250, payment_status: "unpaid" as const },
  { id: id(0xd4), tenantName: "Nambi Ruth", total_amount: 12500, payment_status: "unpaid" as const },
];

const attempt = (n: number, o: Partial<BillAttempt>): BillAttempt => ({
  id: id(0xe0 + n),
  status: "verified",
  amount: 5000,
  currency: "UGX",
  merchant_reference: `MGM-${id(0xf0 + n)}`,
  failure_code: null,
  hasTracking: true,
  created_at: "2026-11-03T09:15:00Z",
  ...o,
});

/** Akello's bill: a receipt of 3,000 against an attempt of 5,000, held for reconciliation. */
const SHORT: BillHistory = {
  attempts: [attempt(1, { status: "needs_reconciliation", failure_code: "balance_mismatch" })],
  receipts: [
    { id: id(0x101), attempt_id: id(0xe1), amount: 3000, currency: "UGX", provider_status: "completed", confirmation_code: "QK7H2", created_at: "2026-11-03T09:20:00Z" },
  ],
  currentTotal: 5000,
  currency: "UGX",
  received: 3000,
  difference: -2000,
};

/** Byaruhanga's bill: paid online, after an earlier checkout that another superseded. */
const PAID: BillHistory = {
  attempts: [
    attempt(2, { amount: 24000, status: "failed", failure_code: "checkout_superseded", hasTracking: false, created_at: "2026-11-02T08:00:00Z" }),
    attempt(3, { amount: 24000, status: "verified", created_at: "2026-11-02T10:30:00Z" }),
  ],
  receipts: [
    { id: id(0x102), attempt_id: id(0xe3), amount: 24000, currency: "UGX", provider_status: "completed", confirmation_code: "PX91M", created_at: "2026-11-02T10:32:00Z" },
  ],
  currentTotal: 24000,
  currency: "UGX",
  received: 24000,
  difference: 0,
};

/** Nambi's bill: its only checkout's submission outcome is unknown, so nothing may be reconciled until it is investigated. */
const UNKNOWN: BillHistory = {
  attempts: [
    attempt(4, { amount: 12500, status: "confirmation_pending", failure_code: "confirmation_pending", hasTracking: false, created_at: "2026-11-04T16:45:00Z" }),
  ],
  receipts: [],
  currentTotal: 12500,
  currency: "UGX",
  received: 0,
  difference: -12500,
};

const NONE: BillHistory = { attempts: [], receipts: [], currentTotal: 31250, currency: "UGX", received: 0, difference: -31250 };

/** Each example bill with the history its model is built from, so a test can hold them to what the capability can produce. */
export const BILL_ATTEMPTS_EXAMPLE_HISTORIES: readonly { bill: (typeof BILLS)[number]; history: BillHistory }[] = [
  { bill: BILLS[0], history: SHORT },
  { bill: BILLS[1], history: PAID },
  { bill: BILLS[3], history: UNKNOWN },
  { bill: BILLS[2], history: NONE },
];

const billModel = (bill: (typeof BILLS)[number], history: BillHistory) =>
  buildBillAttemptsModel({ microgrid: MICROGRID, period: PERIOD, bill, timezone: TZ, history, fmt });

/** The models as the loader returns them, before the host fills its fields. */
export const BILL_ATTEMPTS_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  // The period's bills: the period review's Payments tab.
  buildBillsIndexModel({ microgrid: MICROGRID, period: PERIOD, bills: BILLS, fmt }),
  // A bill whose receipts fall short of it.
  billModel(BILLS[0], SHORT),
  // A bill paid online after a superseded checkout.
  billModel(BILLS[1], PAID),
  // An unpaid bill whose only checkout has an unknown outcome.
  billModel(BILLS[3], UNKNOWN),
  // A bill with no attempts.
  billModel(BILLS[2], NONE),
  // A period with no bills.
  buildBillsIndexModel({ microgrid: MICROGRID, period: PERIOD, bills: [], fmt }),
];

/** Each action's availability as reconcileAvailable answers it for the history the model was built from. */
const HISTORIES = [undefined, SHORT, PAID, UNKNOWN, NONE, undefined] as const;

/**
 * Each action resolved as the host resolves it. Every action of this view
 * declares whilePluginOff: "enabled", so while Payments is off each resolves
 * as when it is on, by its availability alone.
 */
function resolve(history: BillHistory | undefined) {
  return (link: ActionLink): ActionRef => {
    const which = link.action === RECORD_ADJUSTMENT_ACTION.id ? "record" : link.action === ACCEPT_RECEIPTS_ACTION.id ? "accept" : null;
    const reason = which && history ? reconcileReason(history, link.params.id, which) : null;
    return {
      ...link,
      label: link.label ?? TITLES[link.action],
      // No tone: none of this view's actions is a DELETE or destructive (actionTone in merge-actions.ts).
      ...(reason === null ? { enabled: true } : { enabled: false, reason }),
    };
  };
}

/** A loaded model with the fields the host fills, as a GUI receives it; `off` as while Payments is off. */
function asReceived(loaded: LoadedModel<"collection">, history: BillHistory | undefined, off = false): ModelOf<"collection"> {
  const ref = resolve(history);
  const { empty } = loaded.body;
  return {
    ...loaded,
    type: "view",
    view: "payments.bill-attempts",
    kind: "collection",
    org: ORG,
    // As the host builds it from the path's microgrid and period (src/lib/gui/host/server/entities.ts).
    trail: [
      { label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` },
      { label: periodLabel(fmt, PERIOD.start_date, PERIOD.end_date), href: `/microgrids/${MICROGRID.id}/billing/${PERIOD.id}` },
    ],
    actions: loaded.actions.map(ref),
    links: loaded.links ?? [],
    attached: [],
    body: {
      ...loaded.body,
      rows: loaded.body.rows.map((row) => ({ ...row, actions: row.actions.map(ref) })),
      empty: { title: empty.title, ...(empty.text ? { text: empty.text } : {}) },
    },
    ...(off ? { notice: { tone: "warning" as const, text: PAYMENTS_DISABLED } } : {}),
  };
}

export const BILL_ATTEMPTS_EXAMPLES: readonly ModelOf<"collection">[] = [
  ...BILL_ATTEMPTS_LOADED_EXAMPLES.map((loaded, n) => asReceived(loaded, HISTORIES[n])),
  asReceived(BILL_ATTEMPTS_LOADED_EXAMPLES[1], SHORT, true),
];

