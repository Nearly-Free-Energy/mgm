import "server-only";

/**
 * entity-descendants.ts — shared descendant counter for the entity-deletion
 * flow (#89). Single source of truth used by:
 *
 *   - the `GET /api/{organizations|communities|microgrids|edges}/[id]/delete-preview`
 *     endpoints that feed the blast-radius dialog, and
 *   - the corresponding DELETE routes' structured log payload (AC-LOG-1).
 *
 * Design:
 *   * Each query uses `count: "exact", head: true` so we count without
 *     transferring rows. Counts run in parallel via `Promise.all` — one
 *     "round-trip" per descendant kind is acceptable at pilot scale
 *     (<200ms aggregate per AC-ROUTE-6 budget). Chose this over a single
 *     Postgres RPC so the counts honor RLS on the caller's Supabase
 *     client — no separate privilege surface to audit.
 *
 *   * Return type is a discriminated union keyed on `kind`, so call sites
 *     narrow correctly in TypeScript and the dialog copy can render the
 *     right labels per entity kind.
 *
 *   * For an `edge` delete, `billing_line_items_nulled` is the count of
 *     rows whose `device_id` points at a device under this edge — these
 *     rows SURVIVE the cascade (FK is ON DELETE SET NULL per
 *     00001_schema.sql:241, intentional to preserve historical bills).
 *     The UI surfaces this as a "loses device linkage" line, NOT a
 *     destroyed-count. See AC-FK-AUDIT.
 *
 *   * For `edge.household_devices`: devices cascade-delete household_devices
 *     rows per 00001_schema.sql:191, so this count represents meter↔household
 *     links that will be severed (the households themselves survive since
 *     they hang off `microgrid_id`, not edge).
 *
 *   * Billing periods are split into `billing_periods_draft` and
 *     `billing_periods_closed` (NOT a single total) so the dialog copy
 *     can surface the "draft = unfinalized work lost" case distinctly
 *     per AC-ROUTE-8. Enum values are `'draft'` and `'closed'` — the
 *     `billing_period_status` enum has no other values (see
 *     00001_schema.sql:49). Never use the word `'open'`.
 *
 *   * `billing_periods_with_payments` counts the drafts with payment
 *     activity. With `billing_periods_closed`, it tells the preview that
 *     the database will refuse the delete (migration 20261103160000).
 *
 *   * For an `edge`, `readings_in_closed_periods` counts the meter
 *     readings that go with its devices and were taken during a closed
 *     billing period, so the dialog can warn about them.
 *
 *   * `user_roles` counts (org-scoped only) rely on the FK+CASCADE from
 *     00015_entity_deletion_safeguards.sql; we filter by `scope_type='org'
 *     AND scope_id=<org_id>` which matches exactly the rows that will be
 *     cascade-deleted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysToDateKey, startOfDayInZone } from "@/lib/timezone/day-key";

// Types + pure helpers live in a client-safe module so client components
// (BlastRadiusList, DeleteEntityButton) can import them without pulling
// `server-only` into the client bundle. Re-export here so existing
// call sites (routes, log payload) keep working through a single import.
import type {
  DescendantCounts,
  EntityKind,
} from "@/lib/entity-descendants-types";
export type { DescendantCounts, EntityKind };
export { descendantCountsAreEmpty } from "@/lib/entity-descendants-types";

/** Convert a Supabase `count: "exact", head: true` result to a number. */
function n(count: number | null | undefined): number {
  return count ?? 0;
}

async function countTable(
  supabase: SupabaseClient,
  table: string,
  filter: { column: string; values: string[] }
): Promise<number> {
  if (filter.values.length === 0) return 0;
  // Selecting the filter column works for tables without an `id` column
  // (microgrid_savings_settings is keyed by microgrid_id).
  const query = supabase
    .from(table)
    .select(filter.column, { count: "exact", head: true });
  const { count } = await (filter.values.length === 1
    ? query.eq(filter.column, filter.values[0])
    : query.in(filter.column, filter.values));
  return n(count);
}

