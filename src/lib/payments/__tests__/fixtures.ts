/**
 * In-memory fakes for Payments capability tests (no DB, no provider).
 */
import { vi } from "vitest";
import type {
  AttemptStatus,
  MerchantAccountSecret,
  PaymentAttempt,
  PaymentsRepository,
  PaymentsScope,
  ProviderFactory,
} from "../repository";
import type { TransactionSnapshot } from "../providers/types";

export const ORG = "11111111-1111-1111-1111-111111111111";
export const COMMUNITY = "22222222-2222-2222-2222-222222222222";
export const LINE_ITEM = "33333333-3333-3333-3333-333333333333";
export const ATTEMPT = "44444444-4444-4444-4444-444444444444";

export function scope(): PaymentsScope {
  return { organizationId: ORG, userId: "user-1", roles: [] };
}

export function baseRepo(overrides: Partial<PaymentsRepository> = {}): PaymentsRepository {
  return {
    isPaymentsEnabled: async () => true,
    isPesapalEnabled: async () => true,
    getLineItemOrganization: async () => ({ lineItemId: LINE_ITEM, orgId: ORG }),
    loadBillSnapshot: async () => ({
      lineItemId: LINE_ITEM,
      orgId: ORG,
      communityId: COMMUNITY,
      totalAmount: 5000,
      currency: "UGX",
      updatedAt: null,
      paymentStatus: "unpaid",
      periodStatus: "draft",
      contactEmail: "aaron@example.com",
      contactPhone: null,
      contactFirstName: "Aaron",
      contactLastName: "NFE",
      periodLabel: "2026-09-01 – 2026-09-30",
    }),
    resolveMerchantAccount: async () => ({
      ok: true as const,
      origin: "org_default" as const,
      account: {
        id: "acc-1",
        org_id: ORG,
        provider: "pesapal" as const,
        display_name: "Default Pesapal account",
        sandbox: true,
        consumer_key: "key",
        base_url: "https://cybqa.pesapal.com/pesapalv3",
        ipn_id: "ipn-1",
        ipn_url: null,
        version: 1,
        disabled: false,
        last_tested_at: null,
        last_test_status: "success",
        last_test_message: null,
        origin: "org_default" as const,
        community_id: null,
        secret: "shh",
      },
    }),
    loadAttemptAccount: async () => { const account = await baseRepo().resolveMerchantAccount({ orgId: ORG, communityId: COMMUNITY }); return account.ok ? account.account : null; },
    commitVerification: async () => ({ error: null }),
    loadMerchantAccountPublic: async () => ({ ok: true as const, account: null, hasOverride: false }),
    findActiveAttempt: async () => null,
    findBlockedAttempt: async () => null,
    createAttempt: async (input) => ({
      attempt: {
        id: ATTEMPT,
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
        provider_tracking_id: null,
        provider: "pesapal" as const,
        status: "pending" as const,
        checkout_url: null,
        failure_code: null,
        failure_message: null,
        created_at: new Date().toISOString(),
      },
      error: null,
    }),
    updateAttemptTracking: async () => null,
    markAttemptStatus: async () => null,
    getAttempt: async () => null,
    listAttemptsForLineItem: async () => [],
    recordReceipt: async () => ({ created: true, error: null }),
    listExternalAdjustments: async () => [],
    listReceiptsForAttempt: async () => [],
    upsertNotification: async () => ({ id: "notif-1", error: null }),
    markNotification: async () => null,
    dueNotifications: async () => [],
    findAttemptByReference: async () => null,
    findAttemptByTracking: async () => null,
    applyBillPayment: async () => ({ error: null }),
    reconcileAttempt: async () => ({ error: null }),
    ...overrides,
  };
}

export function providers(): ProviderFactory {
  return {
    forAccount: async () => ({
      ok: true as const,
      provider: {
        provider: "pesapal" as const,
        testConnection: async () => ({ ok: true, reason: "success", message: "ok" }),
        createCheckout: async (req) => ({
          redirectUrl: "https://pay.example/checkout",
          providerTrackingId: "TRACK-1",
          merchantReference: req.merchantReference,
        }),
        getTransaction: async () => ({ trackingId: "TRACK-1", status: "pending" as const, raw: {} }),
        parseNotification: () => null,
      },
    }),
  };
}

export function attempt(status: AttemptStatus = "pending"): PaymentAttempt {
  return { id: ATTEMPT, org_id: ORG, line_item_id: LINE_ITEM, community_id: COMMUNITY,
    merchant_account_id: "acc-1", merchant_account_version: 1, amount: 5000, currency: "UGX",
    bill_revision_total: 5000, bill_revision_updated_at: null, merchant_reference: "MGM-test",
    provider_tracking_id: "TRACK-1", provider: "pesapal", status, checkout_url: "https://pay.example/checkout",
    failure_code: null, failure_message: null, created_at: "2026-10-01T00:00:00Z" };
}

/** A provider whose transaction lookup returns completed evidence for `attempt()`. */
export function verifiedProvider(snapshot: Partial<TransactionSnapshot> = {}) {
  const getTransaction = vi.fn(async () => ({ trackingId: "TRACK-1", status: "completed" as const, amount: 5000, currency: "UGX", merchantReference: "MGM-test", raw: {}, ...snapshot }));
  const factory = providers();
  const original = factory.forAccount;
  const forAccount = vi.fn(async (account: MerchantAccountSecret) => {
    const result = await original(account);
    return result.ok ? { ...result, provider: { ...result.provider, getTransaction } } : result;
  });
  return { factory: { forAccount }, getTransaction, forAccount };
}
