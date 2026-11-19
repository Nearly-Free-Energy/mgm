import "server-only";

/**
 * The loader of the `billing.periods` view, and the prepare and availability
 * steps of `billing.delete-period`.
 *
 * Everything here reads through the person's own client (row-level
 * security) and composes no capability: billing_periods and
 * billing_line_items are FOR ALL on user_can_access_microgrid, as the legacy
 * billing page reads them. If their policies change, revisit what this
 * shows. The list loads while billing is off, and the host shows the gate's
 * notice with create disabled. The delete route is the authority on every
 * write; prepare and availability only explain a refusal before it happens.
 *
 * A refusal carries fixed copy, never a database message.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { periodName } from "../close";
import {
  DELETE_DRAFT_PERIOD_DESCRIPTION,
  lineItemHasRecordedPayment,
  PERIOD_KEPT_CLOSED_MESSAGE,
  PERIOD_KEPT_PAYMENTS_MESSAGE,
} from "../period-delete";
import { buildPeriodsModel, type PeriodRowInput } from "./periods-model";
import { pageAfter, readAllPages, sumMoney } from "./pages";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const PERIODS_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This microgrid could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not load the billing periods right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

export const DELETE_PERIOD_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This billing period could not be found." },
  closed: { ok: false, status: 409, message: PERIOD_KEPT_CLOSED_MESSAGE },
  payments: { ok: false, status: 409, message: PERIOD_KEPT_PAYMENTS_MESSAGE },
  failed: { ok: false, status: 500, message: "Could not prepare the delete." },
  unavailable: { ok: false, status: 503, message: "Could not check the billing period right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/**
 * At most this many periods, newest first: the host's row cap
 * (MODEL_CAPS.rows in src/lib/gui/host/server/parse.ts). A microgrid with
 * more would lose its oldest; if that happens, page with `next` instead.
 */
const MAX_PERIODS = 500;

export async function loadPeriods(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const { data: microgrid, error } = await req.supabase
    .from("microgrids")
    .select("id, currency")
    .eq("id", req.params.id)
    .maybeSingle<{ id: string; currency: string | null }>();
  if (error) return PERIODS_REFUSALS.unavailable;
  if (!microgrid) return PERIODS_REFUSALS.notFound;

  const periodsRes = await req.supabase
    .from("billing_periods")
    .select("id, start_date, end_date, status")
    .eq("microgrid_id", microgrid.id)
    .order("start_date", { ascending: false })
    .limit(MAX_PERIODS);
  if (periodsRes.error) return PERIODS_REFUSALS.unavailable;
  const rows = (periodsRes.data ?? []) as { id: string; start_date: string; end_date: string; status: "draft" | "closed" }[];

  const currency = microgrid.currency ?? "UGX";
  const totals = new Map<string, { kwh: number; amount: number }>();
  if (rows.length > 0) {
    // By the microgrid through the period, not by a list of period ids, which
    // would make a URL as long as 500 ids.
    const items = await readAllPages<{ id: string; billing_period_id: string; usage_kwh: unknown; total_amount: unknown }>((after) =>
      pageAfter(
        req.supabase
          .from("billing_line_items")
          .select("id, billing_period_id, usage_kwh, total_amount, billing_periods!inner(microgrid_id)", { count: "exact" })
          .eq("billing_periods.microgrid_id", microgrid.id),
        after,
      ),
    );
    // Unlike the legacy page, which shows zeros: a failed read is not an empty period.
    if (items === null) return PERIODS_REFUSALS.unavailable;
    const listed = new Set(rows.map((r) => r.id));
    const byPeriod = new Map<string, { kwh: number; amounts: number[] }>();
    for (const item of items) {
      if (!listed.has(item.billing_period_id)) continue;
      const t = byPeriod.get(item.billing_period_id) ?? { kwh: 0, amounts: [] };
      t.kwh += Number(item.usage_kwh ?? 0);
      t.amounts.push(Number(item.total_amount ?? 0));
      byPeriod.set(item.billing_period_id, t);
    }
    for (const [id, t] of byPeriod) totals.set(id, { kwh: t.kwh, amount: sumMoney(t.amounts, currency) });
  }

  const periods: PeriodRowInput[] = rows.map((r) => {
    const t = totals.get(r.id);
    return { ...r, totalKwh: t ? t.kwh : null, totalAmount: t ? t.amount : null };
  });
  return {
    ok: true,
    model: buildPeriodsModel({ microgridId: microgrid.id, currency, periods, fmt: req.fmt }),
  };
}

/**
 * billing.delete-period's confirmation: the period's name to type, and how
 * many bills go with it. A closed period, or one whose bills carry a
 * recorded payment, is refused here with the copy the route would answer.
 * Payment attempts and events are hidden from the person's client, so the
 * route can still refuse a period this lets through.
 */
export async function prepareDeletePeriod(
  req: SurfaceRequest,
  input: { params: Record<string, string>; body?: unknown },
): Promise<Loaded<Ceremony>> {
  const { data: period, error } = await req.supabase
    .from("billing_periods")
    .select("id, start_date, end_date, status")
    .eq("id", input.params.periodId)
    .maybeSingle<{ id: string; start_date: string; end_date: string; status: string }>();
  if (error) return DELETE_PERIOD_REFUSALS.unavailable;
  if (!period) return DELETE_PERIOD_REFUSALS.notFound;
  if (period.status === "closed") return DELETE_PERIOD_REFUSALS.closed;

  const items = await readAllPages<{ id: string; payment_status: string; paid_at: string | null }>((after) =>
    pageAfter(
      req.supabase
        .from("billing_line_items")
        .select("id, payment_status, paid_at", { count: "exact" })
        .eq("billing_period_id", period.id),
      after,
    ),
  );
  if (items === null) return DELETE_PERIOD_REFUSALS.unavailable;
  if (items.some(lineItemHasRecordedPayment)) return DELETE_PERIOD_REFUSALS.payments;

  // The name the capability checks the typed one against: "October 2026", not a display label.
  const name = periodName(period.start_date, period.end_date);
  if (name === null) return DELETE_PERIOD_REFUSALS.failed;
  return {
    ok: true,
    model: {
      type: "ceremony",
      statement: DELETE_DRAFT_PERIOD_DESCRIPTION,
      facts: [
        { label: "Period", value: req.fmt.text(name) },
        { label: "Bills", value: req.fmt.number(items.length) },
      ],
      warnings: [],
      acknowledgements: [],
      typed: name,
    },
  };
}

/**
 * Which periods can be offered for deletion: not a closed one. One read, as
 * the availability budget is shared by every action on the view; payment
 * activity is left to prepare.
 */
export async function deletePeriodAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const { data, error } = await req.supabase.from("billing_periods").select("id, status").in("id", ids);
  // Thrown, so the host shows each one as not checked.
  if (error) throw new Error("billing.delete-period: availability not read");
  const status = new Map(((data ?? []) as { id: string; status: string }[]).map((p) => [p.id, p.status]));
  return Object.fromEntries(
    ids.map((id): [string, true | string] => {
      const s = status.get(id);
      if (s === undefined) return [id, DELETE_PERIOD_REFUSALS.notFound.message];
      return [id, s === "closed" ? PERIOD_KEPT_CLOSED_MESSAGE : true];
    }),
  );
}
