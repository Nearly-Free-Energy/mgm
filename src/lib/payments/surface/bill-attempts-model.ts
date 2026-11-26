/**
 * bill-attempts-model.ts — a billing period's bills, and one bill's online
 * payment attempts with its balance, as a `collection` view model
 * (`payments.bill-attempts`), with Refresh status and the two
 * reconciliations on each attempt.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here.
 *
 * The view has two modes, chosen by its `bill` query parameter. Without it,
 * it lists the period's bills, each linking to the view again with
 * `?bill=<id>`: the GUI contract attaches a view to a view, not to one row
 * of it, so the period review shows this view as a tab and a person picks
 * the bill here (parity.ts, payment-history). With it, it lists that bill's
 * attempts, as the legacy payment history dialog did.
 *
 * What never enters the model: an attempt's checkout URL (a payable
 * provider link), its provider tracking id, its merchant account, its
 * resolution notes and its failure message, which may hold a provider's
 * raw response (PaymentsCapability stores err.message there). The loader
 * narrows each attempt to BillAttempt first, and a failure becomes a fixed
 * note from its failure code. The merchant reference (MGM's own
 * `MGM-<uuid>`) and a receipt's confirmation code are shown, as the legacy
 * dialog shows them.
 */
import type { LinkRef, Value } from "@/lib/gui/contract";
import type { ActionLink, Fmt, LoadedModel } from "@/lib/gui/surface";
import { periodLabel } from "@/lib/billing/surface/period-label";
import type { PaymentStatus } from "../state";
import type { AttemptStatus, PaymentAttempt, PaymentReceipt } from "../repository";
import { RECONCILE_COPY } from "../schemas";

export const REFRESH_ATTEMPT_ACTION = { id: "payments.refresh-attempt", title: "Refresh status" } as const;
export const RECORD_ADJUSTMENT_ACTION = { id: "payments.record-adjustment", title: "Record completed adjustment" } as const;
export const ACCEPT_RECEIPTS_ACTION = { id: "payments.accept-receipts", title: "Accept exact receipts" } as const;

/** The query parameter naming the bill whose attempts are shown. */
export const BILL_PARAM = "bill";
export const ALL_BILLS_LINK = "payments.all-bills";

/** Every cell key the view emits, in both modes. */
export const BILL_ATTEMPTS_KEYS = ["tenant", "total", "bill_status", "created", "amount", "status", "reference", "receipts", "note"] as const;

/** The view's own page, for one bill when `billId` is given. */
export function billAttemptsHref(microgridId: string, periodId: string, billId?: string): `/${string}` {
  const path = `/microgrids/${microgridId}/billing/${periodId}/payments` as const;
  return billId === undefined ? path : `${path}?${BILL_PARAM}=${encodeURIComponent(billId)}`;
}

/**
 * A failed or held attempt's note, by failure code, in place of its failure
 * message. The codes are written by PaymentsCapability (./capability.ts:
 * checkout_superseded, checkout_not_submitted, confirmation_pending, and a
 * provider factory's code when no provider can be built) and by
 * fn_payment_commit_verification and the bill trigger
 * (20261010202643_payments_integrity.sql: bill_revised, balance_mismatch,
 * reversal); if either writes a new code, add its note here, or it reads as
 * OTHER_FAILURE_NOTE.
 */
export const FAILURE_NOTES: Readonly<Record<string, string>> = {
  bill_revised: "The bill changed after this checkout was created.",
  balance_mismatch: "The receipt differs from the current bill or repeats a settlement.",
  reversal: "The provider reversed this payment: review the balance.",
  checkout_superseded: "Replaced by a newer checkout.",
  checkout_not_submitted: "The checkout never reached the provider.",
  confirmation_pending: "The provider has not confirmed this checkout yet.",
};
export const OTHER_FAILURE_NOTE = "The provider could not start this checkout.";
/** refreshPaymentStatus's own copy for an attempt with no tracking id (./capability.ts); if it changes, so may this. */
export const UNTRACKED_NOTE =
  "Submission outcome is unknown. Await provider notification or investigate this reference with the provider; do not resubmit.";

/** The statuses fn_payment_reconcile counts as an open submission when it has no tracking id. */
const OPEN_STATUSES: readonly AttemptStatus[] = ["pending", "confirmation_pending", "needs_reconciliation"];

/** An attempt as the model may see it: no checkout URL, tracking id, account or failure message. */
export type BillAttempt = {
  id: string;
  status: AttemptStatus;
  amount: number;
  currency: string;
  merchant_reference: string;
  failure_code: string | null;
  /** The attempt has a provider tracking id, so Refresh status can ask the provider about it. */
  hasTracking: boolean;
  created_at: string;
};
export type BillReceipt = Pick<PaymentReceipt, "id" | "attempt_id" | "amount" | "currency" | "provider_status" | "confirmation_code" | "created_at">;

