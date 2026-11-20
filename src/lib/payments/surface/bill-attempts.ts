import "server-only";

/**
 * The loader of the `payments.bill-attempts` view, and the availability and
 * confirmation steps of the actions it offers (./bill-attempts-model.ts).
 *
 * The period, the microgrid and the bills are read through the person's own
 * client (row-level security), as billing's period review reads them:
 * billing_periods and billing_line_items are FOR ALL on
 * user_can_access_microgrid, and tenants on its microgrid; if their
 * policies change, revisit what this shows.
 *
 * A bill's attempts, receipts and balance come from the Payments
 * capability's listHistory (a read listed in gui-surface.test.ts's
 * LOADER_READS), composed with composePayments, which checks the session
 * with getUser and the person's access to the organization. listHistory
 * reads through the same client; the loader reads no payment table itself,
 * so the capability's one definition of received and difference is what
 * the view shows. Composing on req.supabase queues that client's other
 * queries behind getUser's auth lock (as the legacy period page found), so
 * it runs after the view's own reads.
 *
 * The view and its actions follow the reconcile route on who may act: any
 * staff member with access to the organization, as composePayments and
 * fn_payment_reconcile's actor check decide (super_admin, or org_manager of
 * the attempt's organization). If fn_payment_reconcile's actor check
 * narrows (20261010202643_payments_integrity.sql), add the role rule here,
 * in availability and prepare, and in the capability.
 *
 * Every refusal carries fixed copy, never a database or capability message.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import type { PaymentStatus } from "../state";
import { composePayments } from "../compose";
import { RECONCILE_COPY } from "../schemas";
import {
  BILL_PARAM,
  buildBillAttemptsModel,
  buildBillsIndexModel,
  narrowHistory,
  reconcileReason,
  type BillHistory,
} from "./bill-attempts-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

/** The most bills the index lists, as the period review shows at most (PERIOD_REVIEW_MAX_ROWS); if that changes, so may this. */
export const BILL_ATTEMPTS_MAX_BILLS = 500;

export const BILL_ATTEMPTS_REFUSALS = {
  periodNotFound: { ok: false, status: 404, message: "This billing period could not be found." },
  billNotFound: { ok: false, status: 404, message: "This bill could not be found in this period." },
  forbidden: { ok: false, status: 403, message: RECONCILE_COPY.forbidden },
  unavailable: { ok: false, status: 503, message: "Could not load this bill's payments right now. Try again shortly." },
  tooLarge: { ok: false, status: 500, message: "This period has more bills than this view can show." },
} as const satisfies Record<string, Refusal>;

export const ATTEMPT_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This payment attempt could not be found." },
  forbidden: { ok: false, status: 403, message: RECONCILE_COPY.forbidden },
  unavailable: { ok: false, status: 503, message: "Could not check this payment attempt right now. Try again shortly." },
  noName: { ok: false, status: 409, message: "This bill's tenant has no name to type, so the adjustment cannot be confirmed here." },
} as const satisfies Record<string, Refusal>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PeriodRow = { id: string; microgrid_id: string; start_date: string; end_date: string; timezone: string | null };
type MicrogridRow = { id: string; name: string; currency: string | null; timezone: string | null };
type Embedded<T> = T | T[] | null;
type BillRow = {
  id: string;
  total_amount: number | string;
  payment_status: PaymentStatus;
  tenants: Embedded<{ display_name: string | null }>;
};
const BILL_COLUMNS = "id, total_amount, payment_status, tenants(display_name)";

const one = <T>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const tenantName = (b: { tenants: Embedded<{ display_name: string | null }> }) => (one(b.tenants)?.display_name ?? "").trim();

/**
 * One bill's history through the capability, narrowed for the model. A
 * bill the capability does not find in this organization is not found; a
 * composition the session or the organization refuses is forbidden.
 */
async function readHistory(req: SurfaceRequest, billId: string): Promise<{ ok: true; history: BillHistory } | { ok: false; refusal: "notFound" | "forbidden" | "unavailable" }> {
  try {
    const composed = await composePayments({ supabase: req.supabase, organizationId: req.organizationId, allowDisabled: true });
    if (!composed.ok) return { ok: false, refusal: composed.status === 401 || composed.status === 403 ? "forbidden" : "unavailable" };
    try {
      const history = await composed.data.payments.listHistory(billId);
      if (!history.ok) return { ok: false, refusal: history.status === 403 || history.status === 404 ? "notFound" : "unavailable" };
      return { ok: true, history: narrowHistory(history.data) };
    } finally {
      await composed.data.dispose();
    }
  } catch {
    return { ok: false, refusal: "unavailable" };
  }
}

