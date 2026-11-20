import "server-only";

/**
 * The loader of the `billing.not-billed` view, a section of the period
 * review listing the tenants with no bill for the period, and the
 * availability and prepare steps of `billing.bill-from-readings`, which it
 * offers on each of them.
 *
 * Everything here reads through the person's own client (row-level
 * security) and composes no capability, as the period review reads
 * (./period-review.ts): billing_periods and billing_line_items, and tenants
 * with their primary meter links (community management's and metering's
 * tables) for each tenant's name and meter coverage; if their policies
 * change, revisit what this shows. The view loads while billing is off, and
 * the host shows the gate's notice with every action disabled. The route
 * (src/app/api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings/route.ts)
 * is the authority on the write; availability and prepare only explain a
 * refusal before it happens.
 *
 * A refusal carries fixed copy, never a database message.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { meterCoverage, type MeterCoverage, type PrimaryMeterLink } from "../meter-coverage";
import { BILL_FROM_READINGS_COPY } from "../schemas";
import { pageAfter, readAllPages, readAllPagesInOrder } from "./pages";
import { PERIOD_REVIEW_REFUSALS } from "./period-review";
import { PERIOD_REVIEW_MAX_ROWS, periodLabel } from "./period-review-model";
import { buildNotBilledModel } from "./not-billed-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

/**
 * The section's refusals: the review's for a period it cannot read, and its
 * own when there are more tenants than a view lists. Never cut short: a
 * tenant left off would look billed.
 */
export const NOT_BILLED_REFUSALS = {
  notFound: PERIOD_REVIEW_REFUSALS.notFound,
  unavailable: PERIOD_REVIEW_REFUSALS.unavailable,
  tooLarge: { ok: false, status: 500, message: "This period has more tenants not billed than this view can show." },
} as const satisfies Record<string, Refusal>;

/**
 * billing.bill-from-readings' refusals, in the route's order: the route's own
 * copy (BILL_FROM_READINGS_COPY), and the review's for a period it cannot
 * read.
 */
export const BILL_FROM_READINGS_REFUSALS = {
  notFound: PERIOD_REVIEW_REFUSALS.notFound,
  unavailable: PERIOD_REVIEW_REFUSALS.unavailable,
  closed: { ok: false, status: 409, message: BILL_FROM_READINGS_COPY.closed },
  tenantNotFound: { ok: false, status: 404, message: BILL_FROM_READINGS_COPY.tenantNotFound },
  otherMicrogrid: { ok: false, status: 409, message: BILL_FROM_READINGS_COPY.otherMicrogrid },
  hasBill: { ok: false, status: 409, message: BILL_FROM_READINGS_COPY.hasBill },
} as const satisfies Record<string, Refusal>;

type TenantRow = { id: string; display_name: string; microgrid_id?: string; tenant_devices: PrimaryMeterLink[] | null };

/** Every tenant's primary meter links, as the bill engine reads them. */
const TENANT_COLUMNS =
  "id, display_name, tenant_devices(role, effective_from, effective_to, devices(openems_component_id, edges(openems_edge_id)))";

export async function loadNotBilled(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const microgridId = req.params.id;
  const { data: period, error } = await req.supabase
    .from("billing_periods")
    .select("id, start_date, end_date, status")
    .eq("id", req.params.periodId)
    .eq("microgrid_id", microgridId)
    .maybeSingle<{ id: string; start_date: string; end_date: string; status: "draft" | "closed" }>();
  if (error) return NOT_BILLED_REFUSALS.unavailable;
  if (!period) return NOT_BILLED_REFUSALS.notFound;

  const [bills, tenants] = await Promise.all([
    readAllPages<{ id: string; tenant_id: string }>((after) =>
      pageAfter(req.supabase.from("billing_line_items").select("id, tenant_id", { count: "exact" }).eq("billing_period_id", period.id), after),
    ),
    // In name order, as the review lists tenants; only listed, never summed.
    readAllPagesInOrder<TenantRow>((from, to) =>
      req.supabase
        .from("tenants")
        .select(TENANT_COLUMNS, { count: "exact" })
        .eq("microgrid_id", microgridId)
        .eq("tenant_devices.role", "primary_consumption_meter")
        .order("display_name")
        .order("id")
        .range(from, to),
    ),
  ]);
  if (bills === null || tenants === null) return NOT_BILLED_REFUSALS.unavailable;
  const billed = new Set(bills.map((b) => b.tenant_id));
  if (tenants.filter((t) => !billed.has(t.id)).length > PERIOD_REVIEW_MAX_ROWS) return NOT_BILLED_REFUSALS.tooLarge;

  return {
    ok: true,
    model: buildNotBilledModel({
      microgridId,
      period,
      tenants: tenants.map((t) => ({ id: t.id, display_name: t.display_name, primaryLinks: t.tenant_devices ?? [] })),
      billedTenantIds: billed,
      fmt: req.fmt,
    }),
  };
}