/** One bill's history from the capability's listHistory, narrowed. */
export type BillHistory = {
  attempts: BillAttempt[];
  receipts: BillReceipt[];
  currentTotal: number;
  currency: string;
  received: number;
  difference: number;
};

/**
 * listHistory's answer as the model may see it. Each field is copied by
 * name, so a column the capability comes to return does not reach the
 * model unless it is added here.
 */
export function narrowHistory(h: {
  attempts: readonly PaymentAttempt[];
  receipts: readonly PaymentReceipt[];
  currentTotal: number;
  currency: string;
  received: number;
  difference: number;
}): BillHistory {
  return {
    attempts: h.attempts.map((a) => ({
      id: a.id,
      status: a.status,
      amount: Number(a.amount),
      currency: a.currency,
      merchant_reference: a.merchant_reference,
      failure_code: a.failure_code,
      hasTracking: Boolean(a.provider_tracking_id),
      created_at: a.created_at,
    })),
    receipts: h.receipts.map((r) => ({
      id: r.id,
      attempt_id: r.attempt_id,
      amount: Number(r.amount),
      currency: r.currency,
      provider_status: r.provider_status,
      confirmation_code: r.confirmation_code,
      created_at: r.created_at,
    })),
    currentTotal: Number(h.currentTotal),
    currency: h.currency,
    received: Number(h.received),
    difference: Number(h.difference),
  };
}

/** The attempt's note: unknown outcome, or its failure's fixed note, or none. */
export function attemptNote(a: BillAttempt): string | null {
  if (!a.hasTracking && OPEN_STATUSES.includes(a.status)) return UNTRACKED_NOTE;
  if (a.failure_code === null || a.failure_code === "") return null;
  return Object.hasOwn(FAILURE_NOTES, a.failure_code) ? FAILURE_NOTES[a.failure_code] : OTHER_FAILURE_NOTE;
}

/** Equal to a millionth, so a sum of decimal amounts compares as the database's NUMERIC does. */
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/**
 * Why `which` cannot resolve the attempt now, or null when it can. Mirrors
 * fn_payment_reconcile's refusals, in its order
 * (20261010202643_payments_integrity.sql): an attempt that does not need
 * reconciliation; any attempt on the bill with no tracking id that is still
 * open; a receipt in another currency than the attempt's; and, for
 * accepting, a received total that is not exactly the bill. The function
 * counts received as completed receipts less reversed ones plus earlier
 * external adjustments, as listHistory's `received` does once currencies
 * agree, so the difference here is the one it decides on. A completed
 * adjustment's amount is the person's to enter, so it is checked when it is
 * sent. If the function's checks change, revisit; the route stays the
 * authority either way.
 */
export function reconcileReason(h: BillHistory, attemptId: string, which: "record" | "accept"): string | null {
  const attempt = h.attempts.find((a) => a.id === attemptId);
  if (!attempt || attempt.status !== "needs_reconciliation") return RECONCILE_COPY.notNeeded;
  if (h.attempts.some((a) => !a.hasTracking && OPEN_STATUSES.includes(a.status))) return RECONCILE_COPY.unknownOutcome;
  if (h.receipts.some((r) => r.currency !== attempt.currency)) return RECONCILE_COPY.mixed;
  if (which === "accept" && !same(h.received, h.currentTotal)) return RECONCILE_COPY.notExact;
  return null;
}

type Row = LoadedModel<"collection">["body"]["rows"][number];
type Column = LoadedModel<"collection">["body"]["columns"][number];

export type AttemptsPeriod = { id: string; start_date: string; end_date: string };

export type IndexBill = { id: string; tenantName: string; total_amount: number; payment_status: PaymentStatus };

export type BillsIndexInput = {
  microgrid: { id: string; currency: string };
  period: AttemptsPeriod;
  /** The period's bills in tenant name order. */
  bills: readonly IndexBill[];
  fmt: Fmt;
};

export const BILL_ATTEMPTS_EMPTY = {
  index: { title: "No bills in this period", text: "Generate bills on the period first." },
  bill: { title: "No online payment attempts", text: "Receipts remain available when online payments are disabled." },
} as const;

