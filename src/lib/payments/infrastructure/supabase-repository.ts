/**
 * Supabase implementation of `PaymentsRepository`.
 *
 * Composition-root module: the ONLY place in the Payments plugin allowed to
 * touch the Supabase client, auth helpers, and plugin state. The capability
 * consumes the repository interface — see
 * `__tests__/payments-import-boundary.test.ts`.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPaymentsEnabled, isPesapalEnabled } from "@/lib/plugins/state";
import type {
  BillSnapshot,
  MerchantAccountPublic,
  MerchantAccountSecret,
  PaymentAttempt,
  PaymentReceipt,
  PaymentsRepository,
  RepositoryError,
} from "../repository";

function toError(error: { code?: string; message?: string }): RepositoryError {
  return { code: error.code, message: error.message ?? "Unknown database error" };
}

function toPublic(row: Record<string, unknown>, origin: MerchantAccountPublic["origin"], communityId: string | null): MerchantAccountPublic {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    provider: "pesapal",
    display_name: String(row.display_name ?? "Default Pesapal account"),
    sandbox: Boolean(row.sandbox ?? true),
    consumer_key: String(row.consumer_key ?? ""),
    base_url: String(row.base_url ?? ""),
    ipn_id: (row.ipn_id as string | null) ?? null,
    ipn_url: (row.ipn_url as string | null) ?? null,
    version: Number(row.version ?? 1),
    disabled: Boolean(row.disabled ?? false),
    last_tested_at: (row.last_tested_at as string | null) ?? null,
    last_test_status: (row.last_test_status as string | null) ?? null,
    last_test_message: (row.last_test_message as string | null) ?? null,
    origin,
    community_id: communityId,
  };
}

export function createSupabasePaymentsRepository(
  supabase: SupabaseClient
): PaymentsRepository {
  return {
    async isPaymentsEnabled(organizationId: string) {
      return isPaymentsEnabled(supabase, organizationId);
    },

    async isPesapalEnabled(organizationId: string) {
      return isPesapalEnabled(supabase, organizationId);
    },

    async getLineItemOrganization(lineItemId: string) {
      const { data: item } = await supabase
        .from("billing_line_items")
        .select("id, billing_period_id")
        .eq("id", lineItemId)
        .maybeSingle<{ id: string; billing_period_id: string }>();
      if (!item) return null;
      const { data: period } = await supabase
        .from("billing_periods")
        .select("id, microgrid_id")
        .eq("id", item.billing_period_id)
        .maybeSingle<{ id: string; microgrid_id: string }>();
      if (!period) return null;
      const { data: microgrid } = await supabase
        .from("microgrids")
        .select("id, community_id")
        .eq("id", period.microgrid_id)
        .maybeSingle<{ id: string; community_id: string }>();
      if (!microgrid) return null;
      const { data: community } = await supabase
        .from("communities")
        .select("id, org_id")
        .eq("id", microgrid.community_id)
        .maybeSingle<{ id: string; org_id: string }>();
      if (!community) return null;
      return { lineItemId: item.id, orgId: community.org_id };
    },

    async loadBillSnapshot(lineItemId: string): Promise<BillSnapshot | null> {
      const { data: item } = await supabase
        .from("billing_line_items")
        .select("id, household_id, total_amount, updated_at, billing_period_id")
        .eq("id", lineItemId)
        .maybeSingle<{
          id: string;
          household_id: string;
          total_amount: number;
          updated_at: string | null;
          billing_period_id: string;
        }>();
      if (!item) return null;
      const { data: period } = await supabase
        .from("billing_periods")
        .select("id, microgrid_id, status, start_date, end_date")
        .eq("id", item.billing_period_id)
        .maybeSingle<{
          id: string;
          microgrid_id: string;
          status: "draft" | "closed";
          start_date: string;
          end_date: string;
        }>();
      if (!period) return null;
      const { data: microgrid } = await supabase
        .from("microgrids")
        .select("id, community_id, currency")
        .eq("id", period.microgrid_id)
        .maybeSingle<{ id: string; community_id: string; currency: string }>();
      if (!microgrid) return null;
      const { data: community } = await supabase
        .from("communities")
        .select("id, org_id")
        .eq("id", microgrid.community_id)
        .maybeSingle<{ id: string; org_id: string }>();
      if (!community) return null;
      const { data: household } = await supabase
        .from("households")
        .select("id, display_name, primary_email, primary_phone")
        .eq("id", item.household_id)
        .maybeSingle<{
          id: string;
          display_name: string;
          primary_email: string | null;
          primary_phone: string | null;
        }>();
      if (!household) return null;
      const parts = household.display_name.trim().split(/\s+/);
      return {
        lineItemId: item.id,
        orgId: community.org_id,
        communityId: microgrid.community_id,
        totalAmount: Number(item.total_amount),
        currency: microgrid.currency || "UGX",
        updatedAt: item.updated_at ?? null,
        periodStatus: period.status,
        contactEmail: household.primary_email,
        contactPhone: household.primary_phone,
        contactFirstName: parts[0] ?? "",
        contactLastName: parts.slice(1).join(" "),
        periodLabel: `${period.start_date} – ${period.end_date}`,
      };
    },

    async resolveMerchantAccount({ orgId, communityId }) {
      // Explicit resolution: override row present → use it (broken errors);
      // absent → org default.
      const { data: override } = await supabase
        .from("community_payment_overrides")
        .select("id, merchant_account_id")
        .eq("community_id", communityId)
        .maybeSingle<{ id: string; merchant_account_id: string | null }>();
      if (override) {
        if (!override.merchant_account_id) {
          return {
            ok: false as const,
            code: "override_broken" as const,
            message:
              "This community has a broken payment override with no merchant account. Fix the override instead of charging the organization default.",
          };
        }
        const { data: account, error } = await supabase
          .from("payment_merchant_accounts")
          .select("*")
          .eq("id", override.merchant_account_id)
          .maybeSingle<Record<string, unknown>>();
        if (error) return { ok: false as const, code: "override_broken" as const, message: error.message };
        if (!account || (account as Record<string, unknown>).org_id !== orgId) {
          return {
            ok: false as const,
            code: "override_broken" as const,
            message: "The community's override account is missing. Fix the override instead of charging another account.",
          };
        }
        if ((account as Record<string, unknown>).disabled === true) {
          return {
            ok: false as const,
            code: "disabled" as const,
            message: "The community's override account is disabled. Reconfigure it to resume checkouts.",
          };
        }
        const secret = await readMerchantSecret(supabase, String((account as Record<string, unknown>).id));
        if (!secret) {
          return {
            ok: false as const,
            code: "override_broken" as const,
            message: "Could not decrypt the override account secret.",
          };
        }
        const pub = toPublic(account as Record<string, unknown>, "community_override", communityId);
        return { ok: true as const, account: { ...pub, secret }, origin: "community_override" as const };
      }
      const { data: account } = await supabase
        .from("payment_merchant_accounts")
        .select("*")
        .eq("org_id", orgId)
        .eq("provider", "pesapal")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle<Record<string, unknown>>();
      if (!account) {
        return { ok: false as const, code: "unconfigured" as const, message: "No Pesapal account configured for this organization." };
      }
      if ((account as Record<string, unknown>).disabled === true) {
        return { ok: false as const, code: "disabled" as const, message: "The organization payment account is disabled." };
      }
      const secret = await readMerchantSecret(supabase, String((account as Record<string, unknown>).id));
      if (!secret) {
        return { ok: false as const, code: "unconfigured" as const, message: "Payment account secret is unavailable." };
      }
      const pub = toPublic(account as Record<string, unknown>, "org_default", null);
      return { ok: true as const, account: { ...pub, secret }, origin: "org_default" as const };
    },

    async loadMerchantAccountPublic({ orgId, communityId }) {
      const { data: override } = await supabase
        .from("community_payment_overrides")
        .select("id, merchant_account_id")
        .eq("community_id", communityId)
        .maybeSingle<{ id: string; merchant_account_id: string | null }>();
      if (override?.merchant_account_id) {
        const { data: account } = await supabase
          .from("payment_merchant_accounts")
          .select("*")
          .eq("id", override.merchant_account_id)
          .maybeSingle<Record<string, unknown>>();
        if (!account) {
          return { ok: true as const, account: null, hasOverride: true };
        }
        return {
          ok: true as const,
          account: toPublic(account as Record<string, unknown>, "community_override", communityId),
          hasOverride: true,
        };
      }
      if (override && !override.merchant_account_id) {
        return { ok: true as const, account: null, hasOverride: true };
      }
      const { data: account } = await supabase
        .from("payment_merchant_accounts")
        .select("*")
        .eq("org_id", orgId)
        .eq("provider", "pesapal")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle<Record<string, unknown>>();
      if (!account) return { ok: true as const, account: null, hasOverride: false };
      return {
        ok: true as const,
        account: toPublic(account as Record<string, unknown>, "org_default", null),
        hasOverride: false,
      };
    },

    async findActiveAttempt({ lineItemId, amount, currency }) {
      const { data } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("line_item_id", lineItemId)
        .in("status", ["pending", "confirmation_pending"])
        .order("created_at", { ascending: false })
        .limit(5);
      const rows = (data ?? []) as unknown as PaymentAttempt[];
      return (
        rows.find(
          (r) =>
            Number(r.amount) === Number(amount) &&
            r.currency === currency &&
            Number(r.bill_revision_total) === Number(amount)
        ) ?? null
      );
    },

    async findBlockedAttempt(lineItemId: string) {
      const { data } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("line_item_id", lineItemId)
        .eq("status", "needs_reconciliation")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<PaymentAttempt>();
      return data ?? null;
    },

    async createAttempt(input) {
      const { data, error } = await supabase
        .from("payment_attempts")
        .insert({
          org_id: input.orgId,
          line_item_id: input.lineItemId,
          community_id: input.communityId,
          merchant_account_id: input.merchantAccountId,
          merchant_account_version: input.merchantAccountVersion,
          amount: input.amount,
          currency: input.currency,
          bill_revision_total: input.billRevisionTotal,
          bill_revision_updated_at: input.billRevisionUpdatedAt,
          merchant_reference: input.merchantReference,
          provider: "pesapal",
          status: "pending",
        })
        .select("*")
        .single();
      if (error) return { attempt: null, error: toError(error) };
      return { attempt: data as unknown as PaymentAttempt, error: null };
    },

    async updateAttemptTracking(input) {
      const { error } = await supabase
        .from("payment_attempts")
        .update({
          provider_tracking_id: input.providerTrackingId,
          checkout_url: input.checkoutUrl,
          ...(input.status ? { status: input.status } : {}),
        })
        .eq("id", input.attemptId);
      return error ? toError(error) : null;
    },

    async markAttemptStatus(input) {
      const { error } = await supabase
        .from("payment_attempts")
        .update({
          status: input.status,
          failure_code: input.failureCode ?? null,
          failure_message: input.failureMessage ?? null,
        })
        .eq("id", input.attemptId);
      return error ? toError(error) : null;
    },

    async getAttempt(attemptId: string) {
      const { data } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("id", attemptId)
        .maybeSingle<PaymentAttempt>();
      return (data as unknown as PaymentAttempt | null) ?? null;
    },

    async listAttemptsForLineItem(lineItemId: string) {
      const { data } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("line_item_id", lineItemId)
        .order("created_at", { ascending: true });
      return ((data ?? []) as unknown as PaymentAttempt[]) ?? [];
    },

    async recordReceipt(input) {
      const { error } = await supabase.from("payment_receipts").insert({
        org_id: input.orgId,
        attempt_id: input.attemptId,
        amount: input.amount,
        currency: input.currency,
        provider: "pesapal",
        provider_status: input.providerStatus,
        provider_tracking_id: input.providerTrackingId,
        confirmation_code: input.confirmationCode,
        payment_method: input.paymentMethod,
        raw_payload: input.rawPayload,
      });
      if (error) {
        // Idempotent duplicate delivery: unique violation means already stored.
        if (error.code === "23505") return { created: false, error: null };
        return { created: false, error: toError(error) };
      }
      return { created: true, error: null };
    },

    async listReceiptsForAttempt(attemptId: string) {
      const { data } = await supabase
        .from("payment_receipts")
        .select("*")
        .eq("attempt_id", attemptId)
        .order("created_at", { ascending: true });
      return ((data ?? []) as unknown as PaymentReceipt[]) ?? [];
    },

    async upsertNotification(input) {
      const { data, error } = await supabase
        .from("payment_notifications")
        .upsert(
          {
            org_id: input.orgId,
            provider: input.provider,
            tracking_id: input.trackingId,
            merchant_reference: input.merchantReference,
            raw_payload: input.rawPayload,
            status: "received",
            next_retry_at: new Date().toISOString(),
          },
          { onConflict: "provider,tracking_id" }
        )
        .select("id")
        .single();
      if (error) return { id: "", error: toError(error) };
      return { id: (data as { id: string }).id, error: null };
    },

    async markNotification(input) {
      if (input.status === "failed") {
        const { data: current } = await supabase
          .from("payment_notifications")
          .select("attempt_count")
          .eq("id", input.id)
          .maybeSingle<{ attempt_count: number }>();
        const nextCount = (current?.attempt_count ?? 0) + 1;
        const { error } = await supabase
          .from("payment_notifications")
          .update({
            status: "failed",
            last_error: input.lastError ?? null,
            processed_attempt_id: input.processedAttemptId ?? null,
            attempt_count: nextCount,
            next_retry_at: new Date(
              Date.now() + (input.retryInSeconds ?? 300) * 1000
            ).toISOString(),
          })
          .eq("id", input.id);
        return error ? toError(error) : null;
      }
      const { error } = await supabase
        .from("payment_notifications")
        .update({
          status: input.status,
          last_error: input.lastError ?? null,
          processed_attempt_id: input.processedAttemptId ?? null,
        })
        .eq("id", input.id);
      return error ? toError(error) : null;
    },

    async dueNotifications(limit: number) {
      const { data, error } = await supabase.rpc("fn_payment_due_notifications", {
        _limit: limit,
      });
      if (error) return [];
      return (data ?? []) as {
        id: string;
        tracking_id: string;
        merchant_reference: string;
        attempt_count: number;
        raw_payload: unknown;
      }[];
    },

    async findAttemptByReference(merchantReference: string) {
      const { data } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("merchant_reference", merchantReference)
        .maybeSingle<PaymentAttempt>();
      return (data as unknown as PaymentAttempt | null) ?? null;
    },

    async findAttemptByTracking(trackingId: string) {
      const { data } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("provider_tracking_id", trackingId)
        .maybeSingle<PaymentAttempt>();
      return (data as unknown as PaymentAttempt | null) ?? null;
    },

    async applyBillPayment(input) {
      const { error } = await supabase.rpc("fn_apply_payment_event", {
        _line_item_id: input.lineItemId,
        _to_status: input.toStatus,
        _source: "ipn",
        _actor_user_id: null,
        _raw_payload: input.rawPayload,
        _actor_kind: "system",
        _actor_ref: input.actorRef,
      });
      return { error: error ? toError(error) : null };
    },

    async reconcileAttempt(input) {
      // Audited reconciliation: mark resolved and record the manager action
      // in payment_events via a manual transition where possible.
      const { error } = await supabase
        .from("payment_attempts")
        .update({
          status: "resolved",
          resolved_by: input.actorUserId,
          resolved_at: new Date().toISOString(),
          resolve_notes: JSON.stringify({
            action: input.action,
            externalReference: input.externalReference ?? null,
            notes: input.notes ?? null,
          }).slice(0, 500),
        })
        .eq("id", input.attemptId);
      return { error: error ? toError(error) : null };
    },
  };
}

async function readMerchantSecret(
  authorizedClient: SupabaseClient,
  accountId: string
): Promise<string | null> {
  // Authorize-then-decrypt (mirrors src/lib/openems/config.ts ordering, which
  // is load-bearing — do not reorder):
  //   1. Read the merchant-account row on the caller's own RLS-evaluated
  //      client. This is the ONLY authorization; cross-org callers exit here.
  //   2. Terminal on no row.
  //   3. Decrypt on the service-role client via the service_role-only
  //      `fn_get_payment_merchant_secret`, which contributes no authorization
  //      of its own. Reuses the existing envelope DEK (same as community
  //      payment secrets) — no new Vault secret.
  const { data: authorizedRow, error: authErr } = await authorizedClient
    .from("payment_merchant_accounts")
    .select("id")
    .eq("id", accountId)
    .maybeSingle<{ id: string }>();
  if (authErr || !authorizedRow) return null;

  const { createServiceClient } = await import("@/lib/supabase/service");
  const { data: secret, error: secretErr } = await createServiceClient().rpc(
    "fn_get_payment_merchant_secret",
    { _account_id: accountId }
  );
  if (secretErr) return null;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

export type { MerchantAccountSecret };
