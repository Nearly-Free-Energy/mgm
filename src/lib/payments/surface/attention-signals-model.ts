import "server-only";

/**
 * The signals of the payments watchers (./attention-signals.ts), built from
 * rows already read: `payments.reconcile`, attempts held for a manager to
 * reconcile, and `payments.failed`, recent failures on bills still unpaid.
 * One signal per billing period, leading to the period's payments, or
 * straight to the bill when only one is concerned.
 *
 * No clock and no I/O. Fixed copy: the
 * microgrid's name, a count and the period's name, as the close ceremony
 * names it (periodName in @/lib/billing/close.ts). No tenant, amount,
 * reference or provider detail reaches a signal, since an assistant may
 * read signals (#133's data boundary).
 */
import { periodName } from "@/lib/billing/close";
import { periodLabel } from "@/lib/billing/surface/period-label";
import { MAX_SIGNALS_PER_SOURCE, type Fmt, type SignalOut } from "@/lib/gui/surface";
import type { PaymentStatus } from "../state";
import type { AttentionAttempt } from "../repository";
import { BILL_PARAM } from "./bill-attempts-model";

export const RECONCILE_SIGNAL = "payments.reconcile";
export const FAILED_SIGNAL = "payments.failed";
/** How far back `payments.failed` looks: a failure older than this is no longer news. */
export const FAILED_WINDOW_DAYS = 7;

/** A bill as the watchers read it: its payment status and its period on its microgrid. */
export type AttentionBill = {
  id: string;
  paymentStatus: PaymentStatus;
  periodId: string;
  startDate: string;
  endDate: string;
  microgridId: string;
  microgridName: string;
};

/** The bill payment statuses after which a failed attempt needs nothing more. */
const SETTLED: ReadonlySet<PaymentStatus> = new Set(["paid", "refunded"]);

type Group = { bill: AttentionBill; attempts: AttentionAttempt[]; bills: Set<string> };

function byPeriod(attempts: readonly AttentionAttempt[], bills: ReadonlyMap<string, AttentionBill>): Group[] {
  const groups = new Map<string, Group>();
  for (const attempt of attempts) {
    const bill = bills.get(attempt.lineItemId);
    // A bill the person's client did not return is not theirs to see.
    if (!bill) continue;
    const group = groups.get(bill.periodId) ?? { bill, attempts: [], bills: new Set<string>() };
    group.attempts.push(attempt);
    group.bills.add(bill.id);
    groups.set(bill.periodId, group);
  }
  const newest = (g: Group) => g.attempts.reduce((at, a) => (Date.parse(a.updatedAt) > Date.parse(at) ? a.updatedAt : at), g.attempts[0].updatedAt);
  return [...groups.values()]
    .sort((a, b) => Date.parse(newest(b)) - Date.parse(newest(a)) || a.bill.periodId.localeCompare(b.bill.periodId))
    .slice(0, MAX_SIGNALS_PER_SOURCE)
    .map((g) => ({ ...g, attempts: [...g.attempts].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt)) }));
}

const payments = (n: number) => (n === 1 ? "1 payment" : `${n} payments`);

function signal(fmt: Fmt, g: Group, o: { severity: "warn" | "critical"; title: (name: string, n: number) => string }): SignalOut {
  const { bill } = g;
  const label = periodLabel(fmt, bill.startDate, bill.endDate);
  const name = periodName(bill.startDate, bill.endDate) ?? label;
  const page = `/microgrids/${bill.microgridId}/billing/${bill.periodId}/payments` as const;
  const [only] = g.bills;
  return {
    id: bill.periodId,
    kind: "your-move",
    severity: o.severity,
    title: `${bill.microgridName}: ${o.title(name, g.attempts.length)}`,
    facts: [fmt.text(label)],
    entity: { kind: "microgrid", id: bill.microgridId, label: bill.microgridName },
    href: g.bills.size === 1 ? `${page}?${BILL_PARAM}=${only}` : page,
    at: new Date(g.attempts[0].updatedAt).toISOString(),
  };
}

/** One critical signal per period with attempts held for reconciliation, newest first. */
export function buildReconcileSignals(fmt: Fmt, attempts: readonly AttentionAttempt[], bills: ReadonlyMap<string, AttentionBill>): SignalOut[] {
  return byPeriod(attempts, bills).map((g) =>
    signal(fmt, g, { severity: "critical", title: (name, n) => `${payments(n)} in ${name} ${n === 1 ? "needs" : "need"} reconciliation` }),
  );
}

/**
 * One signal per period with recent failures on bills still to be paid,
 * newest first. A failure on a bill since paid or refunded, or on a bill
 * that also has an attempt held for reconciliation (`payments.reconcile`
 * reports that bill), is left out.
 */
export function buildFailedSignals(
  fmt: Fmt,
  failed: readonly AttentionAttempt[],
  held: readonly AttentionAttempt[],
  bills: ReadonlyMap<string, AttentionBill>,
): SignalOut[] {
  const reconciling = new Set(held.map((a) => a.lineItemId));
  const open = failed.filter((a) => {
    const bill = bills.get(a.lineItemId);
    return bill !== undefined && !SETTLED.has(bill.paymentStatus) && !reconciling.has(a.lineItemId);
  });
  return byPeriod(open, bills).map((g) => signal(fmt, g, { severity: "warn", title: (name, n) => `${payments(n)} failed in ${name}` }));
}
