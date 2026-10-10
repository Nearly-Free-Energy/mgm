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

const ACCOUNT_COLUMNS = "id, org_id, provider, display_name, sandbox, consumer_key, base_url, ipn_id, ipn_url, version, disabled, last_tested_at, last_test_status, last_test_message";

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
  supabase: SupabaseClient,
  writer: SupabaseClient = supabase
): PaymentsRepository {
  return {
    async isPaymentsEnabled(organizationId: string) {
      return isPaymentsEnabled(supabase, organizationId);
    },

    async isPesapalEnabled(organizationId: string) {
      return isPesapalEnabled(supabase, organizationId);
    },

    async getLineItemOrganization(lineItemId: string) {
      const { data: item, error: itemError } = await supabase
        .from("billing_line_items")
        .select("id, billing_period_id")
        .eq("id", lineItemId)
        .maybeSingle<{ id: string; billing_period_id: string }>();
      if (itemError) throw new Error("Could not load bill");
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
      const { data: item, error: itemError } = await supabase
        .from("billing_line_items")
        .select("id, household_id, total_amount, updated_at, payment_status, billing_period_id")
        .eq("id", lineItemId)
        .maybeSingle<{
          id: string;
          household_id: string;
          total_amount: number;
          payment_status: string;
          updated_at: string | null;
          billing_period_id: string;
        }>();
      if (itemError) throw new Error("Could not load bill");
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
        paymentStatus: item.payment_status,
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
      const { data: override, error: overrideError } = await supabase
        .from("community_payment_overrides")
        .select("id, merchant_account_id")
        .eq("community_id", communityId)
        .maybeSingle<{ id: string; merchant_account_id: string | null }>();
      if (overrideError) throw new Error("Could not resolve community payment override");
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
          .select(ACCOUNT_COLUMNS)
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
      const { data: account, error: accountError } = await supabase
        .from("payment_merchant_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("org_id", orgId)
        .eq("provider", "pesapal")
        .eq("is_default", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle<Record<string, unknown>>();
      if (accountError) throw new Error("Could not resolve payment account");
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
      const { data: community, error: scopeError } = await supabase.from("communities").select("id").eq("id", communityId).eq("org_id", orgId).maybeSingle();
      if (scopeError) throw new Error("Could not authorize community");
      if (!community) return { ok: false as const, code: "payments_scope_mismatch", message: "Community not available in this organization." };
      const { data: override, error: overrideError } = await supabase
        .from("community_payment_overrides")
        .select("id, merchant_account_id")
        .eq("community_id", communityId)
        .maybeSingle<{ id: string; merchant_account_id: string | null }>();
      if (overrideError) throw new Error("Could not load community payment override");
      if (override?.merchant_account_id) {
        const { data: account, error: accountError } = await supabase
          .from("payment_merchant_accounts")
          .select(ACCOUNT_COLUMNS)
          .eq("id", override.merchant_account_id)
          .maybeSingle<Record<string, unknown>>();
        if (accountError) throw new Error("Could not load override payment account");
        if (!account || account.org_id !== orgId) {
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
      const { data: account, error: accountError } = await supabase
        .from("payment_merchant_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("org_id", orgId)
        .eq("provider", "pesapal")
        .eq("is_default", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle<Record<string, unknown>>();
      if (accountError) throw new Error("Could not load payment account");
      if (!account) return { ok: true as const, account: null, hasOverride: false };
      return {
        ok: true as const,
        account: toPublic(account as Record<string, unknown>, "org_default", null),
        hasOverride: false,
      };
    },

    async findActiveAttempt({ lineItemId, amount, currency }) {
      const { data, error } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("line_item_id", lineItemId)
        .in("status", ["pending", "confirmation_pending"])
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw new Error("Could not load payment attempts");
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
      const { data, error } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("line_item_id", lineItemId)
        .eq("status", "needs_reconciliation")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<PaymentAttempt>();
      if (error) throw new Error("Could not load blocked attempt");
      return data ?? null;
    },

    async createAttempt(input) {
      const { data, error } = await writer.rpc("fn_payment_reserve_checkout", {
        _org_id: input.orgId, _line_item_id: input.lineItemId, _community_id: input.communityId,
        _account_id: input.merchantAccountId, _account_version: input.merchantAccountVersion,
        _amount: input.amount, _currency: input.currency, _revision: input.billRevisionUpdatedAt,
        _reference: input.merchantReference,
      });
      if (error) return { attempt: null, error: toError(error) };
      return { attempt: data as unknown as PaymentAttempt, error: null };
    },

    async updateAttemptTracking(input) {
      const { error } = await writer
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
      const { error } = await writer
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
      const { data, error } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("id", attemptId)
        .maybeSingle<PaymentAttempt>();
      if (error) throw new Error("Could not load payment attempt");
      return (data as unknown as PaymentAttempt | null) ?? null;
    },

    async listAttemptsForLineItem(lineItemId: string) {
      const { data, error } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("line_item_id", lineItemId)
        .order("created_at", { ascending: true });
      if (error) throw new Error("Could not load payment history");
      return ((data ?? []) as unknown as PaymentAttempt[]) ?? [];
    },

    async recordReceipt(input) {
      const { error } = await writer.from("payment_receipts").insert({
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

    async listExternalAdjustments(lineItemId) {
      const { data, error } = await supabase.from("payment_events").select("at, raw_payload").eq("line_item_id", lineItemId).eq("source", "manual");
      if (error) throw new Error("Could not load payment adjustments");
      return (data ?? []).flatMap(row => {
        const payload = row.raw_payload as Record<string, unknown> | null;
        return payload && typeof payload.external_amount === "number" ? [{ amount: payload.external_amount, reference: typeof payload.reference === "string" ? payload.reference : null, notes: typeof payload.notes === "string" ? payload.notes : null, at: row.at }] : [];
      });
    },

    async listReceiptsForAttempt(attemptId: string) {
      const { data } = await supabase
        .from("payment_receipts")
        .select("id, attempt_id, amount, currency, provider_status, provider_tracking_id, confirmation_code, payment_method, created_at")
        .eq("attempt_id", attemptId)
        .order("created_at", { ascending: true });
      return ((data ?? []) as unknown as PaymentReceipt[]) ?? [];
    },

    async upsertNotification(input) {
      const { data, error } = await writer.rpc("fn_payment_enqueue_notification", {
        _org: input.orgId, _tracking: input.trackingId, _reference: input.merchantReference, _payload: input.rawPayload,
      });
      if (error) return { id: "", error: toError(error) };
      return { id: String(data), error: null };
    },

    async markNotification(input) {
      if (input.status === "failed") {
        const { data: current } = await writer
          .from("payment_notifications")
          .select("attempt_count")
          .eq("id", input.id)
          .maybeSingle<{ attempt_count: number }>();
        const nextCount = (current?.attempt_count ?? 0) + 1;
        const { error } = await writer
          .from("payment_notifications")
          .update({
            status: nextCount >= 12 ? "dead_letter" : "failed",
            last_error: input.lastError ?? null,
            processed_attempt_id: input.processedAttemptId ?? null,
            attempt_count: nextCount,
            next_retry_at: new Date(
              Date.now() + Math.max(input.retryInSeconds ?? 300, Math.min(3600, 60 * 2 ** nextCount)) * 1000
            ).toISOString(),
          })
          .eq("id", input.id);
        return error ? toError(error) : null;
      }
      const { error } = await writer
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
      const { data, error } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("merchant_reference", merchantReference)
        .maybeSingle<PaymentAttempt>();
      if (error) throw new Error("Could not load payment attempt");
      return (data as unknown as PaymentAttempt | null) ?? null;
    },

    async findAttemptByTracking(trackingId: string) {
      const { data, error } = await supabase
        .from("payment_attempts")
        .select("*")
        .eq("provider_tracking_id", trackingId)
        .maybeSingle<PaymentAttempt>();
      if (error) throw new Error("Could not load payment attempt");
      return (data as unknown as PaymentAttempt | null) ?? null;
    },

    async applyBillPayment(input) {
      const { error } = await writer.rpc("fn_apply_payment_event", {
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
      const { error } = await writer.rpc("fn_payment_reconcile", {
        _attempt_id: input.attemptId, _action: input.action,
        _external_amount: input.externalAmount ?? 0, _reference: input.externalReference ?? null,
        _notes: input.notes ?? null, _actor: input.actorUserId,
      });
      return { error: error ? toError(error) : null };
    },
    async loadAttemptAccount(attempt) {
      // Attempt was read with the caller's RLS client before privileged decrypt.
      const { data, error } = await writer.rpc("fn_payment_account_version", {
        _account_id: attempt.merchant_account_id, _version: attempt.merchant_account_version,
        _org_id: attempt.org_id,
      });
      if (error || !data) return null;
      const row = data as Record<string, unknown>;
      return { ...toPublic(row, "community_override", attempt.community_id), secret: String(row.secret) };
    },
    async commitVerification(input) {
      const { error } = await writer.rpc("fn_payment_commit_verification", {
        _attempt_id: input.attemptId, _amount: input.amount, _currency: input.currency,
        _status: input.providerStatus, _tracking: input.trackingId,
        _confirmation: input.confirmationCode, _method: input.paymentMethod, _payload: input.rawPayload,
      });
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
