/**
 * Supabase implementation of `BillingRepository`.
 *
 * Composition-root module: the ONLY place in the billing plugin allowed to
 * touch the Supabase client, auth access helpers, plugin state, and the
 * engine delegate. The capability consumes the repository interface from
 * `../repository` — see `__tests__/billing-import-boundary.test.ts`.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { isPluginEnabledForOrg } from "@/lib/plugins/state";
import { parseCloseReview } from "../close";
import type {
  BillingPeriodRow,
  BillingRepository,
  PeriodSummary,
  RateScheduleRow,
  RepositoryError,
  UnresolvedTenant,
} from "../repository";

function toError(error: { code?: string; message?: string }): RepositoryError {
  return { code: error.code, message: error.message ?? "Unknown database error" };
}

export function createSupabaseBillingRepository(
  supabase: SupabaseClient
): BillingRepository {
  return {
    async getAuthenticatedUserId() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user?.id ?? null;
    },

    async getUserRoles() {
      return getCurrentUserRoles(supabase);
    },

    // Rejects when plugin state cannot be read, a database error included,
    // so the capability can tell "off" from "unknown" and fail closed.
    async isPluginEnabled(organizationId: string) {
      return isPluginEnabledForOrg(supabase, organizationId, "billing");
    },

    async getMicrogridOrganization(microgridId: string) {
      const { data: microgrid } = await supabase
        .from("microgrids")
        .select("id, community_id")
        .eq("id", microgridId)
        .maybeSingle<{ id: string; community_id: string }>();
      if (!microgrid) return null;
      const { data: community } = await supabase
        .from("communities")
        .select("id, org_id")
        .eq("id", microgrid.community_id)
        .maybeSingle<{ id: string; org_id: string }>();
      if (!community) return null;
      return {
        microgridId: microgrid.id,
        communityId: community.id,
        orgId: community.org_id,
      };
    },

    async getPeriodOrganization(periodId: string) {
      const { data: period } = await supabase
        .from("billing_periods")
        .select("id, microgrid_id")
        .eq("id", periodId)
        .maybeSingle<{ id: string; microgrid_id: string }>();
      if (!period) return null;
      const org = await this.getMicrogridOrganization(period.microgrid_id);
      if (!org) return null;
      return { periodId: period.id, microgridId: period.microgrid_id, orgId: org.orgId };
    },

    async getLineItemOrganization(lineItemId: string) {
      const { data: item } = await supabase
        .from("billing_line_items")
        .select("id, billing_period_id")
        .eq("id", lineItemId)
        .maybeSingle<{ id: string; billing_period_id: string }>();
      if (!item) return null;
      const period = await this.getPeriodOrganization(item.billing_period_id);
      if (!period) return null;
      return {
        lineItemId: item.id,
        microgridId: period.microgridId,
        orgId: period.orgId,
      };
    },

    async getMicrogridTimezone(microgridId: string) {
      const { data } = await supabase
        .from("microgrids")
        .select("timezone")
        .eq("id", microgridId)
        .maybeSingle<{ timezone: string }>();
      return data?.timezone ?? null;
    },

    async getLatestRateSchedule(microgridId: string) {
      const { data } = await supabase
        .from("rate_schedules")
        .select("id, microgrid_id, tiers, service_charge, tax_rate, created_at")
        .eq("microgrid_id", microgridId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{
          id: string;
          microgrid_id: string;
          tiers: RateScheduleRow["tiers"];
          service_charge: number;
          tax_rate: number;
          created_at: string;
        }>();
      return (data as RateScheduleRow | null) ?? null;
    },

    async createRateSchedule(input) {
      const { data, error } = await supabase
        .from("rate_schedules")
        .insert({
          microgrid_id: input.microgridId,
          tiers: input.tiers,
          service_charge: input.serviceCharge,
          tax_rate: input.taxRate,
        })
        .select("id, microgrid_id, tiers, service_charge, tax_rate, created_at")
        .single();
      if (error) return { row: null, error: toError(error) };
      return { row: data as unknown as RateScheduleRow, error: null };
    },

    async createBillingPeriod(input) {
      // Serializes creation per microgrid and rejects overlapping windows in
      // the database, so simultaneous requests cannot create duplicate spans.
      const { data, error } = await supabase.rpc("fn_create_billing_period", {
        _microgrid_id: input.microgridId,
        _start_date: input.startDate,
        _end_date: input.endDate,
      });
      if (error) return { row: null, error: toError(error) };
      const row = Array.isArray(data) ? data[0] : data;
      return { row: (row as unknown as BillingPeriodRow) ?? null, error: null };
    },

    async getPeriodSummary(periodId: string): Promise<PeriodSummary | null> {
      const { data: period, error: periodError } = await supabase
        .from("billing_periods")
        .select("id, microgrid_id, start_date, end_date, status, timezone")
        .eq("id", periodId)
        .maybeSingle<BillingPeriodRow>();
      if (periodError) throw new Error("Could not load billing period summary.");
      if (!period) return null;

      const { data: tenants, error: tenantsError } = await supabase
        .from("tenants")
        .select("id, display_name")
        .eq("microgrid_id", period.microgrid_id);
      const { data: items, error: itemsError } = await supabase
        .from("billing_line_items")
        .select("id, tenant_id, total_amount")
        .eq("billing_period_id", periodId);
      // A failed read is not evidence of an empty, complete period.
      if (tenantsError || itemsError || !tenants || !items) {
        throw new Error("Could not verify billing period completeness.");
      }

      const billedIds = new Set((items ?? []).map((i) => i.tenant_id as string));
      const unresolved: UnresolvedTenant[] = ((tenants ?? []) as {
        id: string;
        display_name: string;
      }[])
        .filter((h) => !billedIds.has(h.id))
        .map((h) => ({
          tenantId: h.id,
          tenantName: h.display_name,
          reason: "No bill generated for this tenant in this period.",
        }));
      const totalAmount = (items ?? []).reduce(
        (sum, i) => sum + Number(i.total_amount ?? 0),
        0
      );
      return {
        period,
        lineItemCount: (items ?? []).length,
        totalAmount,
        unresolved,
      };
    },

    async getCloseReview(periodId: string) {
      const { data, error } = await supabase.rpc("fn_billing_period_close_review", {
        _period_id: periodId,
      });
      if (error) throw new Error("Could not load the billing period's close review.");
      if (data === null || data === undefined) return null;
      const review = parseCloseReview(data);
      if (!review) throw new Error("The billing period's close review is not in the expected shape.");
      return review;
    },

    async closeBillingPeriod(periodId, confirmation) {
      // The digest check, the state transition and the period_closed audit
      // event commit or roll back together inside the RPC transaction.
      const { data, error } = await supabase.rpc("fn_close_billing_period", {
        _period_id: periodId,
        _digest: confirmation.digest,
        _acknowledged: confirmation.acknowledged,
      });
      if (error) return { row: null, error: toError(error) };
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        return {
          row: null,
          error: { message: "Billing period not found or already closed." },
        };
      }
      return { row: row as unknown as BillingPeriodRow, error: null };
    },

    async recordManualPayment(input) {
      const { data, error } = await supabase.rpc("fn_apply_payment_event", {
        _line_item_id: input.lineItemId,
        _to_status: input.status,
        _source: "manual",
        _actor_user_id: input.actorUserId,
        _raw_payload: {
          ...(input.notes !== null || input.status === "unpaid"
            ? { payment_notes: input.notes }
            : {}),
          recorded_via: "mgm-billing",
        },
      });
      if (error) return { updated: null, error: toError(error) };
      return { updated: data, error: null };
    },

    async getBillingPeriod(periodId: string) {
      const { data, error } = await supabase
        .from("billing_periods")
        .select("id, microgrid_id, start_date, end_date, status, timezone")
        .eq("id", periodId)
        .maybeSingle<BillingPeriodRow>();
      if (error) throw new Error("Could not load billing period.");
      return data ?? null;
    },

    async deleteBillingPeriod(periodId: string) {
      // A row that row-level security hides deletes nothing and raises no
      // error, so the deleted ids are read back.
      const { data, error } = await supabase
        .from("billing_periods")
        .delete()
        .eq("id", periodId)
        .select("id");
      // Only this path carries PostgREST's DETAIL: the delete guard's `closed`
      // or `payment_activity`. Elsewhere a DETAIL can hold key values.
      if (error) return { deleted: false, error: { ...toError(error), details: error.details ?? null } };
      return { deleted: (data ?? []).length > 0, error: null };
    },
  };
}
