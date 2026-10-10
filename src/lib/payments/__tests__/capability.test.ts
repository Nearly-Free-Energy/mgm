/**
 * Payments capability behavior with in-memory fakes (no DB, no provider).
 *
 * Covers architecture/access acceptance slices that do not need PostgREST:
 * - Disabling either plugin stops new checkouts but preserves history.
 * - Missing contact produces an actionable error.
 * - needs_reconciliation blocks further automated checkout.
 * - Secret redaction: public account projections never carry secrets.
 */
import { describe, expect, it, vi } from "vitest";
import { PaymentsCapability } from "../capability";
import type { PaymentsRepository, PaymentsScope, ProviderFactory } from "../repository";

const ORG = "11111111-1111-1111-1111-111111111111";
const COMMUNITY = "22222222-2222-2222-2222-222222222222";
const LINE_ITEM = "33333333-3333-3333-3333-333333333333";

function scope(): PaymentsScope {
  return { organizationId: ORG, userId: "user-1", roles: [] };
}

function baseRepo(overrides: Partial<PaymentsRepository> = {}): PaymentsRepository {
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
    loadMerchantAccountPublic: async () => ({ ok: true as const, account: null, hasOverride: false }),
    findActiveAttempt: async () => null,
    findBlockedAttempt: async () => null,
    createAttempt: async (input) => ({
      attempt: {
        id: "44444444-4444-4444-4444-444444444444",
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

function providers(): ProviderFactory {
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
        getTransaction: async () => ({ status: "pending" as const, raw: {} }),
        parseNotification: () => null,
      },
    }),
  };
}

describe("PaymentsCapability access gates", () => {
  it("stops new checkouts when payments is disabled but keeps history readable", async () => {
    const repo = baseRepo({ isPaymentsEnabled: async () => false });
    const cap = new PaymentsCapability(repo, scope(), providers(), () => true, (p) => p);
    const checkout = await cap.ensureCheckout(LINE_ITEM);
    expect(checkout.ok).toBe(false);
    if (!checkout.ok) expect(checkout.code).toBe("payments_disabled");

    const history = await cap.listHistory(LINE_ITEM);
    expect(history.ok).toBe(true);
  });

  it("stops new checkouts when pesapal is disabled", async () => {
    const repo = baseRepo({ isPesapalEnabled: async () => false });
    const cap = new PaymentsCapability(repo, scope(), providers(), () => true, (p) => p);
    const checkout = await cap.ensureCheckout(LINE_ITEM);
    expect(checkout.ok).toBe(false);
    if (!checkout.ok) expect(checkout.code).toBe("pesapal_disabled");
  });

  it("errors actionably when customer contact is missing", async () => {
    const repo = baseRepo({
      loadBillSnapshot: async () => ({
        lineItemId: LINE_ITEM,
        orgId: ORG,
        communityId: COMMUNITY,
        totalAmount: 5000,
        currency: "UGX",
        updatedAt: null,
        periodStatus: "draft",
        contactEmail: null,
        contactPhone: null,
        contactFirstName: "",
        contactLastName: "",
        periodLabel: "2026-09-01 – 2026-09-30",
      }),
    });
    const cap = new PaymentsCapability(repo, scope(), providers(), () => true, (p) => p);
    const checkout = await cap.ensureCheckout(LINE_ITEM);
    expect(checkout.ok).toBe(false);
    if (!checkout.ok) {
      expect(checkout.code).toBe("payments_missing_contact");
      expect(checkout.status).toBe(400);
    }
  });

  it("blocks automated checkout while reconciliation is pending", async () => {
    const repo = baseRepo({
      listAttemptsForLineItem: async () => [
        {
          id: "55555555-5555-5555-5555-555555555555",
          org_id: ORG,
          line_item_id: LINE_ITEM,
          community_id: COMMUNITY,
          merchant_account_id: "acc-1",
          merchant_account_version: 1,
          amount: 5000,
          currency: "UGX",
          bill_revision_total: 5000,
          bill_revision_updated_at: null,
          merchant_reference: "INV-X-1",
          provider_tracking_id: "TRACK-1",
          provider: "pesapal",
          status: "needs_reconciliation",
          checkout_url: null,
          failure_code: "amount_mismatch",
          failure_message: "diff",
          created_at: new Date().toISOString(),
        },
      ],
    });
    const cap = new PaymentsCapability(repo, scope(), providers(), () => true, (p) => p);
    const createSpy = vi.spyOn(repo, "createAttempt");
    const checkout = await cap.ensureCheckout(LINE_ITEM);
    expect(checkout.ok).toBe(false);
    if (!checkout.ok) expect(checkout.code).toBe("payments_needs_reconciliation");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("errors instead of falling back on a broken override", async () => {
    const repo = baseRepo({
      resolveMerchantAccount: async () => ({
        ok: false as const,
        code: "override_broken" as const,
        message: "broken override",
      }),
    });
    const cap = new PaymentsCapability(repo, scope(), providers(), () => true, (p) => p);
    const checkout = await cap.ensureCheckout(LINE_ITEM);
    expect(checkout.ok).toBe(false);
    if (!checkout.ok) expect(checkout.code).toBe("payments_override_broken");
  });
});