// ── Availability ────────────────────────────────────────────────────────────

/**
 * bill-from-readings: on a draft only, as its route refuses a closed period.
 * Asked by the period, the action's target; which tenants have no bill is
 * the loader's to decide (it offers the action on those only), and prepare
 * and the route check it again. Throws on a failed read, so the host shows
 * the action as not checked.
 */
export async function billFromReadingsAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const { data, error } = await req.supabase.from("billing_periods").select("id, status").in("id", ids);
  if (error) throw new Error("billing.bill-from-readings: availability not read");
  const status = new Map(((data ?? []) as { id: string; status: string }[]).map((p) => [p.id, p.status]));
  return Object.fromEntries(
    ids.map((id): [string, true | string] => {
      const s = status.get(id);
      if (s === undefined) return [id, BILL_FROM_READINGS_REFUSALS.notFound.message];
      return [id, s === "draft" ? true : BILL_FROM_READINGS_REFUSALS.closed.message];
    }),
  );
}

// ── Prepare ─────────────────────────────────────────────────────────────────

/** What the confirmation says of the tenant's meter for the period, by meterCoverage's answer. */
const METER_FACT = {
  no_meter: "No meter for this period",
  assignment_gap: "Meter assignment gap in this period",
  metered: "Assigned for the whole period",
} as const satisfies Record<MeterCoverage, string>;

export const BILL_FROM_READINGS_STATEMENT =
  "Bill this tenant for the period from the start and end readings you enter. Usage is the end reading less the start reading, priced with the period's tariff.";

export const BILL_FROM_READINGS_WARNINGS = {
  asEntered: "The readings are printed on the bill as entered. Check them against the meter.",
  // generate-from-meters keeps a manual bill (generate.ts, Q5), and
  // regenerate-bill offers Switch back to edge data on it; if either
  // changes, revisit.
  metered:
    "This tenant's meter is assigned for the whole period. A bill from readings entered by hand is kept when bills are generated from meter data; switch it back to edge data from the bill to read the meter instead.",
} as const;

/**
 * billing.bill-from-readings' confirmation: whose bill, which period and
 * what is known of the tenant's meter, with the route's refusals in the
 * route's order (a closed period, a tenant not found, a tenant of another
 * microgrid, a tenant with a bill). It runs once, before the form, so it
 * cannot show the readings or the total; the route answers with both in its
 * message. Reads only.
 */
export async function prepareBillFromReadings(
  req: SurfaceRequest,
  input: { params: Record<string, string>; body?: unknown },
): Promise<Loaded<Ceremony>> {
  const R = BILL_FROM_READINGS_REFUSALS;
  const { data: period, error: periodError } = await req.supabase
    .from("billing_periods")
    .select("id, microgrid_id, start_date, end_date, status")
    .eq("id", input.params.periodId)
    .maybeSingle<{ id: string; microgrid_id: string; start_date: string; end_date: string; status: string }>();
  if (periodError) return R.unavailable;
  if (!period) return R.notFound;
  if (period.status !== "draft") return R.closed;

  const { data: tenant, error: tenantError } = await req.supabase
    .from("tenants")
    .select(`${TENANT_COLUMNS}, microgrid_id`)
    .eq("id", input.params.tenantId)
    .eq("tenant_devices.role", "primary_consumption_meter")
    .maybeSingle<TenantRow>();
  if (tenantError) return R.unavailable;
  if (!tenant) return R.tenantNotFound;
  if (tenant.microgrid_id !== period.microgrid_id) return R.otherMicrogrid;

  const { data: bill, error: billError } = await req.supabase
    .from("billing_line_items")
    .select("id")
    .eq("billing_period_id", period.id)
    .eq("tenant_id", tenant.id)
    .maybeSingle<{ id: string }>();
  if (billError) return R.unavailable;
  if (bill) return R.hasBill;

  const coverage = meterCoverage(tenant.tenant_devices ?? [], period);
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: BILL_FROM_READINGS_STATEMENT,
      facts: [
        { label: "Tenant", value: req.fmt.text(tenant.display_name) },
        { label: "Period", value: req.fmt.text(periodLabel(req.fmt, period.start_date, period.end_date)) },
        { label: "Meter", value: req.fmt.text(METER_FACT[coverage]) },
      ],
      warnings: [BILL_FROM_READINGS_WARNINGS.asEntered, ...(coverage === "metered" ? [BILL_FROM_READINGS_WARNINGS.metered] : [])],
      acknowledgements: [],
    },
  };
}
