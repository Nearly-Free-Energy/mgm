/**
 * The `payments.bill-attempts` model (../bill-attempts-model.ts): the
 * period's bills, each linking to its attempts; one bill's attempts with the
 * balance in the subtitle; fixed notes in place of failure messages, and no
 * checkout URL, tracking id or merchant account anywhere; the actions each
 * attempt offers; and the reasons a reconciliation does not apply, as
 * fn_payment_reconcile would refuse it.
 */
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { PaymentAttempt, PaymentReceipt } from "../../repository";
import { RECONCILE_COPY } from "../../schemas";
import {
  ACCEPT_RECEIPTS_ACTION,
  attemptNote,
  billAttemptsHref,
  BILL_ATTEMPTS_EMPTY,
  BILL_ATTEMPTS_KEYS,
  buildBillAttemptsModel,
  buildBillsIndexModel,
  FAILURE_NOTES,
  narrowHistory,
  OTHER_FAILURE_NOTE,
  RECORD_ADJUSTMENT_ACTION,
  reconcileReason,
  REFRESH_ATTEMPT_ACTION,
  UNTRACKED_NOTE,
  type BillHistory,
} from "../bill-attempts-model";

const fmt = createFmt({ locale: "en-GB" });
const MG = "e8200000-0000-4000-8000-0000000000a1";
const PERIOD = { id: "e8200000-0000-4000-8000-0000000000b1", start_date: "2026-10-01", end_date: "2026-10-31" };
const B1 = "e8200000-0000-4000-8000-0000000000d1";
const A1 = "e8200000-0000-4000-8000-0000000000e1";
const A2 = "e8200000-0000-4000-8000-0000000000e2";
const CHECKOUT = "https://pay.pesapal.com/iframe/PesapalIframe3/Index?OrderTrackingId=canary-track";
const RAW = 'Pesapal returned 500: {"error":"canary raw provider body"}';

const raw = (o: Partial<PaymentAttempt>): PaymentAttempt => ({
  id: A1,
  org_id: "org",
  line_item_id: B1,
  community_id: "community",
  merchant_account_id: "canary-account-id",
  merchant_account_version: 3,
  amount: 5000,
  currency: "UGX",
  bill_revision_total: 5000,
  bill_revision_updated_at: null,
  merchant_reference: `MGM-${A1}`,
  provider_tracking_id: "canary-tracking-id",
  provider: "pesapal",
  status: "needs_reconciliation",
  checkout_url: CHECKOUT,
  failure_code: "balance_mismatch",
  failure_message: RAW,
  created_at: "2026-10-03T09:15:00Z",
  ...o,
});
const receipt = (o: Partial<PaymentReceipt>): PaymentReceipt => ({
  id: "r1",
  attempt_id: A1,
  amount: 3000,
  currency: "UGX",
  provider_status: "completed",
  provider_tracking_id: "canary-tracking-id",
  confirmation_code: "QK7H2",
  payment_method: "MTN",
  created_at: "2026-10-03T09:20:00Z",
  ...o,
});
const history = (attempts: PaymentAttempt[], receipts: PaymentReceipt[] = [], total = 5000, received = 3000): BillHistory =>
  narrowHistory({ attempts, receipts, currentTotal: total, currency: "UGX", received, difference: received - total });

const billModel = (h: BillHistory) =>
  buildBillAttemptsModel({ microgrid: { id: MG }, period: PERIOD, bill: { id: B1, tenantName: "Akello Grace" }, timezone: "Africa/Kampala", history: h, fmt });

describe("the bills index", () => {
  const model = buildBillsIndexModel({
    microgrid: { id: MG, currency: "UGX" },
    period: PERIOD,
    bills: [{ id: B1, tenantName: "Akello Grace", total_amount: 5000, payment_status: "link_generated" }],
    fmt,
  });

  it("lists each bill with its total and payment status, linking to its attempts", () => {
    expect(model.title).toBe("Payments");
    expect(model.subtitle).toBe("1 Oct 2026 – 31 Oct 2026");
    expect(model.body.rows).toEqual([
      {
        id: B1,
        href: `/microgrids/${MG}/billing/${PERIOD.id}/payments?bill=${B1}`,
        cells: {
          tenant: { t: "text", text: "Akello Grace" },
          total: fmt.money(5000, "UGX"),
          bill_status: fmt.status("billingLineItemPaymentStatus", "link_generated"),
        },
        actions: [],
      },
    ]);
  });

  it("gives rows no entity, so no other plugin's action is appended to them", () => {
    expect(model.body.rows.every((r) => r.entity === undefined && r.related === undefined)).toBe(true);
    expect(model.entity).toBeUndefined();
  });

  it("says to generate bills when there are none", () => {
    const empty = buildBillsIndexModel({ microgrid: { id: MG, currency: "UGX" }, period: PERIOD, bills: [], fmt });
    expect(empty.body.empty).toEqual(BILL_ATTEMPTS_EMPTY.index);
  });
});

