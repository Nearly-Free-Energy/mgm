import "server-only";

/**
 * Examples of the `billing.send-queue` view, so every GUI can be tested
 * against it: a ready draft seen by an organization manager, with a bill to
 * send, a pending link, a failed payment, a paid and a refunded bill, a
 * total of zero and a tenant with no email or phone; a closed period, whose
 * unpaid bills are still payable; a sandbox account; no payment provider,
 * as an organization manager and as a super admin are told it; online
 * payments turned off; a draft with no bills; and the first again while
 * billing is off, with the gate's notice. Built at import the way the loader
 * builds them, with a fixed origin rather than the environment's, so each
 * carries the `billing.send-queue@1` ext.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import { stablePaymentLinkPath } from "@/lib/payments/payment-link";
import { periodLabel } from "./period-label";
import { buildSendQueueModel, type SendBill, type SendQueueInput } from "./send-queue-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site", currency: "UGX" };
const ORIGIN = "https://mgm.example.org";
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled billing plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice. If the
 * gate's copy changes, so may this.
 */
const BILLING_DISABLED =
  "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const NOVEMBER = { id: id(0xb2), start_date: "2026-11-01", end_date: "2026-11-30", status: "draft" as const, timezone: "Africa/Kampala" };
const OCTOBER = { id: id(0xb1), start_date: "2026-10-01", end_date: "2026-10-31", status: "closed" as const, timezone: "Africa/Kampala" };

const TENANTS = [
  { id: id(0xc1), display_name: "Akello Grace", hasContact: true },
  { id: id(0xc2), display_name: "Byaruhanga Peter", hasContact: true },
  { id: id(0xc3), display_name: "Kato Joseph", hasContact: true },
  { id: id(0xc4), display_name: "Nambi Sarah", hasContact: true },
  { id: id(0xc5), display_name: "Okello Daniel", hasContact: true },
  { id: id(0xc6), display_name: "Ssempala Isaac", hasContact: true },
  { id: id(0xc7), display_name: "Tumusiime Ruth", hasContact: false },
];

const bill = (n: number, tenantIndex: number, o: Partial<SendBill> = {}): SendBill => ({
  id: id(0xd0 + n),
  tenant_id: TENANTS[tenantIndex].id,
  total_amount: 55875,
  payment_status: "unpaid",
  invoice_number: null,
  ...o,
});

const DRAFT_BILLS = [
  bill(1, 0, { invoice_number: "EXS-2026-0001" }),
  bill(2, 1, { payment_status: "link_generated", total_amount: 24000 }),
  bill(3, 2, { payment_status: "failed", total_amount: 31250 }),
  bill(4, 3, { payment_status: "paid", invoice_number: "EXS-2026-0004" }),
  bill(5, 4, { payment_status: "refunded", total_amount: 12500 }),
  bill(6, 5, { total_amount: 0 }),
  bill(7, 6, { total_amount: 18750 }),
];

const input = (o: Partial<SendQueueInput>): SendQueueInput => ({
  microgrid: MICROGRID,
  period: NOVEMBER,
  tenants: TENANTS,
  bills: DRAFT_BILLS,
  readiness: "ready",
  linkFor: (billId) => `${ORIGIN}${stablePaymentLinkPath(billId)}`,
  superAdmin: false,
  fmt,
  ...o,
});

/** The models as the loader returns them, before the host fills its fields. */
export const SEND_QUEUE_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  // A ready draft, seen by an organization manager.
  buildSendQueueModel(input({})),
  // A closed period: its unpaid bills are still payable.
  buildSendQueueModel(
    input({
      period: OCTOBER,
      tenants: TENANTS.slice(0, 3),
      bills: [bill(11, 0, { payment_status: "paid", invoice_number: "EXS-2026-0011" }), bill(12, 1, { invoice_number: "EXS-2026-0012" }), bill(13, 2)],
    }),
  ),
  // A sandbox account.
  buildSendQueueModel(input({ readiness: "sandbox", tenants: TENANTS.slice(0, 2), bills: DRAFT_BILLS.slice(0, 2) })),
  // No payment provider, as an organization manager is told.
  buildSendQueueModel(input({ readiness: "unconfigured", tenants: TENANTS.slice(0, 3), bills: DRAFT_BILLS.slice(0, 3) })),
  // No payment provider, as a super admin is told.
  buildSendQueueModel(input({ readiness: "unconfigured", superAdmin: true, tenants: TENANTS.slice(0, 3), bills: DRAFT_BILLS.slice(0, 3) })),
  // Online payments turned off.
  buildSendQueueModel(input({ readiness: "disabled", tenants: TENANTS.slice(0, 3), bills: DRAFT_BILLS.slice(0, 3) })),
  // A draft with no bills yet: readiness is not read, and nothing is said about it.
  buildSendQueueModel(input({ bills: [], readiness: "not_needed" })),
];

/** A loaded model with the fields the host fills, as a GUI receives it; `disabled` as while billing is off. */
function asReceived(loaded: LoadedModel<"collection">, disabled = false): ModelOf<"collection"> {
  const period = loaded.entity?.id === OCTOBER.id ? OCTOBER : NOVEMBER;
  const { empty } = loaded.body;
  return {
    ...loaded,
    type: "view",
    view: "billing.send-queue",
    kind: "collection",
    org: ORG,
    // As the host builds it from the path's microgrid and period (src/lib/gui/host/server/entities.ts).
    trail: [
      { label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` },
      { label: periodLabel(fmt, period.start_date, period.end_date), href: `/microgrids/${MICROGRID.id}/billing/${period.id}` },
    ],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    live: { refreshSeconds: 30, staleAfterSeconds: 120 },
    body: {
      ...loaded.body,
      rows: loaded.body.rows.map((row) => ({ ...row, actions: [] })),
      empty: { title: empty.title, ...(empty.text ? { text: empty.text } : {}) },
    },
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const SEND_QUEUE_EXAMPLES: readonly ModelOf<"collection">[] = [
  ...SEND_QUEUE_LOADED_EXAMPLES.map((loaded) => asReceived(loaded)),
  asReceived(SEND_QUEUE_LOADED_EXAMPLES[0], true),
];
