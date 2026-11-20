/**
 * Which bills `billing.send-queue` shows a payment link for, against the
 * legacy row menu's payment-link group (computeMenuItems in
 * src/components/billing/row-actions-menu.tsx) once payments are set up:
 * over every payment status, reading source and period status, a bill with
 * a total and a tenant with a contact has a link exactly where the menu
 * offers Generate or Regenerate payment link.
 *
 * The two deliberate differences, where the menu offers a link checkout
 * would refuse (ensureCheckout in src/lib/payments/capability.ts): a total
 * of zero or less, and a tenant with neither email nor phone. The queue
 * shows a note instead.
 */
import { describe, expect, it } from "vitest";
import { computeMenuItems } from "@/components/billing/row-actions-menu";
import { createFmt } from "@/lib/gui/fmt";
import type { PaymentStatus } from "@/lib/payments/state";
import { buildSendQueueModel, SEND_QUEUE_COPY } from "../send-queue-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e8100000-0000-4000-8002-0000000000a1";
const PERIOD = { id: "e8100000-0000-4000-8003-0000000000b1", start_date: "2026-10-01", end_date: "2026-10-31" };
const TENANT = { id: "e8100000-0000-4000-8004-000000000001", display_name: "Akello" };
const BILL = "e8100000-0000-4000-8005-000000000001";
const LINK = `https://mgm.example.org/api/billing-line-items/${BILL}/pay`;

const noop = () => {};
const STATUSES: PaymentStatus[] = ["unpaid", "link_generated", "paid", "failed", "refunded"];
const SOURCES = ["edge", "manual", null] as const;
const LINK_ITEMS = new Set(["generate-link", "regenerate-link"]);

/** Whether the legacy menu, with payments set up, offers a payment link for the bill. */
function menuOffersLink(payment: PaymentStatus, source: "edge" | "manual" | null, status: "draft" | "closed", total: number, storedUrl: string | null): boolean {
  const items = computeMenuItems({
    microgridId: MG,
    lineItem: { id: BILL, payment_status: payment, reading_source: source as "edge", total_amount: total, pesapal_redirect_url: storedUrl },
    tenant: TENANT,
    period: { ...PERIOD, status },
    edgeAvailable: true,
    isPaymentConfigured: true,
    pendingUrl: null,
    handlers: {
      onRequestRegenerate: noop,
      onRequestSwitchToManual: noop,
      onGenerateLink: noop,
      onCopyLink: noop,
      onMarkAsPaid: noop,
      onMarkAsRefunded: noop,
      onMarkAsUnpaid: noop,
      onCancelLink: noop,
      onMarkAsFailed: noop,
      onDownloadPdf: noop,
    },
  });
  return items.some((item) => item.kind === "action" && LINK_ITEMS.has(item.key) && !item.disabled);
}

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

const cases = STATUSES.flatMap((payment) =>
  SOURCES.flatMap((source) => (["draft", "closed"] as const).flatMap((status) => [null, "https://pay.example/old"].map((url) => [payment, source, status, url] as const))),
);

describe("the send queue's links match the legacy menu's payment-link items", () => {
  it.each(cases)("%s bill, %s readings, %s period, stored URL %s", (payment, source, status, storedUrl) => {
    const offered = menuOffersLink(payment, source, status, 1000, storedUrl);
    const cells = queueLink(payment, status, 1000, true);
    expect(cells.link.t === "text", "a link in the queue exactly where the menu offers one").toBe(offered);
  });

  it("differs on purpose for a zero total and a tenant with no contact, which checkout refuses", () => {
    for (const payment of ["unpaid", "link_generated", "failed"] as const) {
      expect(menuOffersLink(payment, "edge", "draft", 0, null)).toBe(true);
      expect(queueLink(payment, "draft", 0, true)).toMatchObject({ link: fmt.empty(), note: fmt.text(SEND_QUEUE_COPY.zero) });
      expect(menuOffersLink(payment, "edge", "draft", 1000, null)).toBe(true);
      expect(queueLink(payment, "draft", 1000, false)).toMatchObject({ link: fmt.empty(), note: fmt.text(SEND_QUEUE_COPY.noContact) });
    }
  });
});
