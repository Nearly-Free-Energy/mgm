/**
 * Each bill's actions and links in `billing.period-review` against the
 * legacy row menu (computeMenuItems in src/components/billing/row-actions-menu.tsx),
 * over every payment status, reading source, period status, edge
 * availability and role. The payment-link group is left to the send queue
 * (#201's "Contribute the send queue"), so the menu is asked with payments
 * not configured; the usage correction is the legacy page's editable cell,
 * not a menu item, and is compared in period-review-model.test.ts.
 *
 * The one allowed difference: an organization manager is not offered
 * marking a bill failed or refunded, which the legacy menu shows to every
 * role and the payment-status route answers 403 for anyone but a super
 * admin.
 */
import { describe, expect, it } from "vitest";
import { computeMenuItems, type MenuItem } from "@/components/billing/row-actions-menu";
import { createFmt } from "@/lib/gui/fmt";
import type { PaymentStatus } from "@/lib/payments/state";
import {
  buildPeriodReviewModel,
  CANCEL_PAYMENT_LINK_ACTION,
  DOWNLOAD_BILL_LINK,
  MARK_FAILED_ACTION,
  MARK_PAID_ACTION,
  MARK_REFUNDED_ACTION,
  MARK_UNPAID_ACTION,
  RECORD_USAGE_ACTION,
  REGENERATE_BILL_ACTION,
  VIEW_HISTORY_LINK,
} from "../period-review-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e7500000-0000-4000-8002-0000000000a1";
const PERIOD = { id: "e7500000-0000-4000-8003-0000000000b1", start_date: "2026-10-01", end_date: "2026-10-31" };
const TENANT = { id: "e7500000-0000-4000-8004-000000000001", display_name: "Akello" };
const BILL = "e7500000-0000-4000-8005-000000000001";

/** Each legacy menu label, without its trailing ellipsis, as the control it is now. */
const MENU_ACTIONS: Record<string, string> = {
  "Regenerate from edge data": REGENERATE_BILL_ACTION.id,
  "Switch to manual entry": REGENERATE_BILL_ACTION.id,
  "Switch back to edge data": REGENERATE_BILL_ACTION.id,
  "Re-enter manual readings": REGENERATE_BILL_ACTION.id,
  "Mark as paid": MARK_PAID_ACTION.id,
  "Mark as unpaid": MARK_UNPAID_ACTION.id,
  "Mark as refunded": MARK_REFUNDED_ACTION.id,
  "Cancel pending link": CANCEL_PAYMENT_LINK_ACTION.id,
  "Mark as failed": MARK_FAILED_ACTION.id,
};
/** Shown to every role by the legacy menu; refused by the route for anyone but a super admin. */
const SUPER_ADMIN_ONLY = new Set<string>([MARK_FAILED_ACTION.id, MARK_REFUNDED_ACTION.id]);

const noop = () => {};
const STATUSES: PaymentStatus[] = ["unpaid", "link_generated", "paid", "failed", "refunded"];
const SOURCES = ["edge", "manual", null] as const;

const cases = STATUSES.flatMap((payment) =>
  SOURCES.flatMap((source) =>
    (["draft", "closed"] as const).flatMap((status) =>
      [true, false].flatMap((edgeAvailable) => [true, false].map((superAdmin) => [payment, source, status, edgeAvailable, superAdmin] as const)),
    ),
  ),
);

/** The menu's controls as [action id, label for a regenerate item], and its links' hrefs. */
function menu(payment: PaymentStatus, source: "edge" | "manual" | null, status: "draft" | "closed", edgeAvailable: boolean) {
  const items: MenuItem[] = computeMenuItems({
    microgridId: MG,
    // The reading source is null on bills written before it was recorded.
    lineItem: { id: BILL, payment_status: payment, reading_source: source as "edge", total_amount: 1000, pesapal_redirect_url: null },
    tenant: TENANT,
    period: { ...PERIOD, status },
    edgeAvailable,
    isPaymentConfigured: false,
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
  const actions: [string, string | undefined][] = [];
  const links: string[] = [];
  let download = false;
  for (const item of items) {
    if (item.kind === "separator") continue;
    if (item.kind === "link") {
      links.push(item.href);
      continue;
    }
    if (item.disabled) continue; // "No further status changes available"
    if (item.key === "download-pdf") {
      download = true;
      continue;
    }
    const label = item.label.replace(/…$/, "");
    const action = MENU_ACTIONS[label];
    if (!action) throw new Error(`unmapped legacy menu item "${item.label}"`);
    actions.push([action, action === REGENERATE_BILL_ACTION.id ? label : undefined]);
  }
  return { actions, links, download };
}

describe("each bill's actions match the legacy row menu", () => {
  it.each(cases)("%s bill, %s readings, %s period, edge %s, super admin %s", (payment, source, status, edgeAvailable, superAdmin) => {
    const model = buildPeriodReviewModel({
      microgrid: { id: MG, name: "North", currency: "UGX" },
      period: { ...PERIOD, status, timezone: null },
      tiers: [],
      tenants: [{ ...TENANT, edgeAvailable, meterLinkInPeriod: true }],
      bills: [
        {
          id: BILL,
          tenant_id: TENANT.id,
          device_id: null,
          start_kwh: 1,
          end_kwh: 2,
          usage_kwh: 1,
          tier_breakdown: [],
          total_amount: 1000,
          reading_source: source,
          payment_status: payment,
          invoice_number: null,
          entered_at: null,
          entered_by: null,
        },
      ],
      superAdmin,
      fmt,
    });
    const [row] = model.body.rows;
    const legacy = menu(payment, source, status, edgeAvailable);

    const expected = legacy.actions.filter(([action]) => superAdmin || !SUPER_ADMIN_ONLY.has(action));
    const actual = row.actions
      .filter((a) => a.action !== RECORD_USAGE_ACTION.id)
      .map((a): [string, string | undefined] => [a.action, a.action === REGENERATE_BILL_ACTION.id ? a.label : undefined]);
    expect(actual).toEqual(expected);

    // The legacy menu's links: the PDF download, the tenant (now the row's tenant ref) and the history.
    expect(legacy.download).toBe(true);
    expect(row.links?.find((l) => l.id === DOWNLOAD_BILL_LINK)?.download).toBeDefined();
    const hrefs = [...(row.related ?? []).map((r) => r.href), ...(row.links ?? []).filter((l) => l.id === VIEW_HISTORY_LINK).map((l) => l.href)];
    expect(hrefs).toEqual(legacy.links);
  });

  it("differs only where the route refuses an organization manager", () => {
    const missing = cases.flatMap(([payment, source, status, edgeAvailable, superAdmin]) =>
      superAdmin ? [] : menu(payment, source, status, edgeAvailable).actions.filter(([a]) => SUPER_ADMIN_ONLY.has(a)).map(([a]) => a),
    );
    // Some cases do hide them, so the allowance above is used, and only for these two.
    expect(new Set(missing)).toEqual(SUPER_ADMIN_ONLY);
  });
});
