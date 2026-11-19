import "server-only";

/**
 * The loader of the `billing.period-review` view, and the availability and
 * prepare steps of the actions it offers on the period and on each bill.
 *
 * Everything here reads through the person's own client (row-level
 * security) and composes no capability, as the legacy period page reads:
 * billing_periods, billing_line_items and rate_schedules are FOR ALL on
 * user_can_access_microgrid. It also reads tenants, tenant_devices, devices
 * and edges (community management's and metering's tables) for each
 * tenant's name, edge availability and meter assignment, as the legacy page
 * and the usage route do; if their policies change, revisit what this shows
 * and when a usage correction is offered. The view loads while billing is
 * off, and the host shows the gate's notice with every action disabled.
 * The routes are the authority on every write; availability and prepare
 * only explain a refusal before it happens.
 *
 * A refusal carries fixed copy, never a database message.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { ALLOWED_MANUAL_TRANSITIONS, type PaymentStatus } from "@/lib/payments/state";
import { pageAfter, readAllPages, readAllPagesInOrder } from "./pages";
import {
  buildPeriodReviewModel,
  periodLabel,
  SUPER_ADMIN_ONLY_STATUSES,
  type ReviewBill,
  type ReviewTenant,
} from "./period-review-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

/** Rows past the host's row cap (MODEL_CAPS.rows in src/lib/gui/host/server/parse.ts) are refused, never cut. */
const MAX_ROWS = 500;
/** 10 fixed columns and 2 per tier must stay within the host's 50 (MODEL_CAPS.columns). */
const MAX_TIERS = 20;

export const PERIOD_REVIEW_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This billing period could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not load this billing period right now. Try again shortly." },
  // The legacy page's copy (src/app/(gui)/microgrids/[id]/billing/[periodId]/page.tsx).
  noTariff: {
    ok: false,
    status: 409,
    message:
      "This period has no pinned tariff. For an older billed period, an administrator must verify and reconcile its historical tariff before invoices or corrections can be shown.",
  },
  tooLarge: { ok: false, status: 500, message: "This period has more bills or tariff tiers than this view can show." },
} as const satisfies Record<string, Refusal>;

export const BILL_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This bill could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not check this bill right now. Try again shortly." },
  refunded: { ok: false, status: 409, message: "A refunded bill cannot be regenerated." },
  // The payment-status route's copy (src/app/api/billing-line-items/[lineItemId]/payment-status/route.ts).
  superAdmin: {
    ok: false,
    status: 403,
    message: "Only super admins can mark a bill as failed or refunded — this is a reconciliation action.",
  },
  noOp: { ok: false, status: 409, message: "Bill is already in that state." },
  transition: { ok: false, status: 409, message: "That status change is not allowed for manual edits." },
} as const satisfies Record<string, Refusal>;

/** generate-bills' reason on a closed period. */
export const GENERATE_CLOSED_REASON = "Bills on a closed period are regenerated one bill at a time.";

/**
 * record-usage's reasons: the usage route's own copy
 * (src/app/api/billing-line-items/[lineItemId]/usage/route.ts).
 */
export const USAGE_REASONS = {
  closed: "Cannot edit a closed period",
  metered: "Use Refresh Readings for metered tenants",
  noStart: "A starting register reading is required before correcting this bill.",
} as const;

type PrimaryLink = {
  effective_from: string;
  effective_to: string | null;
  devices: { openems_component_id: string | null; edges: { openems_edge_id: string | null } | null } | null;
};
type TenantRow = { id: string; display_name: string; tenant_devices: PrimaryLink[] | null };
type BillRow = Omit<ReviewBill, "entered_by" | "start_kwh" | "end_kwh" | "usage_kwh" | "total_amount"> & {
  start_kwh: number | string | null;
  end_kwh: number | string | null;
  usage_kwh: number | string | null;
  total_amount: number | string;
  entered_by_user_id: string | null;
};
type ActorRow = { user_id: string | null; first_name: string | null; last_name: string | null; email: string | null };

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const numOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

