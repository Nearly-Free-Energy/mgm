import "server-only";

/**
 * The payments watchers, `payments.reconcile`, `payments.failed` and
 * `payments.not-submitted` (./attention-signals-model.ts).
 *
 * The attempts come from the Payments capability's listAttention (a read
 * listed in gui-surface.test.ts's LOADER_READS), composed with
 * composePayments, which checks the session with getUser and the person's
 * access to the organization, and filtered to the organization by the
 * capability. The watchers read no payment table themselves, as the
 * `payments.bill-attempts` loader does not, so the capability's one
 * definition of what needs attention is what they report. The bills and
 * their periods are then read through the person's own client (row-level
 * security: billing_line_items and billing_periods are FOR ALL on
 * user_can_access_microgrid), filtered to the organization through the
 * period's microgrid and community as well, as the billing and metering
 * watchers filter theirs, so a super admin's client, which sees every
 * organization, returns only this one's; if those policies change, revisit
 * what this shows. Composing on req.supabase queues that client's other
 * queries behind getUser's auth lock, so the bills are read after the
 * capability. `payments.not-submitted` reads the communities' names the
 * same way (communities is FOR ALL on user_can_access_org), filtered to the
 * organization.
 *
 * When listAttention reports more attempts than it returns (`truncated`),
 * every watcher throws, so it is listed as unchecked: the listing keeps the
 * most recently changed attempts, so a cut one is the oldest, and a period
 * whose held attempts were all cut would otherwise lose its signal without
 * notice, and a held list cut short could show a held bill as failed.
 *
 * Any refusal or failed read throws, so the host lists the watcher as
 * unchecked rather than as having nothing to report; the error itself is
 * not passed on.
 */
import type { SignalOut, SurfaceRequest } from "@/lib/gui/surface";
import { composePayments } from "../compose";
import { CHECKOUT_NOT_SUBMITTED, type AttentionAttempt } from "../repository";
import type { PaymentStatus } from "../state";
import {
  buildFailedSignals,
  buildNotSubmittedSignals,
  buildReconcileSignals,
  FAILED_SIGNAL,
  FAILED_WINDOW_DAYS,
  NOT_SUBMITTED_THRESHOLD,
  NOT_SUBMITTED_WINDOW_HOURS,
  RECONCILE_SIGNAL,
  type AttentionBill,
} from "./attention-signals-model";

/** Bills read per request, so the id list stays well inside a URL. */
const BILLS_PER_READ = 100;

type Query =
  | { status: "needs_reconciliation" }
  | { status: "failed"; since: string }
  | { status: "failed"; since: string; failureCode: typeof CHECKOUT_NOT_SUBMITTED };
type Listed = { attempts: AttentionAttempt[]; truncated: boolean };
type Embedded<T> = T | T[] | null;
type BillRow = {
  id: string;
  payment_status: PaymentStatus;
  billing_periods: Embedded<{
    id: string;
    start_date: string;
    end_date: string;
    microgrid_id: string;
    microgrids: Embedded<{ id: string; name: string }>;
  }>;
};
const one = <T>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

/** Each query's answer, in order, from one composition of the capability. */
async function listed(req: SurfaceRequest, queries: Query[]): Promise<Listed[]> {
  const composed = await composePayments({ supabase: req.supabase, organizationId: req.organizationId });
  if (!composed.ok) throw new Error(`payments watcher: the capability could not be composed (${composed.status})`);
  try {
    const out: Listed[] = [];
    for (const query of queries) {
      const answer = await composed.data.payments.listAttention(query);
      if (!answer.ok) throw new Error(`payments watcher: listAttention refused (${answer.status})`);
      out.push(answer.data);
    }
    return out;
  } finally {
    await composed.data.dispose();
  }
}

/** Each query's attempts, in order, from one composition of the capability; throws when any listing was cut short. */
async function attention(req: SurfaceRequest, watcher: string, queries: Query[]): Promise<AttentionAttempt[][]> {
  const answers = await listed(req, queries);
  if (answers.some((l) => l.truncated)) throw new Error(`${watcher}: more attempts than one read returns`);
  return answers.map((l) => l.attempts);
}

