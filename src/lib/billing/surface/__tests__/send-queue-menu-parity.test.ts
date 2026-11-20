/**
 * Which bills `billing.send-queue` shows a payment link for, against the
 * legacy row menu's payment-link group (computeMenuItems in the deleted
 * src/components/billing/row-actions-menu.tsx) once payments were set up:
 * over every payment status and period status, a bill with a total and a
 * tenant with a contact has a link exactly where the menu offered Generate
 * or Regenerate payment link. The menu was deleted with the legacy billing
 * screens (#201's Deletes item); what it offered, recorded from
 * computeMenuItems over every payment status, reading source, period status
 * and stored URL, with a total and with a total of zero, just before it was
 * deleted, is pinned below as LEGACY_LINK_STATUSES. It depended on the
 * payment status alone.
 *
 * The two deliberate differences, where the menu offered a link checkout
 * would refuse (ensureCheckout in src/lib/payments/capability.ts): a total
 * of zero or less, and a tenant with neither email nor phone. The queue
 * shows a note instead.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { PaymentStatus } from "@/lib/payments/state";
import { buildSendQueueModel, SEND_QUEUE_COPY } from "../send-queue-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e8100000-0000-4000-8002-0000000000a1";
const PERIOD = { id: "e8100000-0000-4000-8003-0000000000b1", start_date: "2026-10-01", end_date: "2026-10-31" };
const TENANT = { id: "e8100000-0000-4000-8004-000000000001", display_name: "Akello" };
const BILL = "e8100000-0000-4000-8005-000000000001";
const LINK = `https://mgm.example.org/api/billing-line-items/${BILL}/pay`;

const STATUSES: PaymentStatus[] = ["unpaid", "link_generated", "paid", "failed", "refunded"];
/** The payment statuses for which the legacy menu, with payments set up, offered Generate or Regenerate payment link. */
const LEGACY_LINK_STATUSES = new Set<PaymentStatus>(["unpaid", "link_generated", "failed"]);

/** Whether the legacy menu, with payments set up, offered a payment link for the bill. */
const menuOffersLink = (payment: PaymentStatus): boolean => LEGACY_LINK_STATUSES.has(payment);

function queueLink(payment: PaymentStatus, status: "draft" | "closed", total: number, hasContact: boolean) {
  const model = buildSendQueueModel({
    microgrid: { id: MG, name: "North", currency: "UGX" },
    period: { ...PERIOD, status, timezone: null },
    tenants: [{ ...TENANT, hasContact }],
    bills: [{ id: BILL, tenant_id: TENANT.id, total_amount: total, payment_status: payment, invoice_number: null }],
    readiness: "ready",
    linkFor: () => LINK,
    superAdmin: false,
    fmt,
  });
  return model.body.rows[0].cells;
}

// The queue reads no reading source and no stored URL, and the legacy menu's answer did not depend on them.
const cases = STATUSES.flatMap((payment) => (["draft", "closed"] as const).map((status) => [payment, status] as const));

describe("the send queue's links match the legacy menu's payment-link items", () => {
  it.each(cases)("%s bill, %s period", (payment, status) => {
    const offered = menuOffersLink(payment);
    const cells = queueLink(payment, status, 1000, true);
    expect(cells.link.t === "text", "a link in the queue exactly where the menu offered one").toBe(offered);
  });

  it("differs on purpose for a zero total and a tenant with no contact, which checkout refuses", () => {
    for (const payment of ["unpaid", "link_generated", "failed"] as const) {
      expect(menuOffersLink(payment)).toBe(true);
      expect(queueLink(payment, "draft", 0, true)).toMatchObject({ link: fmt.empty(), note: fmt.text(SEND_QUEUE_COPY.zero) });
      expect(queueLink(payment, "draft", 1000, false)).toMatchObject({ link: fmt.empty(), note: fmt.text(SEND_QUEUE_COPY.noContact) });
    }
  });
});
