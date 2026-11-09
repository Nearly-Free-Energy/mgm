import { composePayments } from "@/lib/payments/compose";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type {
  BillingLineItem,
  BillingPeriod,
  Household,
  Microgrid,
  RateSchedule,
} from "@/lib/types/domain";
import { BillingTable } from "@/components/BillingTable";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { requestUserIsSuperAdmin } from "@/lib/auth/request-access";

type PaymentCommunity = {
  id: string;
  payment_provider: string | null;
  org_id: string;
};

// Normalize PostgREST join (may be array or single object)
function firstCommunity(
  communities: PaymentCommunity | PaymentCommunity[] | null | undefined,
): PaymentCommunity | null {
  if (!communities) return null;
  return Array.isArray(communities) ? (communities[0] ?? null) : communities;
}

/**
 * Whether the community's payments are ready to offer a payment link.
 *
 * Composes Payments on a Supabase client of its own: authorizeOrganization
 * calls `auth.getUser()`, and supabase-js holds a client's auth lock for that
 * whole network call, so on the page's client it would hold back the
 * breadcrumb and table reads queued there by a round trip. If supabase-js
 * stops queueing queries behind getUser, the page's client would do.
 */
async function paymentLinkAvailable(community: PaymentCommunity): Promise<boolean> {
  const composed = await composePayments({
    supabase: await createClient(),
    organizationId: community.org_id,
    allowDisabled: true,
  });
  if (!composed.ok) return false;
  try {
    const readiness = await composed.data.payments.getReadiness(community.id);
    return readiness.ok && ["ready", "sandbox"].includes(readiness.data.state);
  } finally {
    await composed.data.dispose();
  }
}

