/**
 * Each bill's actions and links in `billing.period-review` against the
 * legacy row menu (computeMenuItems in the deleted
 * src/components/billing/row-actions-menu.tsx), over every payment status,
 * reading source, period status, edge availability and role. The menu was
 * deleted with the legacy billing screens (#201's Deletes item); its items,
 * recorded from computeMenuItems over these same cases just before it was
 * deleted, are pinned below as LEGACY_REGENERATE and LEGACY_STATUS. They did
 * not depend on the period's status. The payment-link group is left to the
 * send queue (#201's "Contribute the send queue"), so the menu was asked
 * with payments not configured; the usage correction was the legacy page's
 * editable cell, not a menu item, and is compared in
 * period-review-model.test.ts.
 *
 * The one allowed difference: an organization manager is not offered
 * marking a bill failed or refunded, which the legacy menu showed to every
 * role and the payment-status route answers 403 for anyone but a super
 * admin.
 */
import { describe, expect, it } from "vitest";
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

/**
 * The legacy menu's regenerate group by reading source, with the edge
 * available and without: a bill with no reading source (written before it
 * was recorded) had none, and neither had a refunded bill (LEGACY_STATUS).
 */
const LEGACY_REGENERATE: Record<"edge" | "manual" | "null", { edge: string[]; noEdge: string[] }> = {
  edge: { edge: ["Regenerate from edge data", "Switch to manual entry"], noEdge: ["Switch to manual entry"] },
  manual: { edge: ["Switch back to edge data", "Re-enter manual readings"], noEdge: ["Re-enter manual readings"] },
  null: { edge: [], noEdge: [] },
};
/**
 * The legacy menu's payment-status group. A refunded bill's menu had only
 * the disabled "No further status changes available" in place of both
 * groups, so null here: no regenerate group either.
 */
const LEGACY_STATUS: Record<PaymentStatus, string[] | null> = {
  unpaid: ["Mark as paid"],
  link_generated: ["Mark as paid", "Cancel pending link", "Mark as failed"],
  paid: ["Mark as unpaid", "Mark as refunded"],
  failed: ["Mark as paid"],
  refunded: null,
};

const STATUSES: PaymentStatus[] = ["unpaid", "link_generated", "paid", "failed", "refunded"];
const SOURCES = ["edge", "manual", null] as const;

const cases = STATUSES.flatMap((payment) =>
  SOURCES.flatMap((source) =>
    (["draft", "closed"] as const).flatMap((status) =>
      [true, false].flatMap((edgeAvailable) => [true, false].map((superAdmin) => [payment, source, status, edgeAvailable, superAdmin] as const)),
    ),
  ),
);

/**
 * The legacy menu's controls as [action id, label for a regenerate item],
 * and its links' hrefs: every bill's menu also offered the PDF download, the
 * tenant's page and the bill's history.
 */
function menu(payment: PaymentStatus, source: "edge" | "manual" | null, edgeAvailable: boolean) {
  const status = LEGACY_STATUS[payment];
  const regenerate = status === null ? [] : LEGACY_REGENERATE[source ?? "null"][edgeAvailable ? "edge" : "noEdge"];
  const actions = [...regenerate, ...(status ?? [])].map((label): [string, string | undefined] => {
    const action = MENU_ACTIONS[label];
    if (!action) throw new Error(`unmapped legacy menu item "${label}"`);
    return [action, action === REGENERATE_BILL_ACTION.id ? label : undefined];
  });
  const links = [`/microgrids/${MG}/setup/tenants/${TENANT.id}`, `/microgrids/${MG}/billing/${PERIOD.id}/history?tenant_id=${TENANT.id}`];
  return { actions, links };
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
    const legacy = menu(payment, source, edgeAvailable);

    const expected = legacy.actions.filter(([action]) => superAdmin || !SUPER_ADMIN_ONLY.has(action));
    const actual = row.actions
      .filter((a) => a.action !== RECORD_USAGE_ACTION.id)
      .map((a): [string, string | undefined] => [a.action, a.action === REGENERATE_BILL_ACTION.id ? a.label : undefined]);
    expect(actual).toEqual(expected);

    // The legacy menu's links: the PDF download, the tenant (now the row's tenant ref) and the history.
    expect(row.links?.find((l) => l.id === DOWNLOAD_BILL_LINK)?.download).toBeDefined();
    const hrefs = [...(row.related ?? []).map((r) => r.href), ...(row.links ?? []).filter((l) => l.id === VIEW_HISTORY_LINK).map((l) => l.href)];
    expect(hrefs).toEqual(legacy.links);
  });

  it("differs only where the route refuses an organization manager", () => {
    const missing = cases.flatMap(([payment, source, , edgeAvailable, superAdmin]) =>
      superAdmin ? [] : menu(payment, source, edgeAvailable).actions.filter(([a]) => SUPER_ADMIN_ONLY.has(a)).map(([a]) => a),
    );
    // Some cases do hide them, so the allowance above is used, and only for these two.
    expect(new Set(missing)).toEqual(SUPER_ADMIN_ONLY);
  });
});
