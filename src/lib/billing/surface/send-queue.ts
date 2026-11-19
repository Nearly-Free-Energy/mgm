import "server-only";

/**
 * The loader of the `billing.send-queue` view: a period's bills with the
 * stable payment link a manager sends each tenant (./send-queue-model.ts).
 *
 * The period, the microgrid, the tenants and the bills are read through the
 * person's own client (row-level security), as the period review reads
 * them: billing_periods and billing_line_items are FOR ALL on
 * user_can_access_microgrid, and tenants on its microgrid; if their
 * policies change, revisit what this shows. A tenant's primary email and
 * phone are read only to tell whether they have one, and never reach the
 * model.
 *
 * Whether links can be handed out is the Payments capability's readiness
 * for the microgrid's community (getReadiness, a read listed in
 * gui-surface.test.ts's LOADER_READS), composed with composePayments, which
 * checks the session with getUser and the person's access to the
 * organization; it reads the merchant account and the plugin state through
 * the same client. A readiness that cannot be read hides the links and says
 * so; it never refuses the view. Billing composing payments while payments
 * depends on billing in the catalog is what the legacy period page does too
 * (paymentLinkAvailable in src/app/(gui)/microgrids/[id]/billing/[periodId]/page.tsx);
 * if the catalog or gui-surface.test.ts comes to forbid a plugin composing
 * one that depends on it, or getReadiness leaves LOADER_READS, revisit.
 *
 * The links themselves are built here from stablePaymentLinkPath and the
 * application's origin, as stablePaymentLink builds them
 * (src/lib/payments/capability.ts), without its per-bill organization
 * check: every id is a bill read through row-level security for this period
 * under the microgrid the host resolved for req.organizationId. If this
 * loader ever takes a bill id from the request, or stablePaymentLink starts
 * building the link another way, call the capability instead.
 *
 * The view loads while billing is off, and the host shows the gate's notice.
 * A refusal carries fixed copy, never a database message.
 */
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { composePayments, defaultAppUrl } from "@/lib/payments/compose";
import { stablePaymentLinkPath } from "@/lib/payments/payment-link";
import type { PaymentStatus } from "@/lib/payments/state";
import { pageAfter, readAllPages, readAllPagesInOrder } from "./pages";
import { PERIOD_REVIEW_REFUSALS } from "./period-review";
import { PERIOD_REVIEW_MAX_ROWS } from "./period-review-model";
import { buildSendQueueModel, linksOffered, type SendReadiness } from "./send-queue-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const SEND_QUEUE_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This billing period could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not load this period's bills to send right now. Try again shortly." },
  // The period review's copy: the legacy period page shows no period
  // without a pinned tariff, and so offers none of its payment links.
  noTariff: PERIOD_REVIEW_REFUSALS.noTariff,
  tooLarge: PERIOD_REVIEW_REFUSALS.tooLarge,
} as const satisfies Record<string, Refusal>;

type PeriodRow = {
  id: string;
  microgrid_id: string;
  start_date: string;
  end_date: string;
  status: "draft" | "closed";
  timezone: string | null;
  rate_schedule_id: string | null;
};
type MicrogridRow = { id: string; name: string; currency: string | null; community_id: string };
type TenantRow = { id: string; display_name: string; primary_email: string | null; primary_phone: string | null };
type BillRow = { id: string; tenant_id: string; total_amount: number | string; payment_status: PaymentStatus; invoice_number: string | null };

/** The readiness states getReadiness answers; anything else reads as not checked. */
const READINESS: readonly SendReadiness[] = ["ready", "sandbox", "disabled", "unconfigured", "connection_error"];

/**
 * The community's payment readiness, or "unchecked" when it cannot be read.
 * Composing on req.supabase queues that client's other queries behind
 * getUser's auth lock (the legacy page's note on paymentLinkAvailable), so
 * this runs after the view's own reads; it costs latency only.
 */