export default async function BillingPeriodDetailPage({
  params,
}: {
  params: Promise<{ id: string; periodId: string }>;
}) {
  const { id, periodId } = await params;
  const supabase = await createClient();

  type MicrogridWithCommunity = Microgrid & {
    communities: PaymentCommunity | PaymentCommunity[] | null;
  };

  // BC2 (#174) — type for the household-edge join used to compute
  // `edgeAvailableByHouseholdId`. Mirrors the SELECT chain in
  // `src/lib/billing/generate.ts:251-264`.
  type HouseholdEdgeRow = {
    id: string;
    household_devices: Array<{
      role: string;
      devices: {
        id: string;
        openems_component_id: string | null;
        edges: { openems_edge_id: string | null } | null;
      } | null;
    }>;
  };

  // Every read below depends only on the route params or on another read
  // here, so they all start now; the breadcrumb's dependent queries are the
  // longest chain. The results are checked further down in the same order
  // as before, so each outcome (404, error banner, page) is unchanged.
  const periodRead = Promise.resolve(
    supabase
      .from("billing_periods")
      .select("*")
      .eq("id", periodId)
      .eq("microgrid_id", id)
      .single(),
  ).then((res) => ({ ...res, data: res.data as BillingPeriod | null }));

  // Amounts on historical bills must be explained by the period's own
  // tariff. Never show the latest microgrid tariff beside older charges.
  const scheduleRead = periodRead.then(async ({ data: period }) => {
    if (!period?.rate_schedule_id) return { data: null, error: null };
    const res = await supabase
      .from("rate_schedules")
      .select("*")
      .eq("id", period.rate_schedule_id)
      .eq("microgrid_id", id)
      .maybeSingle();
    return { ...res, data: res.data as RateSchedule | null };
  });

  // BC2 (#174) — line items without the actor join. The
  // `user_directory!entered_by_user_id(...)` PostgREST shorthand was
  // dropped when the underlying view was replaced by the
  // `fn_list_visible_users` RPC in #269 (no FK metadata on a function).
  // We resolve the actor display name in a second step below using
  // the same RPC, batched on the collected entered_by_user_id set.
  const lineItemsRead = Promise.resolve(
    supabase
      .from("billing_line_items")
      .select(
        "*, payment_status, paid_at, paid_by_user_id, payment_notes",
      )
      .eq("billing_period_id", periodId)
      .returns<BillingLineItem[]>(),
  );

  // BC2 (#174) — resolve the actor display name per line item via a
  // second call to the `fn_list_visible_users` RPC (#269 replaced the
  // user_directory view). Collect the entered_by_user_id set and ask the
  // RPC for those rows in one batch; the actor map is built below.
  const actorRowsRead = lineItemsRead.then(async ({ data: rows }) => {
    const enteredByIds = Array.from(
      new Set(
        (rows ?? [])
          .map((li) => li.entered_by_user_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    );
    if (enteredByIds.length === 0) return { data: null };
    return await supabase.rpc("fn_list_visible_users", {
      _target_user_ids: enteredByIds,
    });
  });

  const microgridRead = Promise.resolve(
    supabase
      .from("microgrids")
      .select("id, name, currency, communities!inner(id, payment_provider, org_id)")
      .eq("id", id)
      .single(),
  ).then((res) => ({ ...res, data: res.data as MicrogridWithCommunity | null }));

  // Payment readiness needs only the community (and its org, from the same
  // embed), so it starts as soon as the microgrid row is back. Its result,
  // or its error, is taken at the same point as before; the no-op catch
  // only stops an early failure counting as unhandled until then.
  const paymentConfiguredRead = microgridRead.then(({ data }) => {
    const community = firstCommunity(data?.communities);
    return community ? paymentLinkAvailable(community) : false;
  });
  paymentConfiguredRead.catch(() => {});

  const [
    levels,
    { data: period, error: periodError },
    { data: schedule, error: scheduleError },
    { data: lineItems, error: lineItemsError },
    { data: households, error: householdsError },
    { data: householdEdges, error: householdEdgesError },
    { data: microgrid, error: microgridError },
    isSuperAdmin,
    { data: actorRows },
  ] = await Promise.all([
    getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: id,
    }),
    periodRead,
    scheduleRead,
    lineItemsRead,
    supabase
      .from("households")
      .select("*")
      .eq("microgrid_id", id)
      .order("display_name")
      .returns<Household[]>(),
    supabase
      .from("households")
      .select(
        `id,
         household_devices(
           role,
           devices(
             id,
             openems_component_id,
             edges(openems_edge_id)
           )
         )`,
      )
      .eq("microgrid_id", id)
      .eq("household_devices.role", "primary_consumption_meter")
      .returns<HouseholdEdgeRow[]>(),
    microgridRead,
    requestUserIsSuperAdmin(),
    actorRowsRead,
  ]);

  if (periodError || !period) {
    notFound();
  }

  if (microgridError || !microgrid) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading microgrid: {microgridError?.message ?? "Not found"}
      </div>
    );
  }

  if (householdsError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading households: {householdsError.message}
      </div>
    );
  }

  if (lineItemsError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading line items: {lineItemsError.message}
      </div>
    );
  }

  if (scheduleError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading rate schedule: {scheduleError.message}
      </div>
    );
  }

  if (!schedule) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        This period has no pinned tariff. For an older billed period, an
        administrator must verify and reconcile its historical tariff before
        invoices or corrections can be shown.
      </div>
    );
  }

  // BC2 (#174) — surface the household-edge fetch error if it occurred.
  // Defensive: failure here only suppresses the "Switch back to edge data"
  // / "Regenerate from edge data" items in the kebab; the rest of the
  // table still renders. Log silently and fall back to an empty map.
  if (householdEdgesError) {
    console.warn(
      "[BillingPeriodDetailPage] household-edge fetch failed:",
      householdEdgesError.message,
    );
  }

  const isPaymentConfigured = await paymentConfiguredRead;
  const communityId = firstCommunity(microgrid.communities)?.id;

  // BC2 (#174) — compute edgeAvailable per household. Mirrors the gate
  // in `runGenerationFor` (src/lib/billing/generate.ts:289-311):
  // available iff a primary_consumption_meter device exists AND its
  // edge.openems_edge_id AND device.openems_component_id are non-null.
  const edgeAvailableByHouseholdId: Record<string, boolean> = {};
  for (const row of householdEdges ?? []) {
    const primaryHD = row.household_devices.find(
      (hd) => hd.role === "primary_consumption_meter",
    );
    const device = primaryHD?.devices ?? null;
    const edge = device?.edges ?? null;
    edgeAvailableByHouseholdId[row.id] =
      device != null &&
      device.openems_component_id != null &&
      edge != null &&
      edge.openems_edge_id != null;
  }

  // BC2 (#174) — index the batched fn_list_visible_users rows by user id
  // and build the actor map. RLS-hidden actors (e.g. super_admin invisible
  // to an org_manager caller) simply don't appear in the response → null
  // entry, matching the previous LEFT-JOIN-miss semantics.
  const cleanLineItems = (lineItems ?? []) as BillingLineItem[];
  const actorById = new Map<
    string,
    { first_name: string | null; last_name: string | null; email: string | null }
  >();
  for (const r of actorRows ?? []) {
    if (!r.user_id) continue;
    actorById.set(r.user_id, {
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
    });
  }

  const actorByLineItemId: Record<string, string | null> = {};
  for (const li of cleanLineItems) {
    // Mirror `pickDisplayName` from src/lib/billing/audit-log-fetch.ts:75-82:
    // first_name + last_name (joined with a space), fallback to email,
    // fallback to null.
    const enteredBy = li.entered_by_user_id;
    const row = enteredBy ? actorById.get(enteredBy) ?? null : null;
    const parts = [row?.first_name, row?.last_name].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    actorByLineItemId[li.id] =
      parts.length > 0 ? parts.join(" ") : (row?.email ?? null);
  }

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <BillingTable
        microgridId={id}
        period={period}
        lineItems={cleanLineItems}
        households={households ?? []}
        tiers={(schedule?.tiers ?? []) as { label: string; min_kwh: number; max_kwh: number | null; rate_per_kwh: number }[]}
        currency={microgrid.currency}
        isPaymentConfigured={isPaymentConfigured}
        isSuperAdmin={isSuperAdmin}
        communityId={communityId}
        edgeAvailableByHouseholdId={edgeAvailableByHouseholdId}
        allowUsageOnlyReadings
        actorByLineItemId={actorByLineItemId}
      />
    </>
  );
}