async function countTableWith(
  supabase: SupabaseClient,
  table: string,
  apply: (qb: ReturnType<SupabaseClient["from"]>) => unknown
): Promise<number> {
  const qb = supabase.from(table).select("id", { count: "exact", head: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await apply(qb as any)) as { count: number | null };
  return n(res.count);
}

/**
 * How many of the given draft periods have payment activity: a bill whose
 * payment_status is not 'unpaid' or whose paid_at is set, or a payment
 * attempt or payment event for one of their bills. The same definition as
 * the database guards in migration 20261103160000; change them together.
 *
 * Reads through the caller's RLS, so it can only undercount. The database
 * guard is the authoritative check, and the DELETE route explains its
 * refusal too.
 */
async function countDraftPeriodsWithPayments(
  supabase: SupabaseClient,
  draftPeriodIds: string[]
): Promise<number> {
  if (draftPeriodIds.length === 0) return 0;
  const [paidBills, attempts, events] = await Promise.all([
    supabase
      .from("billing_line_items")
      .select("billing_period_id")
      .in("billing_period_id", draftPeriodIds)
      .or("payment_status.neq.unpaid,paid_at.not.is.null"),
    supabase
      .from("payment_attempts")
      .select("billing_line_items!inner(billing_period_id)")
      .in("billing_line_items.billing_period_id", draftPeriodIds),
    supabase
      .from("payment_events")
      .select("billing_line_items!inner(billing_period_id)")
      .in("billing_line_items.billing_period_id", draftPeriodIds),
  ]);
  type Bill = { billing_period_id: string };
  const periodIds = new Set<string>(
    ((paidBills.data ?? []) as Bill[]).map((row) => row.billing_period_id)
  );
  // PostgREST embeds the bill of a payment row as one object (many-to-one);
  // the untyped client cannot know that, so accept a list as well.
  for (const row of [...(attempts.data ?? []), ...(events.data ?? [])] as unknown as {
    billing_line_items: Bill | Bill[] | null;
  }[]) {
    for (const bill of [row.billing_line_items].flat()) {
      if (bill) periodIds.add(bill.billing_period_id);
    }
  }
  return periodIds.size;
}

/**
 * Meter readings of `deviceIds` taken during a closed billing period of
 * `microgridId`: from the first instant of the period's start date to the
 * first instant after its end date, both included so the opening and
 * closing registers count. The dates are read in the period's own
 * `timezone`, the zone billing windows the period in (generate.ts, #355);
 * if billing changes how it windows a period, change this to match.
 */
async function countReadingsInClosedPeriods(
  supabase: SupabaseClient,
  microgridId: string,
  deviceIds: string[]
): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const { data: periods } = await supabase
    .from("billing_periods")
    .select("start_date, end_date, timezone")
    .eq("microgrid_id", microgridId)
    .eq("status", "closed");
  const windows = (
    (periods ?? []) as { start_date: string; end_date: string; timezone: string }[]
  ).map((period) => {
    const from = startOfDayInZone(period.start_date, period.timezone).toISOString();
    const to = startOfDayInZone(
      addDaysToDateKey(period.end_date, 1),
      period.timezone
    ).toISOString();
    // Quoted: `.` and `:` in the timestamps are PostgREST reserved characters.
    return `and(read_at.gte."${from}",read_at.lte."${to}")`;
  });
  if (windows.length === 0) return 0;
  const { count } = await supabase
    .from("meter_readings")
    .select("id", { count: "exact", head: true })
    .in("device_id", deviceIds)
    .or(windows.join(","));
  return n(count);
}

// ── Per-entity counters ──────────────────────────────────────────────────