/** The bills the attempts are for, with their periods and microgrids, as the person's client returns them for the organization. */
async function readBills(req: SurfaceRequest, attempts: readonly AttentionAttempt[]): Promise<Map<string, AttentionBill>> {
  const ids = [...new Set(attempts.map((a) => a.lineItemId))];
  const chunks = Array.from({ length: Math.ceil(ids.length / BILLS_PER_READ) }, (_, i) => ids.slice(i * BILLS_PER_READ, (i + 1) * BILLS_PER_READ));
  const reads = await Promise.all(
    chunks.map((chunk) =>
      req.supabase
        .from("billing_line_items")
        .select("id, payment_status, billing_periods!inner(id, start_date, end_date, microgrid_id, microgrids!inner(id, name, communities!inner(org_id)))")
        .eq("billing_periods.microgrids.communities.org_id", req.organizationId)
        .in("id", chunk),
    ),
  );
  const bills = new Map<string, AttentionBill>();
  for (const { data, error } of reads) {
    if (error) throw new Error("payments watcher: the bills could not be read");
    for (const row of (data ?? []) as unknown as BillRow[]) {
      const period = one(row.billing_periods);
      const microgrid = period ? one(period.microgrids) : null;
      if (!period || !microgrid) continue;
      bills.set(row.id, {
        id: row.id,
        paymentStatus: row.payment_status,
        periodId: period.id,
        startDate: period.start_date,
        endDate: period.end_date,
        microgridId: microgrid.id,
        microgridName: microgrid.name,
      });
    }
  }
  return bills;
}

/** `payments.reconcile`: the periods with attempts held for a manager to reconcile. */
export async function loadReconcileSignals(req: SurfaceRequest): Promise<SignalOut[]> {
  const [held] = await attention(req, RECONCILE_SIGNAL, [{ status: "needs_reconciliation" }]);
  if (held.length === 0) return [];
  return buildReconcileSignals(req.fmt, held, await readBills(req, held));
}

/** `payments.failed`: the periods with failures in the last FAILED_WINDOW_DAYS on bills still to be paid. */
export async function loadFailedSignals(req: SurfaceRequest): Promise<SignalOut[]> {
  const since = new Date(req.now.getTime() - FAILED_WINDOW_DAYS * 86_400_000).toISOString();
  const [failed, held] = await attention(req, FAILED_SIGNAL, [{ status: "failed", since }, { status: "needs_reconciliation" }]);
  if (failed.length === 0) return [];
  return buildFailedSignals(req.fmt, failed, held, await readBills(req, failed));
}

/**
 * `payments.not-submitted`: the communities where NOT_SUBMITTED_THRESHOLD or
 * more checkouts never reached the provider in the last
 * NOT_SUBMITTED_WINDOW_HOURS, which points at the payment account rather
 * than at any one bill.
 */
export async function loadNotSubmittedSignals(req: SurfaceRequest): Promise<SignalOut[]> {
  const since = new Date(req.now.getTime() - NOT_SUBMITTED_WINDOW_HOURS * 3_600_000).toISOString();
  const [answer] = await listed(req, [{ status: "failed", since, failureCode: CHECKOUT_NOT_SUBMITTED }]);
  if (answer.truncated) throw new Error("payments.not-submitted: more checkouts than one read returns");
  const counts = new Map<string, number>();
  for (const a of answer.attempts) if (a.communityId !== null) counts.set(a.communityId, (counts.get(a.communityId) ?? 0) + 1);
  const ids = [...counts].filter(([, n]) => n >= NOT_SUBMITTED_THRESHOLD).map(([id]) => id);
  if (ids.length === 0) return [];
  // At most MAX_ATTENTION_ATTEMPTS / NOT_SUBMITTED_THRESHOLD ids, so one read stays well inside a URL.
  const { data, error } = await req.supabase.from("communities").select("id, name").eq("org_id", req.organizationId).in("id", ids);
  if (error) throw new Error("payments.not-submitted: the communities could not be read");
  const names = new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  return buildNotSubmittedSignals(req.fmt, answer.attempts, names);
}