describe("one bill's attempts", () => {
  it("shows the balance in the subtitle, a negative difference included", () => {
    const model = billModel(history([raw({})], [receipt({})]));
    expect(model.title).toBe("Payments: Akello Grace");
    expect(model.subtitle).toBe(`1 Oct 2026 – 31 Oct 2026 · Bill ${fmt.money(5000, "UGX").text} · Received ${fmt.money(3000, "UGX").text} · Difference ${fmt.money(-2000, "UGX").text}`);
    expect(model.links).toEqual([{ id: "payments.all-bills", label: "All bills", href: billAttemptsHref(MG, PERIOD.id) }]);
  });

  it("draws each attempt's start, amount, status, reference, receipts and note", () => {
    const model = billModel(history([raw({})], [receipt({}), receipt({ id: "r2", provider_status: "reversed", amount: 1000, confirmation_code: null })]));
    const row = model.body.rows[0];
    expect(row.entity).toEqual({ kind: "paymentAttempt", id: A1, label: `MGM-${A1}` });
    expect(row.cells).toEqual({
      created: fmt.datetime("2026-10-03T09:15:00Z", "Africa/Kampala"),
      amount: fmt.money(5000, "UGX"),
      status: { t: "status", v: "needs_reconciliation", tone: "warning", text: "Needs reconciliation" },
      reference: { t: "text", text: `MGM-${A1}` },
      receipts: { t: "text", text: `Completed ${fmt.money(3000, "UGX").text} · code QK7H2; Reversed ${fmt.money(1000, "UGX").text}` },
      note: { t: "text", text: FAILURE_NOTES.balance_mismatch },
    });
    expect(Object.keys(row.cells).every((k) => (BILL_ATTEMPTS_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it("carries no checkout URL, tracking id, merchant account or failure message", () => {
    const text = JSON.stringify(billModel(history([raw({}), raw({ id: A2, status: "failed", failure_code: "PESAPAL_UNAVAILABLE" })], [receipt({})])));
    for (const secret of [CHECKOUT, "canary-tracking-id", "canary-account-id", RAW, "canary raw provider body", "PESAPAL_UNAVAILABLE"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("offers Refresh status only on tracked attempts, and both reconciliations, prefilled, on one that needs reconciliation", () => {
    const model = billModel(
      history([raw({}), raw({ id: A2, status: "verified", provider_tracking_id: null, failure_code: null })], [receipt({})]),
    );
    expect(model.body.rows[0].actions).toEqual([
      { action: REFRESH_ATTEMPT_ACTION.id, params: { id: A1 } },
      { action: RECORD_ADJUSTMENT_ACTION.id, params: { id: A1 }, prefill: { action: "record_external" } },
      { action: ACCEPT_RECEIPTS_ACTION.id, params: { id: A1 }, prefill: { action: "accept_exact" } },
    ]);
    expect(model.body.rows[1].actions).toEqual([]);
  });

  it("says when a bill has no attempts", () => {
    expect(billModel(history([], [], 5000, 0)).body.empty).toEqual(BILL_ATTEMPTS_EMPTY.bill);
  });
});

describe("attemptNote", () => {
  const narrow = (o: Partial<PaymentAttempt>) => narrowHistory({ attempts: [raw(o)], receipts: [], currentTotal: 0, currency: "UGX", received: 0, difference: 0 }).attempts[0];

  it.each(Object.entries(FAILURE_NOTES))("gives %s its fixed note", (code, note) => {
    expect(attemptNote(narrow({ status: "failed", failure_code: code }))).toBe(note);
  });

  it("gives any other code one fixed note, and none without a code", () => {
    expect(attemptNote(narrow({ status: "failed", failure_code: "anything_else" }))).toBe(OTHER_FAILURE_NOTE);
    expect(attemptNote(narrow({ status: "verified", failure_code: null }))).toBeNull();
  });

  it.each(["pending", "confirmation_pending", "needs_reconciliation"] as const)("says a %s attempt with no tracking id has an unknown outcome", (status) => {
    expect(attemptNote(narrow({ status, provider_tracking_id: null }))).toBe(UNTRACKED_NOTE);
  });
});

describe("reconcileReason", () => {
  it("allows both on an attempt that needs reconciliation, when the receipts come to the bill", () => {
    const h = history([raw({})], [receipt({ amount: 5000 })], 5000, 5000);
    expect(reconcileReason(h, A1, "record")).toBeNull();
    expect(reconcileReason(h, A1, "accept")).toBeNull();
  });

  it("refuses accepting receipts that are not exact, and allows recording the difference", () => {
    const h = history([raw({})], [receipt({})]);
    expect(reconcileReason(h, A1, "accept")).toBe(RECONCILE_COPY.notExact);
    expect(reconcileReason(h, A1, "record")).toBeNull();
  });

  it("refuses an attempt that needs no reconciliation, or that is not on the bill", () => {
    const h = history([raw({ status: "verified" })], [receipt({ amount: 5000 })], 5000, 5000);
    expect(reconcileReason(h, A1, "record")).toBe(RECONCILE_COPY.notNeeded);
    expect(reconcileReason(h, A2, "accept")).toBe(RECONCILE_COPY.notNeeded);
  });

  it("refuses while any attempt on the bill has an unknown outcome", () => {
    const h = history([raw({}), raw({ id: A2, status: "pending", provider_tracking_id: null })], [receipt({ amount: 5000 })], 5000, 5000);
    expect(reconcileReason(h, A1, "record")).toBe(RECONCILE_COPY.unknownOutcome);
    // A failed one with no tracking id is closed.
    const closed = history([raw({}), raw({ id: A2, status: "failed", provider_tracking_id: null })], [receipt({ amount: 5000 })], 5000, 5000);
    expect(reconcileReason(closed, A1, "accept")).toBeNull();
  });

  it("refuses receipts in another currency than the attempt's", () => {
    const h = history([raw({})], [receipt({ amount: 5000 }), receipt({ id: "r2", currency: "USD", amount: 1 })], 5000, 5000);
    expect(reconcileReason(h, A1, "record")).toBe(RECONCILE_COPY.mixed);
  });

  it("compares decimal sums as the database does", () => {
    const h = narrowHistory({ attempts: [raw({ currency: "USD" })], receipts: [], currentTotal: 0.3, currency: "USD", received: 0.1 + 0.2, difference: 0 });
    expect(reconcileReason(h, A1, "accept")).toBeNull();
  });
});