/** A primary meter assignment that overlaps the period, as the usage route tests it. */
const overlaps = (link: { effective_from: string; effective_to: string | null }, start: string, end: string) =>
  link.effective_from <= end && (link.effective_to === null || link.effective_to > start);

/** First and last name, then email, then nothing: as the legacy page names an actor. */
function actorName(row: ActorRow | undefined): string | null {
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ").trim();
  return name || row.email || null;
}

export async function loadPeriodReview(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const microgridId = req.params.id;
  const [periodRes, microgridRes] = await Promise.all([
    req.supabase
      .from("billing_periods")
      .select("id, microgrid_id, start_date, end_date, status, timezone, rate_schedule_id")
      .eq("id", req.params.periodId)
      .eq("microgrid_id", microgridId)
      .maybeSingle<{
        id: string;
        microgrid_id: string;
        start_date: string;
        end_date: string;
        status: "draft" | "closed";
        timezone: string | null;
        rate_schedule_id: string | null;
      }>(),
    req.supabase
      .from("microgrids")
      .select("id, name, currency")
      .eq("id", microgridId)
      .maybeSingle<{ id: string; name: string; currency: string | null }>(),
  ]);
  if (periodRes.error || microgridRes.error) return PERIOD_REVIEW_REFUSALS.unavailable;
  const period = periodRes.data;
  const microgrid = microgridRes.data;
  if (!period || !microgrid) return PERIOD_REVIEW_REFUSALS.notFound;
  // Amounts must be explained by the period's own tariff, never the microgrid's latest.
  if (!period.rate_schedule_id) return PERIOD_REVIEW_REFUSALS.noTariff;

  const [scheduleRes, bills, tenants] = await Promise.all([
    req.supabase
      .from("rate_schedules")
      .select("id, tiers")
      .eq("id", period.rate_schedule_id)
      .eq("microgrid_id", microgrid.id)
      .maybeSingle<{ id: string; tiers: { label: string }[] | null }>(),
    readAllPages<BillRow>((after) =>
      pageAfter(
        req.supabase
          .from("billing_line_items")
          .select(
            "id, tenant_id, device_id, start_kwh, end_kwh, usage_kwh, tier_breakdown, total_amount, reading_source, payment_status, invoice_number, entered_at, entered_by_user_id",
            { count: "exact" },
          )
          .eq("billing_period_id", period.id),
        after,
      ),
    ),
    // In name order, as the legacy table lists tenants; only listed, never summed.
    readAllPagesInOrder<TenantRow>((from, to) =>
      req.supabase
        .from("tenants")
        .select("id, display_name, tenant_devices(role, effective_from, effective_to, devices(openems_component_id, edges(openems_edge_id)))", {
          count: "exact",
        })
        .eq("microgrid_id", microgrid.id)
        .eq("tenant_devices.role", "primary_consumption_meter")
        .order("display_name")
        .order("id")
        .range(from, to),
    ),
  ]);
  if (scheduleRes.error || bills === null || tenants === null) return PERIOD_REVIEW_REFUSALS.unavailable;
  if (!scheduleRes.data) return PERIOD_REVIEW_REFUSALS.noTariff;
  const tiers = (Array.isArray(scheduleRes.data.tiers) ? scheduleRes.data.tiers : []).map((t) => ({ label: String(t?.label ?? "") }));
  if (tiers.length > MAX_TIERS) return PERIOD_REVIEW_REFUSALS.tooLarge;
  const billed = new Set(bills.map((b) => b.tenant_id));
  if (tenants.filter((t) => billed.has(t.id)).length > MAX_ROWS) return PERIOD_REVIEW_REFUSALS.tooLarge;

  const reviewTenants: ReviewTenant[] = tenants.map((t) => {
    const links = t.tenant_devices ?? [];
    // As the legacy page decides it: the first primary assignment's meter and edge carry OpenEMS ids.
    const device = one(links[0]?.devices);
    const edge = one(device?.edges);
    return {
      id: t.id,
      display_name: t.display_name,
      edgeAvailable: device !== null && device.openems_component_id !== null && edge !== null && edge.openems_edge_id !== null,
      meterLinkInPeriod: links.some((l) => overlaps(l, period.start_date, period.end_date)),
    };
  });

  // Who entered each manual reading, through the same function the legacy
  // page asks. A failed or partial answer leaves those names out ("a user").
  const actorIds = [...new Set(bills.map((b) => b.entered_by_user_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  const actors = new Map<string, ActorRow>();
  if (actorIds.length > 0) {
    const { data, error } = await req.supabase.rpc("fn_list_visible_users", { _target_user_ids: actorIds });
    if (!error) for (const row of (data ?? []) as ActorRow[]) if (row.user_id && !actors.has(row.user_id)) actors.set(row.user_id, row);
  }

  const reviewBills: ReviewBill[] = bills.map((b) => ({
    id: b.id,
    tenant_id: b.tenant_id,
    device_id: b.device_id,
    // NUMERIC columns, as numbers: a prefill must parse as one.
    start_kwh: numOrNull(b.start_kwh),
    end_kwh: numOrNull(b.end_kwh),
    usage_kwh: numOrNull(b.usage_kwh),
    tier_breakdown: Array.isArray(b.tier_breakdown) ? b.tier_breakdown : null,
    total_amount: Number(b.total_amount ?? 0),
    reading_source: b.reading_source,
    payment_status: b.payment_status,
    invoice_number: b.invoice_number,
    entered_at: b.entered_at,
    entered_by: b.entered_by_user_id ? actorName(actors.get(b.entered_by_user_id)) : null,
  }));

  return {
    ok: true,
    model: buildPeriodReviewModel({
      microgrid: { id: microgrid.id, name: microgrid.name, currency: microgrid.currency ?? "UGX" },
      period: { id: period.id, start_date: period.start_date, end_date: period.end_date, status: period.status, timezone: period.timezone },
      tiers,
      tenants: reviewTenants,
      bills: reviewBills,
      superAdmin: rolesIncludeSuperAdmin(req.roles),
      fmt: req.fmt,
    }),
  };
}

// ── Availability ────────────────────────────────────────────────────────────
// One read each (two for record-usage), as the budget is shared by every
// action on the view. Each throws on a failed read, so the host shows the
// action as not checked.

/** generate-bills: on a draft only. */
export async function generateBillsAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const { data, error } = await req.supabase.from("billing_periods").select("id, status").in("id", ids);
  if (error) throw new Error("billing.generate-bills: availability not read");
  const status = new Map(((data ?? []) as { id: string; status: string }[]).map((p) => [p.id, p.status]));
  return Object.fromEntries(
    ids.map((id): [string, true | string] => {
      const s = status.get(id);
      if (s === undefined) return [id, PERIOD_REVIEW_REFUSALS.notFound.message];
      return [id, s === "closed" ? GENERATE_CLOSED_REASON : true];
    }),
  );
}

/** regenerate-bill: any bill but a refunded one. */
export async function regenerateBillAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const { data, error } = await req.supabase.from("billing_line_items").select("id, payment_status").in("id", ids);
  if (error) throw new Error("billing.regenerate-bill: availability not read");
  const status = new Map(((data ?? []) as { id: string; payment_status: string }[]).map((b) => [b.id, b.payment_status]));
  return Object.fromEntries(
    ids.map((id): [string, true | string] => {
      const s = status.get(id);
      if (s === undefined) return [id, BILL_REFUSALS.notFound.message];
      return [id, s === "refunded" ? BILL_REFUSALS.refunded.message : true];
    }),
  );
}

/**
 * record-usage: where the usage route accepts a correction. These mirror
 * its checks, in its order (src/app/api/billing-line-items/[lineItemId]/usage/route.ts);
 * if the route's checks change, revisit.
 */
export async function recordUsageAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const { data, error } = await req.supabase
    .from("billing_line_items")
    .select("id, tenant_id, device_id, start_kwh, billing_periods(status, start_date, end_date)")
    .in("id", ids);
  if (error) throw new Error("billing.record-usage: availability not read");
  type Row = {
    id: string;
    tenant_id: string;
    device_id: string | null;
    start_kwh: number | string | null;
    billing_periods: { status: string; start_date: string; end_date: string } | { status: string; start_date: string; end_date: string }[] | null;
  };
  const items = (data ?? []) as Row[];
  const tenantIds = [...new Set(items.map((b) => b.tenant_id))];
  const linksByTenant = new Map<string, { effective_from: string; effective_to: string | null }[]>();
  if (tenantIds.length > 0) {
    const links = await req.supabase
      .from("tenant_devices")
      .select("tenant_id, effective_from, effective_to")
      .in("tenant_id", tenantIds)
      .eq("role", "primary_consumption_meter");
    if (links.error) throw new Error("billing.record-usage: availability not read");
    for (const l of (links.data ?? []) as { tenant_id: string; effective_from: string; effective_to: string | null }[]) {
      linksByTenant.set(l.tenant_id, [...(linksByTenant.get(l.tenant_id) ?? []), l]);
    }
  }
  const byId = new Map(items.map((b) => [b.id, b]));
  return Object.fromEntries(
    ids.map((id): [string, true | string] => {
      const bill = byId.get(id);
      const period = one(bill?.billing_periods);
      if (!bill || !period) return [id, BILL_REFUSALS.notFound.message];
      if (period.status === "closed") return [id, USAGE_REASONS.closed];
      const metered =
        bill.device_id !== null || (linksByTenant.get(bill.tenant_id) ?? []).some((l) => overlaps(l, period.start_date, period.end_date));
      if (metered) return [id, USAGE_REASONS.metered];
      if (bill.start_kwh === null) return [id, USAGE_REASONS.noStart];
      return [id, true];
    }),
  );
}

