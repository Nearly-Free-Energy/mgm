/**
 * Supabase implementation of `BillingRepository`.
 *
 * Composition-root module: the ONLY place in the billing plugin allowed to
 * touch the Supabase client, auth access helpers, plugin state, and the MBE
 * engine delegate. The capability consumes the repository interface from
 * `../repository` — see `__tests__/billing-import-boundary.test.ts`.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { isBillingEnabled } from "@/lib/plugins/state";
import type {
  BillingPeriodRow,
  BillingRepository,
  PeriodSummary,
  RateScheduleRow,
  RepositoryError,
  UnresolvedHousehold,
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

    async isPluginEnabled(organizationId: string) {
      return isBillingEnabled(supabase, organizationId);
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
      // The period timezone is stamped by the BEFORE INSERT trigger
      // (00055) from the parent microgrid; the trigger ignores any
      // client-supplied value, so no timezone column is sent here.
      const { data, error } = await supabase
        .from("billing_periods")
        .insert({
          microgrid_id: input.microgridId,
          start_date: input.startDate,
          end_date: input.endDate,
        })
        .select("id, microgrid_id, start_date, end_date, status, timezone")
        .single();
      if (error) return { row: null, error: toError(error) };
      return { row: data as unknown as BillingPeriodRow, error: null };
    },

    async getPeriodSummary(periodId: string): Promise<PeriodSummary | null> {
      const { data: period, error: periodError } = await supabase
        .from("billing_periods")
        .select("id, microgrid_id, start_date, end_date, status, timezone")
        .eq("id", periodId)
        .maybeSingle<BillingPeriodRow>();
      if (periodError) throw new Error("Could not load billing period summary.");
      if (!period) return null;

      const { data: households, error: householdsError } = await supabase
        .from("households")
        .select("id, display_name")
        .eq("microgrid_id", period.microgrid_id);
      const { data: items, error: itemsError } = await supabase
        .from("billing_line_items")
        .select("id, household_id, total_amount")
        .eq("billing_period_id", periodId);

      // A failed read is not evidence of an empty, complete period.
      if (householdsError || itemsError || !households || !items) {
        throw new Error("Could not verify billing period completeness.");
      }

      const billedIds = new Set((items ?? []).map((i) => i.household_id as string));
      const unresolved: UnresolvedHousehold[] = ((households ?? []) as {
        id: string;
        display_name: string;
      }[])
        .filter((h) => !billedIds.has(h.id))
        .map((h) => ({
          householdId: h.id,
          householdName: h.display_name,
          reason: "No bill generated for this household in this period.",
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

    async closeBillingPeriod(periodId: string) {
      const { data, error } = await supabase
        .from("billing_periods")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", periodId)
        .neq("status", "closed")
        .select("id, microgrid_id, start_date, end_date, status, timezone")
        .maybeSingle();
      if (error) return { row: null, error: toError(error) };
      if (!data) {
        return {
          row: null,
          error: { message: "Billing period not found or already closed." },
        };
      }
      return { row: data as unknown as BillingPeriodRow, error: null };
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
  };
}