async function countForOrganization(
  supabase: SupabaseClient,
  orgId: string
): Promise<Extract<DescendantCounts, { kind: "organization" }>> {
  // Resolve the descendant-id trees once; subsequent counts reuse them.
  const { data: communities } = await supabase
    .from("communities")
    .select("id")
    .eq("org_id", orgId);
  const communityIds = (communities ?? []).map((r) => r.id as string);

  const { data: microgrids } = communityIds.length
    ? await supabase.from("microgrids").select("id").in("community_id", communityIds)
    : { data: [] as { id: string }[] };
  const microgridIds = (microgrids ?? []).map((r) => r.id as string);

  const { data: edges } = microgridIds.length
    ? await supabase.from("edges").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const edgeIds = (edges ?? []).map((r) => r.id as string);

  const { data: devices } = edgeIds.length
    ? await supabase.from("devices").select("id").in("edge_id", edgeIds)
    : { data: [] as { id: string }[] };
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const { data: households } = microgridIds.length
    ? await supabase.from("households").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const householdIds = (households ?? []).map((r) => r.id as string);

  const { data: billingPeriods } = microgridIds.length
    ? await supabase
        .from("billing_periods")
        .select("id,status")
        .in("microgrid_id", microgridIds)
    : { data: [] as { id: string; status: string }[] };
  const billingPeriodIds = (billingPeriods ?? []).map((r) => r.id as string);
  const bpDraft = (billingPeriods ?? []).filter((r) => r.status === "draft").length;
  const bpClosed = (billingPeriods ?? []).filter((r) => r.status === "closed").length;
  const draftPeriodIds = (billingPeriods ?? [])
    .filter((r) => r.status === "draft")
    .map((r) => r.id as string);

  const [
    householdDevicesCount,
    householdUsersCount,
    billingLineItemsCount,
    rateSchedulesCount,
    gridTariffsCount,
    savingsSettingsCount,
    userRolesCount,
    bpWithPayments,
  ] = await Promise.all([
    householdIds.length
      ? countTable(supabase, "household_devices", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    householdIds.length
      ? countTable(supabase, "household_users", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    billingPeriodIds.length
      ? countTable(supabase, "billing_line_items", {
          column: "billing_period_id",
          values: billingPeriodIds,
        })
      : Promise.resolve(0),
    microgridIds.length
      ? countTable(supabase, "rate_schedules", {
          column: "microgrid_id",
          values: microgridIds,
        })
      : Promise.resolve(0),
    countTable(supabase, "grid_tariffs", {
      column: "microgrid_id",
      values: microgridIds,
    }),
    countTable(supabase, "microgrid_savings_settings", {
      column: "microgrid_id",
      values: microgridIds,
    }),
    countTableWith(supabase, "user_roles", (qb) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (qb as any).eq("scope_type", "org").eq("scope_id", orgId)
    ),
    countDraftPeriodsWithPayments(supabase, draftPeriodIds),
  ]);

  return {
    kind: "organization",
    communities: communityIds.length,
    microgrids: microgridIds.length,
    edges: edgeIds.length,
    devices: deviceIds.length,
    households: householdIds.length,
    household_devices: householdDevicesCount,
    household_users: householdUsersCount,
    billing_periods_draft: bpDraft,
    billing_periods_closed: bpClosed,
    billing_periods_with_payments: bpWithPayments,
    billing_line_items: billingLineItemsCount,
    rate_schedules: rateSchedulesCount,
    grid_tariffs: gridTariffsCount,
    microgrid_savings_settings: savingsSettingsCount,
    user_roles: userRolesCount,
  };
}

async function countForCommunity(
  supabase: SupabaseClient,
  communityId: string
): Promise<Extract<DescendantCounts, { kind: "community" }>> {
  const { data: microgrids } = await supabase
    .from("microgrids")
    .select("id")
    .eq("community_id", communityId);
  const microgridIds = (microgrids ?? []).map((r) => r.id as string);

  const { data: edges } = microgridIds.length
    ? await supabase.from("edges").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const edgeIds = (edges ?? []).map((r) => r.id as string);

  const { data: devices } = edgeIds.length
    ? await supabase.from("devices").select("id").in("edge_id", edgeIds)
    : { data: [] as { id: string }[] };
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const { data: households } = microgridIds.length
    ? await supabase.from("households").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const householdIds = (households ?? []).map((r) => r.id as string);

  const { data: billingPeriods } = microgridIds.length
    ? await supabase
        .from("billing_periods")
        .select("id,status")
        .in("microgrid_id", microgridIds)
    : { data: [] as { id: string; status: string }[] };
  const billingPeriodIds = (billingPeriods ?? []).map((r) => r.id as string);
  const bpDraft = (billingPeriods ?? []).filter((r) => r.status === "draft").length;
  const bpClosed = (billingPeriods ?? []).filter((r) => r.status === "closed").length;
  const draftPeriodIds = (billingPeriods ?? [])
    .filter((r) => r.status === "draft")
    .map((r) => r.id as string);

  const [
    householdDevicesCount,
    householdUsersCount,
    billingLineItemsCount,
    rateSchedulesCount,
    gridTariffsCount,
    savingsSettingsCount,
    bpWithPayments,
  ] = await Promise.all([
    householdIds.length
      ? countTable(supabase, "household_devices", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    householdIds.length
      ? countTable(supabase, "household_users", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    billingPeriodIds.length
      ? countTable(supabase, "billing_line_items", {
          column: "billing_period_id",
          values: billingPeriodIds,
        })
      : Promise.resolve(0),
    microgridIds.length
      ? countTable(supabase, "rate_schedules", {
          column: "microgrid_id",
          values: microgridIds,
        })
      : Promise.resolve(0),
    countTable(supabase, "grid_tariffs", {
      column: "microgrid_id",
      values: microgridIds,
    }),
    countTable(supabase, "microgrid_savings_settings", {
      column: "microgrid_id",
      values: microgridIds,
    }),
    countDraftPeriodsWithPayments(supabase, draftPeriodIds),
  ]);

  // For this scope we count edges/devices via the resolved id trees
  // (Supabase doesn't support cross-table joins in a simple count query).
  return {
    kind: "community",
    microgrids: microgridIds.length,
    edges: edgeIds.length,
    devices: deviceIds.length,
    households: householdIds.length,
    household_devices: householdDevicesCount,
    household_users: householdUsersCount,
    billing_periods_draft: bpDraft,
    billing_periods_closed: bpClosed,
    billing_periods_with_payments: bpWithPayments,
    billing_line_items: billingLineItemsCount,
    rate_schedules: rateSchedulesCount,
    grid_tariffs: gridTariffsCount,
    microgrid_savings_settings: savingsSettingsCount,
  };
}

async function countForMicrogrid(
  supabase: SupabaseClient,
  microgridId: string
): Promise<Extract<DescendantCounts, { kind: "microgrid" }>> {
  const { data: edges } = await supabase
    .from("edges")
    .select("id")
    .eq("microgrid_id", microgridId);
  const edgeIds = (edges ?? []).map((r) => r.id as string);

  const { data: devices } = edgeIds.length
    ? await supabase.from("devices").select("id").in("edge_id", edgeIds)
    : { data: [] as { id: string }[] };
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const { data: households } = await supabase
    .from("households")
    .select("id")
    .eq("microgrid_id", microgridId);
  const householdIds = (households ?? []).map((r) => r.id as string);

  const { data: billingPeriods } = await supabase
    .from("billing_periods")
    .select("id,status")
    .eq("microgrid_id", microgridId);
  const billingPeriodIds = (billingPeriods ?? []).map((r) => r.id as string);
  const bpDraft = (billingPeriods ?? []).filter((r) => r.status === "draft").length;
  const bpClosed = (billingPeriods ?? []).filter((r) => r.status === "closed").length;
  const draftPeriodIds = (billingPeriods ?? [])
    .filter((r) => r.status === "draft")
    .map((r) => r.id as string);

  const [
    householdDevicesCount,
    householdUsersCount,
    billingLineItemsCount,
    rateSchedulesCount,
    gridTariffsCount,
    savingsSettingsCount,
    bpWithPayments,
  ] = await Promise.all([
    householdIds.length
      ? countTable(supabase, "household_devices", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    householdIds.length
      ? countTable(supabase, "household_users", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    billingPeriodIds.length
      ? countTable(supabase, "billing_line_items", {
          column: "billing_period_id",
          values: billingPeriodIds,
        })
      : Promise.resolve(0),
    countTableWith(supabase, "rate_schedules", (qb) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (qb as any).eq("microgrid_id", microgridId)
    ),
    countTable(supabase, "grid_tariffs", {
      column: "microgrid_id",
      values: [microgridId],
    }),
    countTable(supabase, "microgrid_savings_settings", {
      column: "microgrid_id",
      values: [microgridId],
    }),
    countDraftPeriodsWithPayments(supabase, draftPeriodIds),
  ]);

  return {
    kind: "microgrid",
    edges: edgeIds.length,
    devices: deviceIds.length,
    households: householdIds.length,
    household_devices: householdDevicesCount,
    household_users: householdUsersCount,
    billing_periods_draft: bpDraft,
    billing_periods_closed: bpClosed,
    billing_periods_with_payments: bpWithPayments,
    billing_line_items: billingLineItemsCount,
    rate_schedules: rateSchedulesCount,
    grid_tariffs: gridTariffsCount,
    microgrid_savings_settings: savingsSettingsCount,
  };
}

async function countForEdge(
  supabase: SupabaseClient,
  edgeId: string
): Promise<Extract<DescendantCounts, { kind: "edge" }>> {
  const [{ data: devices }, { data: edge }] = await Promise.all([
    supabase.from("devices").select("id").eq("edge_id", edgeId),
    supabase
      .from("edges")
      .select("microgrid_id")
      .eq("id", edgeId)
      .maybeSingle<{ microgrid_id: string }>(),
  ]);
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const [householdDevicesCount, billingLineItemsNulled, readingsInClosedPeriods] =
    await Promise.all([
      deviceIds.length
        ? countTable(supabase, "household_devices", {
            column: "device_id",
            values: deviceIds,
          })
        : Promise.resolve(0),
      deviceIds.length
        ? countTable(supabase, "billing_line_items", {
            column: "device_id",
            values: deviceIds,
          })
        : Promise.resolve(0),
      edge
        ? countReadingsInClosedPeriods(supabase, edge.microgrid_id, deviceIds)
        : Promise.resolve(0),
    ]);

  return {
    kind: "edge",
    devices: deviceIds.length,
    household_devices: householdDevicesCount,
    billing_line_items_nulled: billingLineItemsNulled,
    readings_in_closed_periods: readingsInClosedPeriods,
  };
}

/**
 * Count every descendant that would be affected by a CASCADE DELETE of the
 * given entity, suitable for rendering the blast-radius dialog and for
 * logging the delete event.
 *
 * The Supabase client passed in MUST be the user-bound server client (NOT
 * service-role). Counts honor RLS — an unauthorized caller sees zeros.
 * Callers should run a permission check BEFORE this function to avoid
 * returning misleading zero counts to a legitimate caller who hit a
 * transient RLS policy regression.
 */
export async function countEntityDescendants(
  supabase: SupabaseClient,
  kind: EntityKind,
  id: string
): Promise<DescendantCounts> {
  switch (kind) {
    case "organization":
      return countForOrganization(supabase, id);
    case "community":
      return countForCommunity(supabase, id);
    case "microgrid":
      return countForMicrogrid(supabase, id);
    case "edge":
      return countForEdge(supabase, id);
  }
}

// `descendantCountsAreEmpty` is re-exported from entity-descendants-types.ts
// (client-safe module). Do NOT duplicate the implementation here — adding
// a pure helper to a server-only file would defeat the split that lets
// the UI render without dragging Supabase into the client bundle.