// ── Prepare ─────────────────────────────────────────────────────────────────
// Each only reads, and refuses with fixed copy.

type BillForPrepare = {
  id: string;
  total_amount: number | string;
  payment_status: PaymentStatus;
  tenants: { display_name: string } | { display_name: string }[] | null;
  billing_periods:
    | { start_date: string; end_date: string; status?: string; microgrids: { currency: string | null } | { currency: string | null }[] | null }
    | { start_date: string; end_date: string; status?: string; microgrids: { currency: string | null } | { currency: string | null }[] | null }[]
    | null;
};

/** The bill's tenant, period and currency, or a refusal. */
async function readBill(req: SurfaceRequest, lineItemId: string, columns: string) {
  const { data, error } = await req.supabase.from("billing_line_items").select(columns).eq("id", lineItemId).maybeSingle<BillForPrepare>();
  if (error) return BILL_REFUSALS.unavailable;
  const period = one(data?.billing_periods);
  if (!data || !period) return BILL_REFUSALS.notFound;
  const currency = one(period.microgrids)?.currency ?? "UGX";
  const tenant = one(data.tenants)?.display_name ?? "";
  const facts = [
    { label: "Tenant", value: req.fmt.text(tenant) },
    { label: "Period", value: req.fmt.text(periodLabel(req.fmt, period.start_date, period.end_date)) },
  ];
  return { ok: true as const, bill: data, period, currency, facts, tenant };
}

