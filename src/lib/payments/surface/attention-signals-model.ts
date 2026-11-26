import "server-only";

/**
 * The signals of the payments watchers (./attention-signals.ts), built from
 * rows already read: `payments.reconcile`, attempts held for a manager to
 * reconcile, counted by attempt, and `payments.failed`, recent failures on
 * bills still unpaid, counted by bill, so retries of one bill read as one;
 * one signal per billing period, leading to the period's payments, or
 * straight to the bill when only one is concerned; and
 * `payments.not-submitted`, one signal per community where several
 * checkouts never reached the provider in a day, leading to the community's
 * payment setup.
 *
 * Severities (decided on #230): reconciliation is critical only when money
 * may have reached Pesapal, that is when an attempt held in the period
 * reached the provider (a tracking id or a receipt, AttentionAttempt's
 * `reachedProvider`); otherwise, as for a checkout flagged by a draft
 * correction before anyone opened it, it is a warning. Failures and
 * checkouts never submitted are warnings.
 *
 * No clock and no I/O. Fixed copy: the
 * microgrid's or community's name, a count and the period's name, as the
 * close ceremony names it (periodName in @/lib/billing/close.ts). No
 * tenant, amount, reference or provider detail reaches a signal, since an
 * assistant may read signals (#133's data boundary).
 */
import { periodName } from "@/lib/billing/close";
import { periodLabel } from "@/lib/billing/surface/period-label";
import { MAX_SIGNALS_PER_SOURCE, type Fmt, type SignalOut } from "@/lib/gui/surface";
import type { PaymentStatus } from "../state";
import type { AttentionAttempt } from "../repository";
import { BILL_PARAM } from "./bill-attempts-model";

export const RECONCILE_SIGNAL = "payments.reconcile";
export const FAILED_SIGNAL = "payments.failed";
export const NOT_SUBMITTED_SIGNAL = "payments.not-submitted";
/** How far back `payments.failed` looks: a failure older than this is no longer news. */
export const FAILED_WINDOW_DAYS = 7;
/** How far back `payments.not-submitted` looks. */
export const NOT_SUBMITTED_WINDOW_HOURS = 24;
/** How many checkouts never submitted, in one community within the window, make a signal; fewer are a passing provider error. */
export const NOT_SUBMITTED_THRESHOLD = 3;

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
const checkouts = (n: number) => (n === 1 ? "1 checkout" : `${n} checkouts`);

function signal(fmt: Fmt, g: Group, o: { severity: "warn" | "critical"; title: (name: string) => string }): SignalOut {
  const { bill } = g;
  const label = periodLabel(fmt, bill.startDate, bill.endDate);
  const name = periodName(bill.startDate, bill.endDate) ?? label;
  const page = `/microgrids/${bill.microgridId}/billing/${bill.periodId}/payments` as const;
  const [only] = g.bills;
  return {
    id: bill.periodId,
    kind: "your-move",
    severity: o.severity,
    title: `${bill.microgridName}: ${o.title(name)}`,
    facts: [fmt.text(label)],
    entity: { kind: "microgrid", id: bill.microgridId, label: bill.microgridName },
    href: g.bills.size === 1 ? `${page}?${BILL_PARAM}=${only}` : page,
    at: new Date(g.attempts[0].updatedAt).toISOString(),
  };
}

/**
 * One signal per period with attempts held for reconciliation, newest first:
 * critical when any of them reached the provider ("payments … need
 * reconciliation"), a warning when none did ("checkouts … need
 * reconciliation"), since then no money can have moved.
 */
export function buildReconcileSignals(fmt: Fmt, attempts: readonly AttentionAttempt[], bills: ReadonlyMap<string, AttentionBill>): SignalOut[] {
  const need = (n: number) => (n === 1 ? "needs" : "need");
  return byPeriod(attempts, bills).map((g) => {
    const n = g.attempts.length;
    return g.attempts.some((a) => a.reachedProvider)
      ? signal(fmt, g, { severity: "critical", title: (name) => `${payments(n)} in ${name} ${need(n)} reconciliation` })
      : signal(fmt, g, { severity: "warn", title: (name) => `${checkouts(n)} in ${name} ${need(n)} reconciliation` });
  });
}

/**
 * One signal per period with recent failures on bills still to be paid,
 * newest first, counting the bills, not the attempts: three failed retries
 * of one bill are one bill with a failed payment. A failure on a bill since
 * paid or refunded, or on a bill that also has an attempt held for
 * reconciliation (`payments.reconcile` reports that bill), is left out.
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
  return byPeriod(open, bills).map((g) => {
    const n = g.bills.size;
    return signal(fmt, g, { severity: "warn", title: (name) => (n === 1 ? `1 bill has a failed payment in ${name}` : `${n} bills have failed payments in ${name}`) });
  });
}

/**
 * One warning per community with NOT_SUBMITTED_THRESHOLD or more checkouts
 * the provider never accepted, newest first. `attempts` are such checkouts
 * from the last NOT_SUBMITTED_WINDOW_HOURS; `communities` names the
 * communities the person's client returned, and an attempt for any other,
 * or with no community, is left out.
 */
export function buildNotSubmittedSignals(fmt: Fmt, attempts: readonly AttentionAttempt[], communities: ReadonlyMap<string, string>): SignalOut[] {
  const groups = new Map<string, AttentionAttempt[]>();
  for (const attempt of attempts) {
    if (attempt.communityId === null || !communities.has(attempt.communityId)) continue;
    groups.set(attempt.communityId, [...(groups.get(attempt.communityId) ?? []), attempt]);
  }
  const newest = (list: readonly AttentionAttempt[]) => Math.max(...list.map((a) => Date.parse(a.updatedAt)));
  return [...groups.entries()]
    .filter(([, list]) => list.length >= NOT_SUBMITTED_THRESHOLD)
    .sort(([a, x], [b, y]) => newest(y) - newest(x) || a.localeCompare(b))
    .slice(0, MAX_SIGNALS_PER_SOURCE)
    .map(([id, list]): SignalOut => {
      const name = communities.get(id) ?? "";
      return {
        id,
        kind: "your-move",
        severity: "warn",
        title: `${name}: ${list.length} checkouts did not reach Pesapal in the last ${NOT_SUBMITTED_WINDOW_HOURS} hours`,
        facts: [fmt.text("Check the payment account")],
        entity: { kind: "community", id, label: name },
        href: `/communities/${id}/payment`,
        at: new Date(newest(list)).toISOString(),
      };
    });
}
