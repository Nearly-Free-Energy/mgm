import "server-only";

/**
 * The loader of the `billing.close-checklist` view, and the prepare and
 * availability steps of `billing.close-period`, which the checklist offers.
 *
 * Everything here reads through the person's own client (row-level
 * security) and composes no capability: billing_periods and
 * billing_line_items are FOR ALL on user_can_access_microgrid, and the close
 * review is fn_billing_period_close_review (migration 20261118130000), the
 * function the close route's capability reads through
 * createSupabaseBillingRepository.getCloseReview. That function is SECURITY
 * INVOKER and answers null for a period the caller cannot read, so a tenant
 * or another organization's manager gets a 404 here; if it stops being
 * SECURITY INVOKER, or its result changes shape (parseCloseReview in
 * ../close.ts), revisit this module. The checklist loads while billing is
 * off, and the host shows the gate's notice with Close disabled.
 *
 * The close route (POST /api/billing-periods/[periodId]/close) is the
 * authority on the close: prepare returns the ceremony it would send with
 * its 428, built by the same closeCeremony from the same review, and the
 * route checks the digest, the acknowledgements and the typed name again.
 * Prepare and availability only explain a refusal before it happens.
 *
 * A refusal carries fixed copy, never a database message.
 */
import type { Ceremony } from "@/lib/gui/contract";
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { CLOSE_REFUSAL_COPY, fractionalTotalsMessage, parseCloseReview, type CloseReview } from "../close";
import { closeCeremony } from "../close-ceremony";
import { buildCloseChecklistModel } from "./close-checklist-model";
import { pageAfter, readAllPages } from "./pages";
import { PERIOD_REVIEW_REFUSALS } from "./period-review";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const CLOSE_CHECKLIST_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This billing period could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not load this period's close checklist right now. Try again shortly." },
  // The period review's copy: the legacy period page cannot show, and so
  // cannot close, a period with no pinned tariff. A GUI decision; the close
  // route itself does not ask for a tariff.
  noTariff: PERIOD_REVIEW_REFUSALS.noTariff,
} as const satisfies Record<string, Refusal>;

/**
 * Why billing.close-period cannot be prepared. Closed, review-unavailable
 * and fractional are the close route's own copy (../close.ts). No bills and
 * no tariff are this GUI's decisions, as the legacy page decides them (its
 * Close Period button is disabled with no bills, and it renders no period
 * without a tariff); the route itself closes either.
 */
export const CLOSE_PERIOD_REFUSALS = {
  notFound: CLOSE_CHECKLIST_REFUSALS.notFound,
  unavailable: { ok: false, status: 503, message: CLOSE_REFUSAL_COPY.reviewUnavailable },
  closed: { ok: false, status: 409, message: CLOSE_REFUSAL_COPY.closed },
  noBills: { ok: false, status: 409, message: "Generate bills before closing this period." },
  noTariff: PERIOD_REVIEW_REFUSALS.noTariff,
} as const satisfies Record<string, Refusal>;

type PeriodRow = {
  id: string;
  microgrid_id: string;
  start_date: string;
  end_date: string;
  status: "draft" | "closed";
  closed_at: string | null;
  timezone: string | null;
  rate_schedule_id: string | null;
};

/** The period's close review, null when the caller cannot read the period, or "failed". */
async function readReview(req: SurfaceRequest, periodId: string): Promise<CloseReview | null | "failed"> {
  const { data, error } = await req.supabase.rpc("fn_billing_period_close_review", { _period_id: periodId });
  if (error) return "failed";
  if (data === null || data === undefined) return null;
  return parseCloseReview(data) ?? "failed";
}

/** Why a draft cannot be closed through this GUI, from its review alone; null when it can. */
function closeRefusal(review: CloseReview): Refusal | null {
  if (review.status === "closed") return CLOSE_PERIOD_REFUSALS.closed;
  if (review.billCount === 0) return CLOSE_PERIOD_REFUSALS.noBills;
  if (review.fractionalTotals.length > 0) {
    return { ok: false, status: 409, message: fractionalTotalsMessage(review.fractionalTotals) };
  }
  return null;
}