/**
 * billing.regenerate-bill's confirmation: whose bill, its current total and
 * payment status, and the legacy dialog's warnings for a paid or refunded
 * bill and a closed period. It shows no new total: the read-only preview
 * re-pins a draft period's tariff, which a prepare must not do.
 */
export async function prepareRegenerateBill(
  req: SurfaceRequest,
  input: { params: Record<string, string>; body?: unknown },
): Promise<Loaded<Ceremony>> {
  const read = await readBill(
    req,
    input.params.lineItemId,
    "id, total_amount, payment_status, tenants(display_name), billing_periods(start_date, end_date, status, microgrids(currency))",
  );
  if (!read.ok) return read;
  const { bill, period, currency, facts } = read;
  if (bill.payment_status === "refunded") return BILL_REFUSALS.refunded;
  const warnings: string[] = [];
  if (bill.payment_status === "paid") {
    // The legacy dialog's copy (src/components/billing/regenerate-row-dialog.tsx).
    warnings.push(
      `The bill is currently marked ${bill.payment_status}. Regenerating will recalculate the readings and totals; the payment record (paid_at, paid_by_user_id, payment_notes, pesapal_order_id, payment_events history) is preserved.`,
    );
  }
  if (period.status === "closed") warnings.push("Regenerating writes an audit-log revision; the period stays closed.");
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: "Regenerate this bill from meter data or the readings you enter.",
      facts: [
        ...facts,
        { label: "Current total", value: req.fmt.money(Number(bill.total_amount), currency) },
        { label: "Payment", value: req.fmt.status("billingLineItemPaymentStatus", bill.payment_status) },
      ],
      warnings,
      acknowledgements: [],
    },
  };
}