export async function loadBillAttempts(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const microgridId = req.params.id;
  const [periodRes, microgridRes] = await Promise.all([
    req.supabase
      .from("billing_periods")
      .select("id, microgrid_id, start_date, end_date, timezone")
      .eq("id", req.params.periodId)
      .eq("microgrid_id", microgridId)
      .maybeSingle<PeriodRow>(),
    req.supabase.from("microgrids").select("id, name, currency, timezone").eq("id", microgridId).maybeSingle<MicrogridRow>(),
  ]);
  if (periodRes.error || microgridRes.error) return BILL_ATTEMPTS_REFUSALS.unavailable;
  const period = periodRes.data;
  const microgrid = microgridRes.data;
  if (!period || !microgrid) return BILL_ATTEMPTS_REFUSALS.periodNotFound;

  const billId = req.search.get(BILL_PARAM);
  if (billId === null) {
    // The index: the period's bills, with no payments read.
    const { data, error } = await req.supabase
      .from("billing_line_items")
      .select(BILL_COLUMNS)
      .eq("billing_period_id", period.id)
      .order("id")
      .limit(BILL_ATTEMPTS_MAX_BILLS + 1);
    if (error || !data) return BILL_ATTEMPTS_REFUSALS.unavailable;
    const rows = data as unknown as BillRow[];
    if (rows.length > BILL_ATTEMPTS_MAX_BILLS) return BILL_ATTEMPTS_REFUSALS.tooLarge;
    const bills = rows
      .map((b) => ({ id: b.id, tenantName: tenantName(b), total_amount: Number(b.total_amount), payment_status: b.payment_status }))
      // In tenant name order, as the period review lists them.
      .sort((a, b) => a.tenantName.localeCompare(b.tenantName) || a.id.localeCompare(b.id));
    return {
      ok: true,
      model: buildBillsIndexModel({ microgrid: { id: microgrid.id, currency: microgrid.currency ?? "UGX" }, period, bills, fmt: req.fmt }),
    };
  }

  if (!UUID_RE.test(billId)) return BILL_ATTEMPTS_REFUSALS.billNotFound;
  const billRes = await req.supabase
    .from("billing_line_items")
    .select(BILL_COLUMNS)
    .eq("id", billId)
    .eq("billing_period_id", period.id)
    .maybeSingle<BillRow>();
  if (billRes.error) return BILL_ATTEMPTS_REFUSALS.unavailable;
  if (!billRes.data) return BILL_ATTEMPTS_REFUSALS.billNotFound;
  const bill = billRes.data;

  const read = await readHistory(req, bill.id);
  if (!read.ok) return read.refusal === "notFound" ? BILL_ATTEMPTS_REFUSALS.billNotFound : BILL_ATTEMPTS_REFUSALS[read.refusal];

  return {
    ok: true,
    model: buildBillAttemptsModel({
      microgrid: { id: microgrid.id },
      period,
      bill: { id: bill.id, tenantName: tenantName(bill) },
      timezone: period.timezone ?? microgrid.timezone ?? "UTC",
      history: read.history,
      fmt: req.fmt,
    }),
  };
}

// ── The reconciliations' availability and confirmation steps ────────────────

/**
 * Whether each attempt can be resolved by `which` now (reconcileReason).
 * The attempts are read through the person's own client: payment_attempts
 * is FOR ALL on is_super_admin() or user_can_access_org(org_id)
 * (00065_payments_capability.sql), the policy the host's
 * resolveTargetOrganization('paymentAttempt') relies on too; an id it does
 * not show is not found. Then one composition, and one listHistory per
 * bill. A completed adjustment also reads each bill's tenant name, since
 * prepareRecordAdjustment and PaymentsCapability.reconcile refuse it for a
 * tenant with none (tenants.display_name has no CHECK against a blank
 * name; if one is added, this read can go). A read that fails throws, and
 * the host shows the action unchecked.
 */
