import "server-only";

/**
 * The loader of the `billing.period-history` view: one billing period's
 * audit log and payment events, newest first, a page at a time, optionally
 * for one tenant's bill.
 *
 * Everything here reads through the person's own client (row-level
 * security) and composes no capability, so the view loads while billing is
 * off, with the gate's notice. billing_audit_log's SELECT policy and
 * payment_events' FOR ALL policy both follow user_can_access_microgrid of
 * the period's microgrid; tenants (community management's table) are read
 * only for names, scoped to the period's microgrid, so no other
 * microgrid's tenant is ever named. If those policies change, revisit what
 * this shows. payment_events.raw_payload (a provider's notification, as
 * received) is never selected, and no `details` JSON reaches the model.
 *
 * It does its own paged reads rather than fetchAuditLogEntries
 * (../audit-log-fetch.ts), whose contract is the audit-log route's: 500 rows
 * a side, database text in its errors and raw_payload in its entries. It
 * normalizes the rows as that helper does (its step 5); if the
 * normalization changes in either place, revisit the other.
 *
 * A refusal carries fixed copy, never a database message.
 */
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";
import {
  buildPeriodHistoryModel,
  cursorQueries,
  HISTORY_CURSOR_PARAM,
  HISTORY_TENANT_PARAM,
  isUuid,
  mergePage,
  parseCursor,
  PERIOD_HISTORY_PAGE,
  type HistoryKeyed,
  type SideQuery,
} from "./period-history-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const PERIOD_HISTORY_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This billing period could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not load this period's history right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/** The audit log's columns, with the bill's live tenant name. Typed as a plain string: the rows are typed below. */
export const AUDIT_COLUMNS: string =
  "id, billing_line_item_id, event_type, actor_user_id, created_at, details, billing_line_items!billing_audit_log_billing_line_item_id_fkey(tenants(display_name))";
/** A payment event's columns, never raw_payload, with its bill's period (to filter on), notes and tenant name. */
export const PAYMENT_COLUMNS: string =
  "id, line_item_id, from_status, to_status, source, actor_user_id, at, billing_line_items!inner(billing_period_id, payment_notes, tenants(display_name))";

type Named = { display_name: string | null } | { display_name: string | null }[] | null;
type AuditRow = {
  id: string;
  billing_line_item_id: string | null;
  event_type: BillingAuditLogEntry["eventType"];
  actor_user_id: string | null;
  created_at: string;
  details: Record<string, unknown> | null;
  billing_line_items: { tenants: Named } | { tenants: Named }[] | null;
};
type PaymentRow = {
  id: string;
  line_item_id: string;
  from_status: string | null;
  to_status: string;
  source: string;
  actor_user_id: string | null;
  at: string;
  billing_line_items:
    | { billing_period_id: string; payment_notes: string | null; tenants: Named }
    | { billing_period_id: string; payment_notes: string | null; tenants: Named }[]
    | null;
};
type ActorRow = { user_id: string | null; first_name: string | null; last_name: string | null; email: string | null };

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const nameOf = (v: Named): string | null => one(v)?.display_name ?? null;

/** First and last name, then email, then nothing: as the legacy page names an actor. */
function actorName(row: ActorRow | undefined): string | null {
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ").trim();
  return name || row.email || null;
}

type Filterable<Q> = {
  eq(column: string, value: string): Q;
  lt(column: string, value: string): Q;
  lte(column: string, value: string): Q;
  order(column: string, o: { ascending: boolean }): Q;
  limit(n: number): Q;
};

/** One read of a source after the page's cursor, newest first, at most a page and one. */
function applySide<Q extends Filterable<Q>>(query: Q, at: string, q: SideQuery): Q {
  const filtered =
    q.kind === "all" ? query : q.kind === "tie" ? query.eq(at, q.at).lt("id", q.beforeId) : q.kind === "lt" ? query.lt(at, q.at) : query.lte(at, q.at);
  return filtered.order(at, { ascending: false }).order("id", { ascending: false }).limit(PERIOD_HISTORY_PAGE + 1);
}