/** The period's bills, each linking to its attempts. Its title names the period review's tab. */
export function buildBillsIndexModel(i: BillsIndexInput): LoadedModel<"collection"> {
  const { microgrid, period, fmt } = i;
  const columns: Column[] = [
    { key: "tenant", label: "Tenant", type: "text", priority: 1 },
    { key: "total", label: "Bill", type: "money", priority: 1 },
    { key: "bill_status", label: "Payment", type: "status", priority: 1 },
  ];
  // No entity and no related refs on a row, so no other plugin's targeted
  // action (billing's Regenerate, on a bill) is appended here: this view
  // offers only its own. If a row comes to carry the bill, revisit.
  const rows: Row[] = i.bills.map((bill) => ({
    id: bill.id,
    href: billAttemptsHref(microgrid.id, period.id, bill.id),
    cells: {
      tenant: fmt.text(bill.tenantName),
      total: fmt.money(Number(bill.total_amount), microgrid.currency),
      bill_status: fmt.status("billingLineItemPaymentStatus", bill.payment_status),
    },
    actions: [],
  }));
  return {
    title: "Payments",
    subtitle: periodLabel(fmt, period.start_date, period.end_date),
    actions: [],
    body: { columns, rows, empty: { ...BILL_ATTEMPTS_EMPTY.index } },
  };
}

export type BillAttemptsInput = {
  microgrid: { id: string };
  period: AttemptsPeriod;
  bill: { id: string; tenantName: string };
  /** The period's time zone, else the microgrid's, else UTC. */
  timezone: string;
  history: BillHistory;
  fmt: Fmt;
};

/** The receipts of one attempt as one line: "Completed UGX 2,500 · code ABC; …". */
function receiptsText(fmt: Fmt, receipts: readonly BillReceipt[]): Value {
  if (receipts.length === 0) return fmt.empty();
  const line = (r: BillReceipt) => {
    const status = r.provider_status.charAt(0).toUpperCase() + r.provider_status.slice(1).replaceAll("_", " ");
    const code = r.confirmation_code ? ` · code ${r.confirmation_code}` : "";
    return `${status} ${fmt.money(r.amount, r.currency).text}${code}`;
  };
  return fmt.text(receipts.map(line).join("; "));
}

/**
 * The actions an attempt offers. Refresh status only on an attempt with a
 * tracking id, which refreshPaymentStatus needs (it refuses the others with
 * the unknown-outcome copy, which the row's note already says). Both
 * reconciliations on an attempt that needs reconciliation; each action's
 * own input fixes its resolution (../schemas.ts), so neither needs a
 * prefill, and their available() says when one does not apply.
 */
export function attemptActions(a: BillAttempt): ActionLink[] {
  const params = { id: a.id };
  const out: ActionLink[] = [];
  if (a.hasTracking) out.push({ action: REFRESH_ATTEMPT_ACTION.id, params });
  if (a.status === "needs_reconciliation") {
    out.push({ action: RECORD_ADJUSTMENT_ACTION.id, params });
    out.push({ action: ACCEPT_RECEIPTS_ACTION.id, params });
  }
  return out;
}

/** One bill's attempts, oldest first, with its balance in the subtitle. */
export function buildBillAttemptsModel(i: BillAttemptsInput): LoadedModel<"collection"> {
  const { microgrid, period, bill, history, fmt } = i;
  const money = (v: number) => fmt.money(v, history.currency).text;
  const columns: Column[] = [
    { key: "created", label: "Started", type: "datetime", priority: 2 },
    { key: "amount", label: "Amount", type: "money", priority: 1 },
    { key: "status", label: "Status", type: "status", priority: 1 },
    { key: "reference", label: "Reference", type: "text", priority: 3 },
    { key: "receipts", label: "Receipts", type: "text", priority: 2 },
    { key: "note", label: "Note", type: "text", priority: 2 },
  ];
  const rows: Row[] = history.attempts.map((a) => {
    const note = attemptNote(a);
    return {
      id: a.id,
      entity: { kind: "paymentAttempt", id: a.id, label: a.merchant_reference },
      cells: {
        created: fmt.datetime(a.created_at, i.timezone),
        amount: fmt.money(a.amount, a.currency),
        status: fmt.status("paymentAttempt", a.status),
        reference: fmt.text(a.merchant_reference),
        receipts: receiptsText(
          fmt,
          history.receipts.filter((r) => r.attempt_id === a.id),
        ),
        note: note === null ? fmt.empty() : fmt.text(note),
      },
      actions: attemptActions(a),
    };
  });
  // Totals are drawn per column, so the balance is the subtitle.
  const balance = `Bill ${money(history.currentTotal)} · Received ${money(history.received)} · Difference ${money(history.difference)}`;
  const links: LinkRef[] = [{ id: ALL_BILLS_LINK, label: "All bills", href: billAttemptsHref(microgrid.id, period.id) }];
  return {
    title: `Payments: ${bill.tenantName}`,
    subtitle: `${periodLabel(fmt, period.start_date, period.end_date)} · ${balance}`,
    actions: [],
    links,
    body: { columns, rows, empty: { ...BILL_ATTEMPTS_EMPTY.bill } },
  };
}