/**
 * What a payment-status action's confirmation says. It does not name the new
 * status: the five actions share LineItemPaymentStatusBody, whose status the
 * form lets a person change after the host has prepared the action (prepare
 * runs once, with the loader's prefill), so a step that named the prefilled
 * status could confirm a different one. It shows the current status instead,
 * next to the form where the new one is chosen; the route enforces which
 * changes are allowed, who may make them, and that a refund carries the
 * tenant's name typed (only Mark as refunded's typed step sends it). If the
 * host comes to lock a prefilled field, or each status gets its own route,
 * name it here.
 */
const PAYMENT_STATEMENT = "Change this bill's payment status to the one chosen in the form.";

/**
 * The prepare of a payment-status action that sets `to` on a bill in one of
 * `from`. It re-checks the current status and the role, since the view's
 * offer can be up to one refresh old; the route stays the authority.
 */
export function preparePaymentStatus(
  to: PaymentStatus,
  from: readonly PaymentStatus[],
  o: { cancel?: true; typed?: true } = {},
) {
  return async (req: SurfaceRequest, input: { params: Record<string, string>; body?: unknown }): Promise<Loaded<Ceremony>> => {
    const read = await readBill(
      req,
      input.params.lineItemId,
      "id, payment_status, total_amount, tenants(display_name), billing_periods(start_date, end_date, microgrids(currency))",
    );
    if (!read.ok) return read;
    const { bill, currency, facts, tenant } = read;
    // A typed step asks for the tenant's name; a bill with no readable name cannot be confirmed that way.
    if (o.typed && tenant === "") return BILL_REFUSALS.transition;
    if (SUPER_ADMIN_ONLY_STATUSES.includes(to) && !rolesIncludeSuperAdmin(req.roles)) return BILL_REFUSALS.superAdmin;
    if (bill.payment_status === to) return BILL_REFUSALS.noOp;
    const allowed = ALLOWED_MANUAL_TRANSITIONS.some((t) => t.from === bill.payment_status && t.to === to);
    if (!from.includes(bill.payment_status) || !allowed) return BILL_REFUSALS.transition;
    return {
      ok: true,
      model: {
        type: "ceremony",
        statement: PAYMENT_STATEMENT,
        facts: [
          ...facts,
          { label: "Total", value: req.fmt.money(Number(bill.total_amount), currency) },
          { label: "Status now", value: req.fmt.status("billingLineItemPaymentStatus", bill.payment_status) },
        ],
        // The legacy dialog's copy (src/components/billing/row-actions-menu.tsx):
        // any change away from a pending link stops that link working.
        warnings: o.cancel
          ? ["The pending payment link stops working; they'll need a new link to pay."]
          : o.typed
            ? ["A refund is final: no change leads out of refunded."]
            : [],
        acknowledgements: [],
        ...(o.typed ? { typed: tenant } : {}),
      },
    };
  };
}

export const prepareMarkPaid = preparePaymentStatus("paid", ["unpaid", "failed", "link_generated"]);
export const prepareMarkUnpaid = preparePaymentStatus("unpaid", ["paid"]);
// Typed (review on #205): a refund is final, so the person types the tenant's name.
export const prepareMarkRefunded = preparePaymentStatus("refunded", ["paid"], { typed: true });
export const prepareMarkFailed = preparePaymentStatus("failed", ["link_generated"]);
export const prepareCancelPaymentLink = preparePaymentStatus("unpaid", ["link_generated"], { cancel: true });