export async function loadCloseChecklist(req: SurfaceRequest): Promise<Loaded<LoadedModel<"flow">>> {
  const microgridId = req.params.id;
  const periodId = req.params.periodId;
  const [periodRes, microgridRes] = await Promise.all([
    req.supabase
      .from("billing_periods")
      .select("id, microgrid_id, start_date, end_date, status, closed_at, timezone, rate_schedule_id")
      .eq("id", periodId)
      .eq("microgrid_id", microgridId)
      .maybeSingle<PeriodRow>(),
    req.supabase
      .from("microgrids")
      .select("id, name, timezone")
      .eq("id", microgridId)
      .maybeSingle<{ id: string; name: string; timezone: string | null }>(),
  ]);
  if (periodRes.error || microgridRes.error) return CLOSE_CHECKLIST_REFUSALS.unavailable;
  const period = periodRes.data;
  const microgrid = microgridRes.data;
  if (!period || !microgrid) return CLOSE_CHECKLIST_REFUSALS.notFound;
  if (!period.rate_schedule_id) return CLOSE_CHECKLIST_REFUSALS.noTariff;

  const [review, bills] = await Promise.all([
    readReview(req, period.id),
    // Only to count where the readings came from; the review sums the rest.
    // usage_kwh too: a bill with no usage still has reading_source 'edge',
    // the column's default (00029), and is counted as neither.
    readAllPages<{ id: string; reading_source: string | null; usage_kwh: number | null }>((after) =>
      pageAfter(
        req.supabase
          .from("billing_line_items")
          .select("id, reading_source, usage_kwh", { count: "exact" })
          .eq("billing_period_id", period.id),
        after,
      ),
    ),
  ]);
  if (review === "failed" || bills === null) return CLOSE_CHECKLIST_REFUSALS.unavailable;
  if (review === null) return CLOSE_CHECKLIST_REFUSALS.notFound;
  const read = bills.filter((b) => b.usage_kwh !== null);

  return {
    ok: true,
    model: buildCloseChecklistModel({
      microgrid,
      period,
      review,
      sources: {
        edge: read.filter((b) => b.reading_source === "edge").length,
        manual: read.filter((b) => b.reading_source === "manual").length,
      },
      fmt: req.fmt,
    }),
  };
}

/**
 * billing.close-period's confirmation: the ceremony the close route sends
 * with its 428, from closeCeremony over the same review, so the totals,
 * warnings, acknowledgements, typed name and digest are the server's
 * (design rule 5 in CLAUDE.md). The route checks every one again.
 */
export async function prepareClosePeriod(
  req: SurfaceRequest,
  input: { params: Record<string, string>; body?: unknown },
): Promise<Loaded<Ceremony>> {
  const periodId = input.params.periodId;
  const { data: period, error } = await req.supabase
    .from("billing_periods")
    .select("id, rate_schedule_id")
    .eq("id", periodId)
    .maybeSingle<{ id: string; rate_schedule_id: string | null }>();
  if (error) return CLOSE_PERIOD_REFUSALS.unavailable;
  if (!period) return CLOSE_PERIOD_REFUSALS.notFound;
  if (!period.rate_schedule_id) return CLOSE_PERIOD_REFUSALS.noTariff;

  const review = await readReview(req, period.id);
  if (review === "failed") return CLOSE_PERIOD_REFUSALS.unavailable;
  if (review === null) return CLOSE_PERIOD_REFUSALS.notFound;
  const refused = closeRefusal(review);
  if (refused) return refused;
  return { ok: true, model: closeCeremony(review, req.fmt) };
}

/**
 * Which periods can be offered a close: a draft with bills, none of them a
 * fractional total. One review per id; only the checklist offers the action
 * (it is `targeted: false`), so that is one read. The tariff is left to the
 * loader and prepare.
 */
export async function closePeriodAvailable(req: SurfaceRequest, ids: string[]): Promise<Record<string, true | string>> {
  const reviews = await Promise.all(ids.map((id) => readReview(req, id)));
  // Thrown, so the host shows each one as not checked.
  if (reviews.includes("failed")) throw new Error("billing.close-period: availability not read");
  return Object.fromEntries(
    ids.map((id, n): [string, true | string] => {
      const review = reviews[n] as CloseReview | null;
      if (review === null) return [id, CLOSE_PERIOD_REFUSALS.notFound.message];
      return [id, closeRefusal(review)?.message ?? true];
    }),
  );
}