async function readReadiness(req: SurfaceRequest, communityId: string): Promise<SendReadiness> {
  try {
    const composed = await composePayments({ supabase: req.supabase, organizationId: req.organizationId, allowDisabled: true });
    if (!composed.ok) return "unchecked";
    try {
      const readiness = await composed.data.payments.getReadiness(communityId);
      if (!readiness.ok) return "unchecked";
      return READINESS.includes(readiness.data.state) ? readiness.data.state : "unchecked";
    } finally {
      await composed.data.dispose();
    }
  } catch {
    return "unchecked";
  }
}

export async function loadSendQueue(req: SurfaceRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const microgridId = req.params.id;
  const [periodRes, microgridRes] = await Promise.all([
    req.supabase
      .from("billing_periods")
      .select("id, microgrid_id, start_date, end_date, status, timezone, rate_schedule_id")
      .eq("id", req.params.periodId)
      .eq("microgrid_id", microgridId)
      .maybeSingle<PeriodRow>(),
    req.supabase.from("microgrids").select("id, name, currency, community_id").eq("id", microgridId).maybeSingle<MicrogridRow>(),
  ]);
  if (periodRes.error || microgridRes.error) return SEND_QUEUE_REFUSALS.unavailable;
  const period = periodRes.data;
  const microgrid = microgridRes.data;
  if (!period || !microgrid) return SEND_QUEUE_REFUSALS.notFound;
  if (!period.rate_schedule_id) return SEND_QUEUE_REFUSALS.noTariff;

  const [bills, tenants] = await Promise.all([
    readAllPages<BillRow>((after) =>
      pageAfter(
        req.supabase
          .from("billing_line_items")
          .select("id, tenant_id, total_amount, payment_status, invoice_number", { count: "exact" })
          .eq("billing_period_id", period.id),
        after,
      ),
    ),
    // In name order, as the period review lists them.
    readAllPagesInOrder<TenantRow>((from, to) =>
      req.supabase
        .from("tenants")
        .select("id, display_name, primary_email, primary_phone", { count: "exact" })
        .eq("microgrid_id", microgrid.id)
        .order("display_name")
        .order("id")
        .range(from, to),
    ),
  ]);
  if (bills === null || tenants === null) return SEND_QUEUE_REFUSALS.unavailable;
  const billed = new Set(bills.map((b) => b.tenant_id));
  if (tenants.filter((t) => billed.has(t.id)).length > PERIOD_REVIEW_MAX_ROWS) return SEND_QUEUE_REFUSALS.tooLarge;

  // No bills, nothing to send: readiness is not read, and the model says nothing about it.
  let readiness: SendReadiness = bills.length > 0 ? await readReadiness(req, microgrid.community_id) : "not_needed";
  const urls = new Map<string, string>();
  if (linksOffered(readiness)) {
    try {
      for (const bill of bills) urls.set(bill.id, defaultAppUrl(stablePaymentLinkPath(bill.id)));
    } catch {
      // MGM_APP_URL unset or invalid (src/lib/config/app-url.ts); its message is not shown.
      readiness = "no_address";
      urls.clear();
    }
  }

  return {
    ok: true,
    model: buildSendQueueModel({
      microgrid: { id: microgrid.id, name: microgrid.name, currency: microgrid.currency ?? "UGX" },
      period,
      tenants: tenants.map((t) => ({
        id: t.id,
        display_name: t.display_name,
        // As ensureCheckout tests the contact: present or not (./send-queue-model.ts, billNote).
        hasContact: Boolean(t.primary_email) || Boolean(t.primary_phone),
      })),
      bills: bills.map((b) => ({ ...b, total_amount: Number(b.total_amount) })),
      readiness,
      linkFor: (id) => {
        const url = urls.get(id);
        if (!url) throw new Error("billing.send-queue: no link built for a bill");
        return url;
      },
      superAdmin: rolesIncludeSuperAdmin(req.roles),
      fmt: req.fmt,
    }),
  };
}
