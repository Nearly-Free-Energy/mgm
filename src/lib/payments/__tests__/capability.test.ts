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
        getTransaction: async () => ({ trackingId: "TRACK-1", status: "pending" as const, raw: {} }),
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
        paymentStatus: "unpaid",
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

const ATTEMPT = "44444444-4444-4444-4444-444444444444";
function attempt(status: import("../repository").AttemptStatus = "pending"): import("../repository").PaymentAttempt {
  return { id: ATTEMPT, org_id: ORG, line_item_id: LINE_ITEM, community_id: COMMUNITY,
    merchant_account_id: "acc-1", merchant_account_version: 1, amount: 5000, currency: "UGX",
    bill_revision_total: 5000, bill_revision_updated_at: null, merchant_reference: "MGM-test",
    provider_tracking_id: "TRACK-1", provider: "pesapal", status, checkout_url: "https://pay.example/checkout",
    failure_code: null, failure_message: null, created_at: "2026-10-01T00:00:00Z" };
}
function verifiedProvider(snapshot: Partial<import("../providers/types").TransactionSnapshot> = {}) {
  const getTransaction = vi.fn(async () => ({ trackingId: "TRACK-1", status: "completed" as const, amount: 5000, currency: "UGX", merchantReference: "MGM-test", raw: {}, ...snapshot }));
  const factory = providers();
  const original = factory.forAccount;
  const forAccount = vi.fn(async (account: import("../repository").MerchantAccountSecret) => {
    const result = await original(account);
    return result.ok ? { ...result, provider: { ...result.provider, getTransaction } } : result;
  });
  return { factory: { forAccount }, getTransaction, forAccount };
}

