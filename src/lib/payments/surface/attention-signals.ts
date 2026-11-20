import "server-only";

/**
 * The payments watchers, `payments.reconcile` and `payments.failed`
 * (./attention-signals-model.ts).
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
 * user_can_access_microgrid); if those policies change, revisit what this
 * shows. Composing on req.supabase queues that client's other queries
 * behind getUser's auth lock, so the bills are read after the capability.
 *
 * When listAttention reports more attempts than it returns (`truncated`),
 * the counts cover only the most recently changed ones.
 *
 * Any refusal or failed read throws, so the host lists the watcher as
 * unchecked rather than as having nothing to report; the error itself is
 * not passed on.
 */
import type { SignalOut, SurfaceRequest } from "@/lib/gui/surface";
import { composePayments } from "../compose";
import type { AttentionAttempt } from "../repository";
import type { PaymentStatus } from "../state";
import { buildFailedSignals, buildReconcileSignals, FAILED_WINDOW_DAYS, type AttentionBill } from "./attention-signals-model";

/** Bills read per request, so the id list stays well inside a URL. */
const BILLS_PER_READ = 100;

type Query = { status: "needs_reconciliation" } | { status: "failed"; since: string };
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

/** Each query's attempts, in order, from one composition of the capability. */
async function attention(req: SurfaceRequest, queries: Query[]): Promise<AttentionAttempt[][]> {
  const composed = await composePayments({ supabase: req.supabase, organizationId: req.organizationId });
  if (!composed.ok) throw new Error(`payments watcher: the capability could not be composed (${composed.status})`);
  try {
    const out: AttentionAttempt[][] = [];
    for (const query of queries) {
      const listed = await composed.data.payments.listAttention(query);
      if (!listed.ok) throw new Error(`payments watcher: listAttention refused (${listed.status})`);
      out.push(listed.data.attempts);
    }
    return out;
  } finally {
    await composed.data.dispose();
  }
}

/** The bills the attempts are for, with their periods and microgrids, as the person's client returns them. */
async function readBills(req: SurfaceRequest, attempts: readonly AttentionAttempt[]): Promise<Map<string, AttentionBill>> {
  const ids = [...new Set(attempts.map((a) => a.lineItemId))];
  const chunks = Array.from({ length: Math.ceil(ids.length / BILLS_PER_READ) }, (_, i) => ids.slice(i * BILLS_PER_READ, (i + 1) * BILLS_PER_READ));
  const reads = await Promise.all(
    chunks.map((chunk) =>
      req.supabase
        .from("billing_line_items")
        .select("id, payment_status, billing_periods!inner(id, start_date, end_date, microgrid_id, microgrids!inner(id, name))")
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
  const [held] = await attention(req, [{ status: "needs_reconciliation" }]);
  if (held.length === 0) return [];
  return buildReconcileSignals(req.fmt, held, await readBills(req, held));
}

/** `payments.failed`: the periods with failures in the last FAILED_WINDOW_DAYS on bills still to be paid. */
export async function loadFailedSignals(req: SurfaceRequest): Promise<SignalOut[]> {
  const since = new Date(req.now.getTime() - FAILED_WINDOW_DAYS * 86_400_000).toISOString();
  const [failed, held] = await attention(req, [{ status: "failed", since }, { status: "needs_reconciliation" }]);
  if (failed.length === 0) return [];
  return buildFailedSignals(req.fmt, failed, held, await readBills(req, failed));
}
