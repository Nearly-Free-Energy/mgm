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
import { PaymentError } from "../errors";
import { ATTEMPT_NOT_OPEN, type ProviderFactory } from "../repository";
import {
  ATTEMPT,
  COMMUNITY,
  LINE_ITEM,
  ORG,
  attempt,
  baseRepo,
  providers,
  scope,
  verifiedProvider,
} from "./fixtures";

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

describe("PaymentsCapability checkout start failures", () => {
  function failingProvider(error: unknown): ProviderFactory {
    const factory = providers();
    return {
      forAccount: async account => {
        const result = await factory.forAccount(account);
        return result.ok
          ? { ...result, provider: { ...result.provider, createCheckout: async () => { throw error; } } }
          : result;
      },
    };
  }
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const untracked = (createdAt: string) => ({ ...attempt("confirmation_pending"), provider_tracking_id: null, checkout_url: null, created_at: createdAt });

  it("fails the attempt when no order was submitted, so the next tap reserves a fresh one", async () => {
    const repo = baseRepo();
    const mark = vi.spyOn(repo, "markAttemptStatus"); const track = vi.spyOn(repo, "updateAttemptTracking");
    const cap = new PaymentsCapability(repo, scope(), failingProvider(new PaymentError("token refused", "PESAPAL_AUTH_FAILED", 401, undefined, "not_submitted")), () => true, p => p);
    expect(await cap.ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, status: 503, code: "payments_checkout_unavailable" });
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({ attemptId: ATTEMPT, status: "failed", failureCode: "checkout_not_submitted" }));
    expect(mark).not.toHaveBeenCalledWith(expect.objectContaining({ status: "confirmation_pending" }));
    expect(track).not.toHaveBeenCalled();

    repo.listAttemptsForLineItem = async () => [{ ...attempt("failed"), provider_tracking_id: null, checkout_url: null }];
    const create = vi.spyOn(repo, "createAttempt");
    const retried = await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM);
    expect(retried).toMatchObject({ ok: true, data: { reused: false, redirectUrl: "https://pay.example/checkout" } });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an order request that may have arrived", new PaymentError("timed out", "PESAPAL_UNREACHABLE", 503, undefined, "unknown")],
    ["an unclassified error", new Error("socket hang up")],
  ])("holds %s for confirmation instead of failing it", async (_label, error) => {
    const repo = baseRepo(); const mark = vi.spyOn(repo, "markAttemptStatus");
    const cap = new PaymentsCapability(repo, scope(), failingProvider(error), () => true, p => p);
    expect(await cap.ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, code: "payments_confirmation_pending" });
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmation_pending" }));
    expect(mark).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("writes the tracking ID on its own before the checkout URL", async () => {
    const repo = baseRepo(); const track = vi.spyOn(repo, "updateAttemptTracking");
    expect((await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).ok).toBe(true);
    expect(track.mock.calls.map(([input]) => input)).toEqual([
      { attemptId: ATTEMPT, providerTrackingId: "TRACK-1", requireOpen: true },
      { attemptId: ATTEMPT, providerTrackingId: "TRACK-1", checkoutUrl: "https://pay.example/checkout", requireOpen: true },
    ]);
  });

  it("retries a failed tracking write once", async () => {
    const repo = baseRepo();
    const track = vi.spyOn(repo, "updateAttemptTracking").mockResolvedValueOnce({ message: "connection reset" });
    expect((await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).ok).toBe(true);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it("keeps the tracking ID when the checkout URL cannot be saved, so the attempt can be refreshed", async () => {
    const repo = baseRepo(); const mark = vi.spyOn(repo, "markAttemptStatus");
    const track = vi.spyOn(repo, "updateAttemptTracking").mockImplementation(async input => (input.checkoutUrl ? { message: "write failed" } : null));
    expect(await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, code: "payments_confirmation_pending" });
    expect(track).toHaveBeenCalledWith({ attemptId: ATTEMPT, providerTrackingId: "TRACK-1", requireOpen: true });
    expect(track).toHaveBeenCalledTimes(3);
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmation_pending", failureMessage: "Checkout URL could not be persisted" }));
  });

  it("hands out no checkout URL when the attempt was superseded before the tracking write", async () => {
    const repo = baseRepo(); const mark = vi.spyOn(repo, "markAttemptStatus");
    const track = vi.spyOn(repo, "updateAttemptTracking").mockResolvedValue({ code: ATTEMPT_NOT_OPEN, message: "closed" });
    const result = await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM);
    expect(result).toMatchObject({ ok: false, status: 409, code: "payments_checkout_superseded" });
    expect(JSON.stringify(result)).not.toContain("pay.example");
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalledWith(expect.objectContaining({ checkoutUrl: expect.anything() }));
    expect(mark).not.toHaveBeenCalled();
  });

  it("hands out no checkout URL when the attempt is closed between the tracking and URL writes", async () => {
    const repo = baseRepo(); const mark = vi.spyOn(repo, "markAttemptStatus");
    vi.spyOn(repo, "updateAttemptTracking").mockImplementation(async input =>
      input.checkoutUrl ? { code: ATTEMPT_NOT_OPEN, message: "closed" } : null
    );
    const result = await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM);
    expect(result).toMatchObject({ ok: false, status: 409, code: "payments_checkout_superseded" });
    expect(JSON.stringify(result)).not.toContain("pay.example");
    expect(mark).not.toHaveBeenCalled();
  });

  it("holds for confirmation without a URL write when the tracking ID cannot be saved", async () => {
    const repo = baseRepo(); const mark = vi.spyOn(repo, "markAttemptStatus");
    const track = vi.spyOn(repo, "updateAttemptTracking").mockRejectedValue(new Error("network"));
    expect(await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, code: "payments_confirmation_pending" });
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).not.toHaveBeenCalledWith(expect.objectContaining({ checkoutUrl: expect.anything() }));
    expect(mark).toHaveBeenCalledWith(expect.objectContaining({ status: "confirmation_pending", failureMessage: "Checkout tracking ID could not be persisted" }));
  });

  it("supersedes an old attempt that has neither a tracking ID nor a checkout URL", async () => {
    const stale = { ...untracked(minutesAgo(20)), id: "66666666-6666-6666-6666-666666666666" };
    const repo = baseRepo({ listAttemptsForLineItem: async () => [stale] });
    const fail = vi.spyOn(repo, "failUnlinkedAttempt"); const create = vi.spyOn(repo, "createAttempt");
    expect(await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).toMatchObject({ ok: true, data: { reused: false } });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ attemptId: stale.id, failureCode: "checkout_superseded" }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps blocking such an attempt inside the window", async () => {
    const repo = baseRepo({ listAttemptsForLineItem: async () => [untracked(minutesAgo(5))] });
    const fail = vi.spyOn(repo, "failUnlinkedAttempt"); const create = vi.spyOn(repo, "createAttempt");
    expect(await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, code: "payments_confirmation_pending" });
    expect(fail).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it("never supersedes an attempt that has a tracking ID", async () => {
    const repo = baseRepo({ listAttemptsForLineItem: async () => [{ ...untracked(minutesAgo(60)), provider_tracking_id: "TRACK-1" }] });
    const fail = vi.spyOn(repo, "failUnlinkedAttempt"); const create = vi.spyOn(repo, "createAttempt");
    expect(await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, code: "payments_confirmation_pending" });
    expect(fail).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["the write fails", { failed: false, error: { message: "write failed" } }],
    ["another request linked or closed the attempt first", { failed: false, error: null }],
  ])("does not reserve a new checkout when superseding does not apply because %s", async (_label, outcome) => {
    const repo = baseRepo({ listAttemptsForLineItem: async () => [untracked(minutesAgo(20))], failUnlinkedAttempt: async () => outcome });
    const create = vi.spyOn(repo, "createAttempt");
    expect(await new PaymentsCapability(repo, scope(), providers(), () => true, p => p).ensureCheckout(LINE_ITEM)).toMatchObject({ ok: false, code: "payments_confirmation_pending" });
    expect(create).not.toHaveBeenCalled();
  });
});