describe("PaymentsCapability verified payment regressions", () => {
  it.each(["pending", "confirmation_pending"] as const)("never resubmits a %s attempt without a checkout URL, even with force", async status => {
    const saved = { ...attempt(status), checkout_url: null };
    const repo = baseRepo({ listAttemptsForLineItem: async () => [saved] });
    const create = vi.spyOn(repo, "createAttempt");
    const cap = new PaymentsCapability(repo, scope(), providers(), () => true, p => p);
    expect((await cap.ensureCheckout(LINE_ITEM, { force: true })).ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["verified", "resolved", "reversed"] as const)("does not charge again after %s", async status => {
    const repo = baseRepo({ listAttemptsForLineItem: async () => [attempt(status)] });
    const create = vi.spyOn(repo, "createAttempt");
    expect((await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
  it("blocks manually paid bills without requiring online history", async () => {
    const repo = baseRepo(); const bill = await repo.loadBillSnapshot(LINE_ITEM);
    repo.loadBillSnapshot = async () => ({ ...bill!, paymentStatus: "paid" });
    const create = vi.spyOn(repo, "createAttempt");
    const result = await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM);
    expect(result).toMatchObject({ ok: false, code: "payments_already_settled" }); expect(create).not.toHaveBeenCalled();
  });
  it("reuses an unchanged checkout and cannot force a second one", async () => {
    const saved = attempt();
    const repo = baseRepo({ listAttemptsForLineItem: async () => [saved], findActiveAttempt: async () => saved });
    const create = vi.spyOn(repo, "createAttempt");
    const result = await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM, { force: true });
    expect(result).toMatchObject({ ok: true, data: { reused: true } }); expect(create).not.toHaveBeenCalled();
  });
  it("blocks old revision checkout reuse", async () => {
    const saved = { ...attempt(), bill_revision_updated_at: "2026-09-01T00:00:00Z" };
    const repo = baseRepo({ listAttemptsForLineItem: async () => [saved] });
    expect(await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, code: "payments_confirmation_pending" });
  });
  it("does not acknowledge a notification when its accounting transaction fails", async () => {
    const saved = attempt(); const repo = baseRepo({ getAttempt: async () => saved, findAttemptByReference: async () => saved,
      commitVerification: async () => ({ error: { message: "permission denied" } }) });
    const mark = vi.spyOn(repo, "markNotification"); const provider = verifiedProvider();
    const cap = new PaymentsCapability(repo, scope(), provider.factory, () => true, p => p);
    expect(await cap.handleNotification({ OrderTrackingId: "TRACK-1", OrderMerchantReference: "MGM-test" })).toMatchObject({ ok: true, data: { processed: false } });
    expect(mark).not.toHaveBeenCalledWith(expect.objectContaining({ status: "processed" }));
  });
  it("queries verified payments again so provider reversals are recorded", async () => {
    const saved = attempt("verified"); const repo = baseRepo({ getAttempt: async () => saved, findAttemptByReference: async () => saved });
    const commit = vi.spyOn(repo, "commitVerification"); const provider = verifiedProvider({ status: "reversed" });
    await new PaymentsCapability(repo, scope(), provider.factory, () => true, p => p).handleNotification({ OrderTrackingId: "TRACK-1", OrderMerchantReference: "MGM-test" });
    expect(provider.getTransaction).toHaveBeenCalledWith("TRACK-1"); expect(commit).toHaveBeenCalledWith(expect.objectContaining({ providerStatus: "reversed" }));
  });
  it("refreshes using the saved account version even while plugins are disabled", async () => {
    const saved = attempt(); const repo = baseRepo({ getAttempt: async () => saved, isPaymentsEnabled: async () => false, isPesapalEnabled: async () => false });
    const load = vi.spyOn(repo, "loadAttemptAccount"); const resolve = vi.spyOn(repo, "resolveMerchantAccount"); const provider = verifiedProvider();
    expect((await new PaymentsCapability(repo, scope(), provider.factory, () => true, p => p).refreshPaymentStatus(ATTEMPT)).ok).toBe(true);
    expect(load).toHaveBeenCalledWith(saved); expect(resolve).not.toHaveBeenCalled();
  });
  it.each([{ amount: undefined }, { currency: undefined }, { merchantReference: undefined }])("rejects incomplete provider evidence %j", async missing => {
    const repo = baseRepo({ getAttempt: async () => attempt() }); const commit = vi.spyOn(repo, "commitVerification"); const provider = verifiedProvider(missing);
    expect(await new PaymentsCapability(repo, scope(), provider.factory, () => true, p => p).refreshPaymentStatus(ATTEMPT)).toMatchObject({ ok: false, code: "payments_incomplete_evidence" }); expect(commit).not.toHaveBeenCalled();
  });
  it("rejects a forged tracking identity before querying the provider", async () => {
    const saved = attempt(); const repo = baseRepo({ findAttemptByReference: async () => saved }); const provider = verifiedProvider();
    expect((await new PaymentsCapability(repo, scope(), provider.factory, () => true, p => p).handleNotification({ OrderTrackingId: "OTHER", OrderMerchantReference: "MGM-test" })).ok).toBe(false);
    expect(provider.getTransaction).not.toHaveBeenCalled();
  });
  it("does not bind a first tracking identity without matching server reference", async () => {
    const saved = { ...attempt(), provider_tracking_id: null }; const repo = baseRepo({ findAttemptByReference: async () => saved });
    const bind = vi.spyOn(repo, "updateAttemptTracking"); const provider = verifiedProvider({ merchantReference: "WRONG" });
    await new PaymentsCapability(repo, scope(), provider.factory, () => true, p => p).handleNotification({ OrderTrackingId: "TRACK-1", OrderMerchantReference: "MGM-test" }); expect(bind).not.toHaveBeenCalled();
  });
  it("keeps already verified state when an upstream refresh fails", async () => {
    const repo = baseRepo({ getAttempt: async () => attempt("verified") }); const mark = vi.spyOn(repo, "markAttemptStatus"); const provider = verifiedProvider();
    provider.getTransaction.mockRejectedValueOnce(new Error("network failure"));
    expect((await new PaymentsCapability(repo, scope(), provider.factory, () => true, p => p).refreshPaymentStatus(ATTEMPT)).ok).toBe(false); expect(mark).not.toHaveBeenCalled();
  });
  it("requires an actual signed external adjustment with reference and notes", async () => {
    const repo = baseRepo({ getAttempt: async () => attempt("needs_reconciliation"), isPaymentsEnabled: async () => false });
    const reconcile = vi.spyOn(repo, "reconcileAttempt"); const cap = new PaymentsCapability(repo, scope(), providers(), () => true, p => p);
    expect((await cap.reconcile(ATTEMPT, { action: "record_external", externalReference: "receipt" })).ok).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    expect((await cap.reconcile(ATTEMPT, { action: "record_external", externalAmount: -500, externalReference: "refund", notes: "Completed externally" })).ok).toBe(true);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ externalAmount: -500, actorUserId: "user-1" }));
  });
});