/** Every read of a source, concatenated in order, or null when one fails. */
async function readSide<T>(queries: SideQuery[], read: (q: SideQuery) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[] | null> {
  const results = await Promise.all(queries.map(read));
  if (results.some((r) => r.error)) return null;
  return results.flatMap((r) => (r.data ?? []) as T[]);
}

export async function loadPeriodHistory(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const microgridId = req.params.id;
  const [periodRes, microgridRes] = await Promise.all([
    req.supabase
      .from("billing_periods")
      .select("id, microgrid_id, start_date, end_date, timezone")
      .eq("id", req.params.periodId)
      .eq("microgrid_id", microgridId)
      .maybeSingle<{ id: string; microgrid_id: string; start_date: string; end_date: string; timezone: string }>(),
    req.supabase.from("microgrids").select("id, currency").eq("id", microgridId).maybeSingle<{ id: string; currency: string }>(),
  ]);
  if (periodRes.error || microgridRes.error) return PERIOD_HISTORY_REFUSALS.unavailable;
  const period = periodRes.data;
  const microgrid = microgridRes.data;
  if (!period || !microgrid) return PERIOD_HISTORY_REFUSALS.notFound;
  // History needs no tariff, so a period with none still loads (unlike the review).
  // billing_periods.timezone and microgrids.currency are NOT NULL (00055,
  // 00001), so neither has a fallback: if either becomes nullable, type it so
  // above and give it one.

  // The tenant filter. A value that is not a UUID is never sent to the
  // database (it would fail as invalid input, not as no rows) and never echoed.
  const rawTenant = req.search.get(HISTORY_TENANT_PARAM);
  let filter: { tenantId: string | null; tenantName: string | null; canMatch: boolean } | null = null;
  let lineItemId: string | null = null;
  if (rawTenant) {
    if (!isUuid(rawTenant)) {
      filter = { tenantId: null, tenantName: null, canMatch: false };
    } else {
      const tenantId = rawTenant.toLowerCase();
      const [tenantRes, billRes] = await Promise.all([
        // Only a tenant of this period's microgrid is named.
        req.supabase
          .from("tenants")
          .select("id, display_name")
          .eq("id", tenantId)
          .eq("microgrid_id", period.microgrid_id)
          .maybeSingle<{ id: string; display_name: string | null }>(),
        // At most one: a tenant has one bill a period (the unique index
        // idx_billing_line_items_period_tenant, 00029, renamed by
        // 20261116230000). If that index stops being unique, maybeSingle
        // errors on a second bill and this view refuses every history
        // filtered to that tenant: read every bill here and filter on all.
        req.supabase.from("billing_line_items").select("id").eq("billing_period_id", period.id).eq("tenant_id", tenantId).maybeSingle<{ id: string }>(),
      ]);
      if (tenantRes.error || billRes.error) return PERIOD_HISTORY_REFUSALS.unavailable;
      lineItemId = tenantRes.data && billRes.data ? billRes.data.id : null;
      // Entries are read only for that bill (below), so with none no page has any.
      filter = { tenantId, tenantName: tenantRes.data?.display_name ?? null, canMatch: lineItemId !== null };
    }
  }

  const before = req.search.get(HISTORY_CURSOR_PARAM);
  const cursor = parseCursor(before);
  type Keyed<R> = HistoryKeyed & { row: R };
  let audit: Keyed<AuditRow>[] = [];
  let payments: Keyed<PaymentRow>[] = [];
  // A filter with no bill of this period's microgrid has nothing to show.
  if (!filter || lineItemId) {
    const plan = cursorQueries(cursor);
    const [auditRows, paymentRows] = await Promise.all([
      readSide<AuditRow>(plan.audit, (q) => {
        const base = req.supabase.from("billing_audit_log").select(AUDIT_COLUMNS).eq("billing_period_id", period.id);
        return applySide(lineItemId ? base.eq("billing_line_item_id", lineItemId) : base, "created_at", q);
      }),
      readSide<PaymentRow>(plan.payment, (q) => {
        const base = req.supabase.from("payment_events").select(PAYMENT_COLUMNS).eq("billing_line_items.billing_period_id", period.id);
        return applySide(lineItemId ? base.eq("line_item_id", lineItemId) : base, "at", q);
      }),
    ]);
    if (auditRows === null || paymentRows === null) return PERIOD_HISTORY_REFUSALS.unavailable;
    audit = auditRows.map((row) => ({ source: "a", id: row.id, at: row.created_at, row }));
    payments = paymentRows.map((row) => ({ source: "p", id: row.id, at: row.at, row }));
  }
  const page = mergePage<Keyed<AuditRow> | Keyed<PaymentRow>>(audit, payments);

  // The names of this page's actors only, through the function the legacy
  // page asks (a POST, so the ids stay out of a URL). A failure refuses the
  // page rather than calling every actor "Restricted".
  const actorIds = [...new Set(page.entries.map((e) => e.row.actor_user_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  const actors = new Map<string, ActorRow>();
  if (actorIds.length > 0) {
    const { data, error } = await req.supabase.rpc("fn_list_visible_users", { _target_user_ids: actorIds });
    if (error) return PERIOD_HISTORY_REFUSALS.unavailable;
    for (const row of (data ?? []) as ActorRow[]) if (row.user_id && !actors.has(row.user_id)) actors.set(row.user_id, row);
  }
  const actorOf = (id: string | null) => ({ actorUserId: id, actorDisplayName: id ? actorName(actors.get(id)) : null });

  // As fetchAuditLogEntries normalizes them (../audit-log-fetch.ts, step 5), without raw_payload.
  const entries: BillingAuditLogEntry[] = page.entries.map((e): BillingAuditLogEntry => {
    if (e.source === "a") {
      const a = e.row as AuditRow;
      const details = a.details && typeof a.details === "object" && !Array.isArray(a.details) ? a.details : {};
      // Rows written before the households → tenants rename keep `household_name`.
      const snapshot = details["tenant_name"] ?? details["household_name"];
      const live = a.billing_line_item_id ? nameOf(one(a.billing_line_items)?.tenants ?? null) : null;
      return {
        id: `audit:${a.id}`,
        eventType: a.event_type,
        ...actorOf(a.actor_user_id),
        createdAt: a.created_at,
        billingLineItemId: a.billing_line_item_id,
        tenantName: live ?? (typeof snapshot === "string" ? snapshot : null),
        details,
      };
    }
    const p = e.row as PaymentRow;
    const bill = one(p.billing_line_items);
    const details: Record<string, unknown> = { from: p.from_status, to: p.to_status, source: p.source };
    if (bill?.payment_notes) details["notes"] = bill.payment_notes;
    return {
      id: `payment_event:${p.id}`,
      // A generated link (a regenerated one too, where from equals to) is not a status change.
      eventType: p.source === "generate_link" ? "payment_link_generated" : "payment_status_changed",
      ...actorOf(p.actor_user_id),
      createdAt: p.at,
      billingLineItemId: p.line_item_id,
      tenantName: nameOf(bill?.tenants ?? null),
      details,
    };
  });

  return {
    ok: true,
    model: buildPeriodHistoryModel({
      microgrid: { id: microgrid.id, currency: microgrid.currency },
      period: { id: period.id, start_date: period.start_date, end_date: period.end_date, timezone: period.timezone },
      entries,
      filter,
      // Only a cursor that parses is this page's; anything else read the first page.
      before: cursor ? before : null,
      next: page.next,
      fmt: req.fmt,
    }),
  };
}