export function reconcileAvailable(which: "record" | "accept") {
  return async (req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> => {
    const out: Record<string, true | string> = {};
    const valid = ids.filter((id) => UUID_RE.test(id));
    const { data, error } = valid.length
      ? await req.supabase.from("payment_attempts").select("id, line_item_id").in("id", valid)
      : { data: [], error: null };
    if (error) throw new Error("payments.bill-attempts: could not read the attempts");
    const seen = (data ?? []) as { id: string; line_item_id: string }[];
    const billOf = new Map(seen.map((a) => [a.id, a.line_item_id]));
    const bills = [...new Set(billOf.values())];
    const histories = new Map<string, BillHistory | null>();
    if (bills.length > 0) {
      const composed = await composePayments({ supabase: req.supabase, organizationId: req.organizationId, allowDisabled: true });
      if (!composed.ok) throw new Error("payments.bill-attempts: could not compose payments");
      try {
        for (const bill of bills) {
          const history = await composed.data.payments.listHistory(bill);
          histories.set(bill, history.ok ? narrowHistory(history.data) : null);
        }
      } finally {
        await composed.data.dispose();
      }
    }
    const names = new Map<string, string>();
    if (which === "record" && bills.length > 0) {
      const billRes = await req.supabase.from("billing_line_items").select("id, tenants(display_name)").in("id", bills);
      if (billRes.error) throw new Error("payments.bill-attempts: could not read the bills");
      for (const b of (billRes.data ?? []) as unknown as { id: string; tenants: Embedded<{ display_name: string | null }> }[]) names.set(b.id, tenantName(b));
    }
    for (const id of ids) {
      const bill = billOf.get(id);
      const history = bill === undefined ? undefined : histories.get(bill);
      if (bill === undefined) out[id] = ATTEMPT_REFUSALS.notFound.message;
      else if (!history) out[id] = ATTEMPT_REFUSALS.unavailable.message;
      else {
        const reason = reconcileReason(history, id, which);
        if (reason !== null) out[id] = reason;
        else if (which === "record" && !names.has(bill)) out[id] = ATTEMPT_REFUSALS.notFound.message;
        else if (which === "record" && names.get(bill) === "") out[id] = ATTEMPT_REFUSALS.noName.message;
        else out[id] = true;
      }
    }
    return out;
  };
}

type PrepareRead =
  | { ok: true; attempt: { id: string; amount: number; currency: string; merchant_reference: string }; tenant: string; history: BillHistory }
  | Refusal;

/** The attempt, its bill's tenant and the bill's history, for a confirmation step. */
async function readForPrepare(req: SurfaceRequest, attemptId: string | undefined): Promise<PrepareRead> {
  if (!attemptId || !UUID_RE.test(attemptId)) return ATTEMPT_REFUSALS.notFound;
  const attemptRes = await req.supabase
    .from("payment_attempts")
    .select("id, line_item_id, amount, currency, merchant_reference")
    .eq("id", attemptId)
    .maybeSingle<{ id: string; line_item_id: string; amount: number | string; currency: string; merchant_reference: string }>();
  if (attemptRes.error) return ATTEMPT_REFUSALS.unavailable;
  if (!attemptRes.data) return ATTEMPT_REFUSALS.notFound;
  const attempt = attemptRes.data;
  const billRes = await req.supabase
    .from("billing_line_items")
    .select("id, tenants(display_name)")
    .eq("id", attempt.line_item_id)
    .maybeSingle<{ id: string; tenants: Embedded<{ display_name: string | null }> }>();
  if (billRes.error) return ATTEMPT_REFUSALS.unavailable;
  if (!billRes.data) return ATTEMPT_REFUSALS.notFound;
  const read = await readHistory(req, attempt.line_item_id);
  if (!read.ok) return ATTEMPT_REFUSALS[read.refusal];
  return {
    ok: true,
    attempt: { id: attempt.id, amount: Number(attempt.amount), currency: attempt.currency, merchant_reference: attempt.merchant_reference },
    tenant: tenantName(billRes.data),
    history: read.history,
  };
}

const refuse = (message: string): Refusal => ({ ok: false, status: 409, message });

/** The balance facts both steps show. */
function balanceFacts(req: SurfaceRequest, h: BillHistory): Ceremony["facts"] {
  return [
    { label: "Current bill", value: req.fmt.money(h.currentTotal, h.currency) },
    { label: "Received", value: req.fmt.money(h.received, h.currency) },
    { label: "Difference", value: req.fmt.money(h.difference, h.currency) },
  ];
}

/**
 * Record completed adjustment: typed, the tenant's name, which the
 * capability checks again (PaymentsCapability.reconcile, 428). The warning
 * names the amount that settles the bill, the current bill less what was
 * received, which is what fn_payment_reconcile requires the amount to be.
 */
export async function prepareRecordAdjustment(req: SurfaceRequest, input: { params: Record<string, string> }): Promise<Loaded<Ceremony>> {
  const read = await readForPrepare(req, input.params.id);
  if (!read.ok) return read;
  const reason = reconcileReason(read.history, read.attempt.id, "record");
  if (reason !== null) return refuse(reason);
  if (read.tenant === "") return ATTEMPT_REFUSALS.noName;
  const { history: h, attempt } = read;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Record a collection or refund completed outside MGM for ${read.tenant}'s bill, which is then marked paid. MGM moves no money here.`,
      facts: [
        ...balanceFacts(req, h),
        { label: "This attempt", value: req.fmt.money(attempt.amount, attempt.currency) },
        { label: "Reference", value: req.fmt.text(attempt.merchant_reference) },
      ],
      warnings: [
        `Enter ${req.fmt.money(h.currentTotal - h.received, h.currency).text} as the external amount (negative for a refund): the received total must come to exactly the current bill.`,
      ],
      acknowledgements: [],
      typed: read.tenant,
    },
  };
}

/** Accept exact receipts: a confirmation with the balance, which must be exact (available() says so first). */
export async function prepareAcceptReceipts(req: SurfaceRequest, input: { params: Record<string, string> }): Promise<Loaded<Ceremony>> {
  const read = await readForPrepare(req, input.params.id);
  if (!read.ok) return read;
  const reason = reconcileReason(read.history, read.attempt.id, "accept");
  if (reason !== null) return refuse(reason);
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: `Accept the verified receipts as settling ${read.tenant || "this tenant"}'s bill, which is then marked paid.`,
      facts: balanceFacts(req, read.history),
      warnings: [],
      acknowledgements: [],
    },
  };
}
