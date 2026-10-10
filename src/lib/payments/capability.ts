/**
 * PaymentsCapability — typed entry point for the Payments plugin.
 *
 * Import boundary: consumes the repository/provider-factory interfaces only —
 * never a database client, provider SDK, or framework module. See
 * `__tests__/payments-import-boundary.test.ts`.
 */
import "server-only";

import { buildOrderId } from "./pesapal/order-id";
import {
  canReuseAttempt,
  classifyVerification,
  isBlockedForNewCheckout,
  receiptDifference,
  validateReceiptAgainstAttempt,
} from "./reconciliation";
import type {
  BillSnapshot,
  PaymentsCapabilityContract,
  PaymentsRepository,
  PaymentsResult,
  PaymentsScope,
  ProviderFactory,
} from "./repository";
import { snapshotToAttemptOutcome } from "./providers/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function splitName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  if (!trimmed) return { first: "", last: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export class PaymentsCapability implements PaymentsCapabilityContract {
  constructor(
    private readonly repo: PaymentsRepository,
    private readonly scope: PaymentsScope,
    private readonly providers: ProviderFactory,
    private readonly isActive: () => boolean,
    private readonly appUrl: (path: string) => string
  ) {}

  private ensureActive(): Extract<PaymentsResult<never>, { ok: false }> | null {
    if (this.isActive()) return null;
    return {
      ok: false,
      status: 500,
      code: "payments_composition_disposed",
      message: "Payments composition has been disposed.",
    };
  }

  private async requirePlugins(): Promise<Extract<
    PaymentsResult<never>,
    { ok: false }
  > | null> {
    if (!(await this.repo.isPaymentsEnabled(this.scope.organizationId))) {
      return {
        ok: false,
        status: 409,
        code: "payments_disabled",
        message:
          "Payments are disabled for this organization. Enable them in Settings → Plugins; history and reconciliation are preserved.",
      };
    }
    if (!(await this.repo.isPesapalEnabled(this.scope.organizationId))) {
      return {
        ok: false,
        status: 409,
        code: "pesapal_disabled",
        message:
          "The Pesapal provider is disabled for this organization. Enable it in Settings → Plugins; history is preserved.",
      };
    }
    return null;
  }

  private scopeMismatch() {
    return {
      ok: false as const,
      status: 403 as const,
      code: "payments_scope_mismatch",
      message: "Not authorized to act on this organization.",
    };
  }

  async getReadiness(communityId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(communityId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_community",
        message: "Invalid community id — expected UUID.",
      };
    }
    // Reads stay available while plugins are disabled — readiness reports it.
    const loaded = await this.repo.loadMerchantAccountPublic({
      orgId: this.scope.organizationId,
      communityId,
    });
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 500 as const,
        code: "payments_unavailable",
        message: loaded.message,
      };
    }
    const paymentsOn = await this.repo.isPaymentsEnabled(this.scope.organizationId);
    const pesapalOn = await this.repo.isPesapalEnabled(this.scope.organizationId);
    if (!paymentsOn || !pesapalOn) {
      return {
        ok: true as const,
        data: {
          state: "disabled" as const,
          message: "Online payments are disabled. Manual payment recording remains available.",
        },
      };
    }
    const account = loaded.account;
    if (!account) {
      return {
        ok: true as const,
        data: {
          state: "unconfigured" as const,
          message: "No Pesapal account configured. Configure the organization default to share payment links.",
        },
      };
    }
    if (account.disabled) {
      return {
        ok: true as const,
        data: {
          state: "connection_error" as const,
          message: "The configured merchant account is disabled. Reconfigure it to resume checkouts.",
          account,
        },
      };
    }
    if (account.last_test_status && account.last_test_status !== "success") {
      return {
        ok: true as const,
        data: { state: "connection_error" as const, message: account.last_test_message || "Last connection test failed.", account },
      };
    }
    if (account.sandbox) {
      return {
        ok: true as const,
        data: { state: "sandbox" as const, message: "Sandbox account ready. Verify with a test checkout before enabling live.", account },
      };
    }
    return {
      ok: true as const,
      data: { state: "ready" as const, message: "Live account ready.", account },
    };
  }

  async stablePaymentLink(lineItemId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(lineItemId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_line_item",
        message: "Invalid line item id — expected UUID.",
      };
    }
    const resolved = await this.repo.getLineItemOrganization(lineItemId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    // The stable MGM link resolves to the current bill revision at click
    // time; invoices embed this same link. Customers need no MGM account.
    return { ok: true as const, data: { url: this.appUrl(`/api/billing-line-items/${lineItemId}/pay`) } };
  }

  private billToDescription(bill: BillSnapshot): string {
    return `Utility bill for ${bill.periodLabel}`;
  }

  async ensureCheckout(lineItemId: string, input?: { callbackUrl?: string; force?: boolean }) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(lineItemId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_line_item",
        message: "Invalid line item id — expected UUID.",
      };
    }
    const resolved = await this.repo.getLineItemOrganization(lineItemId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugins();
    if (gated) return gated;

    const bill = await this.repo.loadBillSnapshot(lineItemId);
    if (!bill || bill.orgId !== this.scope.organizationId) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "payments_bill_not_found",
        message: "Bill not found.",
      };
    }
    // Draft and closed bills are both payable; nothing else gates here.
    if (!bill.contactEmail && !bill.contactPhone) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_missing_contact",
        message:
          "This household has no email or phone number. Add customer contact information before creating a checkout.",
        field: "contact",
      };
    }
    if (!Number.isFinite(bill.totalAmount) || bill.totalAmount <= 0) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_zero_amount",
        message: "Bill total is 0 — nothing to collect.",
      };
    }

    // Block further automated checkout once a shortfall/overpayment/duplicate
    // needs manager resolution. Never silently settle a mismatched bill.
    const history = await this.repo.listAttemptsForLineItem(lineItemId);
    if (
      input?.force !== true &&
      isBlockedForNewCheckout(
        history.map((h) => ({
          amount: Number(h.amount),
          currency: h.currency,
          bill_revision_total: Number(h.bill_revision_total),
          status: h.status,
        }))
      )
    ) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "payments_needs_reconciliation",
        message:
          "This bill has a payment needing reconciliation. Resolve it before creating another checkout.",
      };
    }

    // Repeated clicks reuse the active attempt while the bill is unchanged.
    if (input?.force !== true) {
      const active = await this.repo.findActiveAttempt({
        lineItemId,
        amount: bill.totalAmount,
        currency: bill.currency,
      });
      if (
        active &&
        canReuseAttempt(
          {
            amount: Number(active.amount),
            currency: active.currency,
            bill_revision_total: Number(active.bill_revision_total),
            status: active.status,
          },
          { amount: bill.totalAmount, currency: bill.currency }
        ) &&
        active.checkout_url
      ) {
        return { ok: true as const, data: { redirectUrl: active.checkout_url, attempt: active, reused: true } };
      }
    }

    // Explicit resolution: community override, otherwise org default. A broken
    // override errors rather than silently charging another account.
    const resolvedAccount = await this.repo.resolveMerchantAccount({
      orgId: this.scope.organizationId,
      communityId: bill.communityId,
    });
    if (!resolvedAccount.ok) {
      const status = resolvedAccount.code === "override_broken" ? 409 : 409;
      return {
        ok: false as const,
        status: status as 409,
        code:
          resolvedAccount.code === "unconfigured"
            ? "payments_not_configured"
            : resolvedAccount.code === "disabled"
              ? "payments_account_disabled"
              : "payments_override_broken",
        message: resolvedAccount.message,
      };
    }

    // Persist an immutable attempt BEFORE contacting the provider.
    const merchantReference = buildOrderId(lineItemId);
    const created = await this.repo.createAttempt({
      orgId: this.scope.organizationId,
      lineItemId,
      communityId: bill.communityId,
      merchantAccountId: resolvedAccount.account.id,
      merchantAccountVersion: resolvedAccount.account.version,
      amount: bill.totalAmount,
      currency: bill.currency,
      billRevisionTotal: bill.totalAmount,
      billRevisionUpdatedAt: bill.updatedAt,
      merchantReference,
    });
    if (created.error || !created.attempt) {
      return {
        ok: false as const,
        status: 500 as const,
        code: "payments_unavailable",
        message: `Could not record payment attempt: ${created.error?.message ?? "unknown error"}.`,
      };
    }

    const provider = await this.providers.forAccount(resolvedAccount.account);
    if (!provider.ok) {
      await this.repo.markAttemptStatus({
        attemptId: created.attempt.id,
        status: "failed",
        failureCode: provider.code,
        failureMessage: provider.message,
      });
      return {
        ok: false as const,
        status: 503 as const,
        code: provider.code,
        message: provider.message,
      };
    }

    const names = splitName(`${bill.contactFirstName} ${bill.contactLastName}`.trim());
    try {
      const checkout = await provider.provider.createCheckout({
        merchantReference,
        amount: bill.totalAmount,
        currency: bill.currency,
        description: this.billToDescription(bill),
        callbackUrl: input?.callbackUrl ?? this.appUrl("/payment/callback"),
        contact: {
          ...(bill.contactEmail ? { email: bill.contactEmail } : {}),
          ...(bill.contactPhone ? { phone: bill.contactPhone } : {}),
          firstName: names.first,
          lastName: names.last,
        },
      });
      await this.repo.updateAttemptTracking({
        attemptId: created.attempt.id,
        providerTrackingId: checkout.providerTrackingId,
        checkoutUrl: checkout.redirectUrl,
      });
      const attempt = (await this.repo.getAttempt(created.attempt.id)) ?? {
        ...created.attempt,
        provider_tracking_id: checkout.providerTrackingId,
        checkout_url: checkout.redirectUrl,
      };
      return { ok: true as const, data: { redirectUrl: checkout.redirectUrl, attempt, reused: false } };
    } catch (err) {
      // Ambiguous provider timeouts become "confirmation pending" — do not
      // blindly submit another charge.
      const message = err instanceof Error ? err.message : String(err);
      const timeout = /timeout|timed out|ETIMEDOUT|EAI_AGAIN|UNREACHABLE/i.test(message);
      await this.repo.markAttemptStatus({
        attemptId: created.attempt.id,
        status: timeout ? "confirmation_pending" : "failed",
        failureCode: timeout ? "confirmation_pending" : "provider_error",
        failureMessage: message.slice(0, 500),
      });
      await this.repo.getAttempt(created.attempt.id).catch(() => null);
      if (timeout) {
        return {
          ok: false as const,
          status: 503 as const,
          code: "payments_confirmation_pending",
          message: "Payment provider timed out. The attempt is saved as confirmation-pending — use Refresh payment status instead of retrying.",
        };
      }
      return {
        ok: false as const,
        status: 502 as const,
        code: "payments_provider_error",
        message,
      };
    }
  }

  async refreshPaymentStatus(attemptId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(attemptId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_attempt",
        message: "Invalid attempt id — expected UUID.",
      };
    }
    const attempt = await this.repo.getAttempt(attemptId);
    if (!attempt || attempt.org_id !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    // History stays readable while plugins are disabled; verification of new
    // state still requires the provider.
    const gated = await this.requirePlugins();
    if (gated) return gated;
    if (!attempt.provider_tracking_id) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "payments_no_tracking",
        message: "This attempt has no provider tracking id yet — nothing to refresh.",
      };
    }
    const bill = await this.repo.loadBillSnapshot(attempt.line_item_id);
    const account = bill
      ? await this.repo.resolveMerchantAccount({
          orgId: this.scope.organizationId,
          communityId: bill.communityId,
        })
      : null;
    // Verification binds to the attempt's original account configuration; if
    // resolution now points elsewhere we still verify against the provider
    // with the resolved secret (credentials rotate, tracking ids do not).
    if (!account || !account.ok) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "payments_not_configured",
        message: account && !account.ok ? account.message : "Payment account not configured.",
      };
    }
    const provider = await this.providers.forAccount(account.account);
    if (!provider.ok) {
      return { ok: false as const, status: 503 as const, code: provider.code, message: provider.message };
    }
    let snapshot;
    try {
      snapshot = await provider.provider.getTransaction(attempt.provider_tracking_id);
    } catch (err) {
      await this.repo.markAttemptStatus({
        attemptId,
        status: "confirmation_pending",
        failureCode: "refresh_failed",
        failureMessage: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false as const,
        status: 502 as const,
        code: "payments_provider_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return this.applySnapshot({ attemptId, snapshot });
  }

  private async applySnapshot(input: {
    attemptId: string;
    snapshot: import("./providers/types").TransactionSnapshot;
  }) {
    const attempt = await this.repo.getAttempt(input.attemptId);
    if (!attempt) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "payments_attempt_not_found",
        message: "Payment attempt not found.",
      };
    }
    const outcome = snapshotToAttemptOutcome(input.snapshot.status);
    if (!outcome) {
      await this.repo.markAttemptStatus({ attemptId: attempt.id, status: "confirmation_pending" });
      const refreshed = (await this.repo.getAttempt(attempt.id)) ?? attempt;
      return {
        ok: true as const,
        data: { attempt: refreshed, receipts: await this.repo.listReceiptsForAttempt(attempt.id) },
      };
    }
    const bill = await this.repo.loadBillSnapshot(attempt.line_item_id);
    const verifiedAmount = input.snapshot.amount ?? Number(attempt.amount);
    const verifiedCurrency = input.snapshot.currency ?? attempt.currency;
    // Validate reference/tracking/amount/currency against the saved attempt.
    const envelopeCheck = validateReceiptAgainstAttempt({
      attempt: {
        merchant_reference: attempt.merchant_reference,
        provider_tracking_id: attempt.provider_tracking_id,
        amount: Number(attempt.amount),
        currency: attempt.currency,
      },
      notification: {
        merchantReference: input.snapshot.merchantReference ?? attempt.merchant_reference,
        trackingId: attempt.provider_tracking_id ?? "",
      },
      verified: { amount: verifiedAmount, currency: verifiedCurrency },
    });
    if (!envelopeCheck.ok) {
      await this.repo.markAttemptStatus({
        attemptId: attempt.id,
        status: "needs_reconciliation",
        failureCode: envelopeCheck.kind,
        failureMessage: `Provider snapshot failed validation: ${envelopeCheck.kind}`,
      });
      const flagged = (await this.repo.getAttempt(attempt.id)) ?? attempt;
      return {
        ok: true as const,
        data: { attempt: flagged, receipts: await this.repo.listReceiptsForAttempt(attempt.id) },
      };
    }
    // Persist the receipt; duplicates/out-of-order notifications must not
    // duplicate receipts or overwrite verified success with stale failure.
    const recorded = await this.repo.recordReceipt({
      orgId: attempt.org_id,
      attemptId: attempt.id,
      amount: verifiedAmount,
      currency: verifiedCurrency,
      providerStatus: input.snapshot.status,
      providerTrackingId: attempt.provider_tracking_id,
      confirmationCode: input.snapshot.confirmationCode ?? null,
      paymentMethod: input.snapshot.paymentMethod ?? null,
      rawPayload: input.snapshot.raw ?? {},
    });
    if (recorded.error) {
      return {
        ok: false as const,
        status: 500 as const,
        code: "payments_unavailable",
        message: `Could not record receipt: ${recorded.error.message}.`,
      };
    }
    const billTotal = bill ? Number(bill.totalAmount) : Number(attempt.amount);
    const classification = classifyVerification({
      attemptAmount: Number(attempt.amount),
      attemptCurrency: attempt.currency,
      verifiedAmount,
      verifiedCurrency,
      billCurrentTotal: billTotal,
    });
    if (classification !== "exact") {
      // Verified payment against an older revision (or provider mismatch) is
      // recorded and flagged — display current/received/difference, never
      // discard or silently settle.
      await this.repo.markAttemptStatus({
        attemptId: attempt.id,
        status: "needs_reconciliation",
        failureCode: classification,
        failureMessage: `Received ${verifiedAmount} vs current ${billTotal} (diff ${receiptDifference(verifiedAmount, billTotal)}).`,
      });
    } else if (outcome === "paid") {
      await this.repo.markAttemptStatus({ attemptId: attempt.id, status: "verified" });
      await this.repo.applyBillPayment({
        lineItemId: attempt.line_item_id,
        toStatus: "paid",
        rawPayload: input.snapshot.raw ?? {},
        actorRef: "payments_refresh",
      });
    } else if (outcome === "failed") {
      await this.repo.markAttemptStatus({ attemptId: attempt.id, status: "failed" });
      await this.repo.applyBillPayment({
        lineItemId: attempt.line_item_id,
        toStatus: "failed",
        rawPayload: input.snapshot.raw ?? {},
        actorRef: "payments_refresh",
      });
    } else {
      await this.repo.markAttemptStatus({ attemptId: attempt.id, status: "reversed" });
      await this.repo.applyBillPayment({
        lineItemId: attempt.line_item_id,
        toStatus: "refunded",
        rawPayload: input.snapshot.raw ?? {},
        actorRef: "payments_refresh",
      });
    }
    const refreshed = (await this.repo.getAttempt(attempt.id)) ?? attempt;
    return {
      ok: true as const,
      data: { attempt: refreshed, receipts: await this.repo.listReceiptsForAttempt(attempt.id) },
    };
  }

  async handleNotification(raw: unknown, input?: { orgId?: string | null }) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    // Persist the receipt before acknowledging; the public IPN route always
    // acks 200 and lets the worker retry failures.
    const parsed = this.parseEnvelope(raw);
    if (!parsed) {
      return { ok: true as const, data: { processed: false, attemptId: null } };
    }
    const attempt = await this.repo.findAttemptByReference(parsed.merchantReference);
    if (!attempt) {
      await this.repo.upsertNotification({
        orgId: input?.orgId ?? null,
        provider: "pesapal",
        trackingId: parsed.trackingId,
        merchantReference: parsed.merchantReference,
        rawPayload: raw ?? {},
      });
      return { ok: true as const, data: { processed: false, attemptId: null } };
    }
    if (attempt.org_id !== this.scope.organizationId && this.scope.userId !== null) {
      return this.scopeMismatch();
    }
    const stored = await this.repo.upsertNotification({
      orgId: attempt.org_id,
      provider: "pesapal",
      trackingId: parsed.trackingId,
      merchantReference: parsed.merchantReference,
      rawPayload: raw ?? {},
    });
    if (stored.error) {
      return {
        ok: false as const,
        status: 500 as const,
        code: "payments_unavailable",
        message: stored.error.message,
      };
    }
    // Idempotent: an already-verified attempt for the same tracking id is
    // not re-applied; receipts dedupe on (attempt, tracking, status).
    if (attempt.status === "verified" || attempt.status === "resolved") {
      await this.repo.markNotification({ id: stored.id, status: "processed", processedAttemptId: attempt.id });
      return { ok: true as const, data: { processed: true, attemptId: attempt.id } };
    }
    // Verify server-side — customer redirects alone never mark a bill paid.
    const bill = await this.repo.loadBillSnapshot(attempt.line_item_id);
    if (!bill) {
      await this.repo.markNotification({ id: stored.id, status: "failed", lastError: "bill_not_found", retryInSeconds: 300 });
      return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
    }
    const account = await this.repo.resolveMerchantAccount({
      orgId: attempt.org_id,
      communityId: bill.communityId,
    });
    if (!account.ok) {
      await this.repo.markNotification({ id: stored.id, status: "failed", lastError: account.message, retryInSeconds: 300 });
      return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
    }
    const provider = await this.providers.forAccount(account.account);
    if (!provider.ok) {
      await this.repo.markNotification({ id: stored.id, status: "failed", lastError: provider.message, retryInSeconds: 300 });
      return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
    }
    try {
      const snapshot = await provider.provider.getTransaction(parsed.trackingId);
      // Bind first-sighting tracking id before validation.
      if (!attempt.provider_tracking_id) {
        await this.repo.updateAttemptTracking({
          attemptId: attempt.id,
          providerTrackingId: parsed.trackingId,
          checkoutUrl: attempt.checkout_url ?? "",
        });
      }
      const applied = await this.applySnapshot({ attemptId: attempt.id, snapshot });
      if (!applied.ok) {
        await this.repo.markNotification({ id: stored.id, status: "failed", lastError: applied.message, retryInSeconds: 300 });
        return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
      }
      await this.repo.markNotification({ id: stored.id, status: "processed", processedAttemptId: attempt.id });
      return { ok: true as const, data: { processed: true, attemptId: attempt.id } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.markNotification({ id: stored.id, status: "failed", lastError: message.slice(0, 500), retryInSeconds: 300 });
      return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
    }
  }

  private parseEnvelope(raw: unknown): { trackingId: string; merchantReference: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const pick = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = rec[key];
        if (typeof value === "string" && value.trim()) return value;
      }
      return null;
    };
    const trackingId = pick("OrderTrackingId", "orderTrackingId", "OrderTrackingID", "trackingId");
    const merchantReference = pick("OrderMerchantReference", "merchantReference", "MerchantReference");
    if (!trackingId || !merchantReference) return null;
    return { trackingId, merchantReference };
  }

  async reconcile(attemptId: string, input: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(attemptId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_attempt",
        message: "Invalid attempt id — expected UUID.",
      };
    }
    if (!this.scope.userId) {
      return {
        ok: false as const,
        status: 401 as const,
        code: "payments_unauthenticated",
        message: "Authentication required.",
      };
    }
    const attempt = await this.repo.getAttempt(attemptId);
    if (!attempt || attempt.org_id !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugins();
    if (gated) return gated;
    if (attempt.status !== "needs_reconciliation") {
      return {
        ok: false as const,
        status: 409 as const,
        code: "payments_nothing_to_reconcile",
        message: "This attempt does not need reconciliation.",
      };
    }
    const rec = (input ?? {}) as Record<string, unknown>;
    const action = rec.action;
    if (action !== "accept_exact" && action !== "record_external") {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_action",
        message: "action must be 'accept_exact' or 'record_external'.",
        field: "action",
      };
    }
    const externalReference =
      typeof rec.externalReference === "string" ? rec.externalReference.trim() : "";
    const notes = typeof rec.notes === "string" ? rec.notes.trim().slice(0, 500) : "";
    if (action === "record_external" && !externalReference) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_action",
        message: "externalReference is required when recording an externally completed balance.",
        field: "externalReference",
      };
    }
    const { error } = await this.repo.reconcileAttempt({
      attemptId,
      action,
      externalReference: externalReference || null,
      notes: notes || null,
      actorUserId: this.scope.userId,
    });
    if (error) {
      return {
        ok: false as const,
        status: 500 as const,
        code: "payments_unavailable",
        message: `Could not reconcile attempt: ${error.message}.`,
      };
    }
    const refreshed = (await this.repo.getAttempt(attemptId)) ?? attempt;
    return { ok: true as const, data: { attempt: refreshed } };
  }

  async listHistory(lineItemId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(lineItemId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_line_item",
        message: "Invalid line item id — expected UUID.",
      };
    }
    const resolved = await this.repo.getLineItemOrganization(lineItemId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    // Reads stay available while plugins are disabled — only scope applies.
    const attempts = await this.repo.listAttemptsForLineItem(lineItemId);
    const receipts: import("./repository").PaymentReceipt[] = [];
    for (const attempt of attempts) {
      receipts.push(...(await this.repo.listReceiptsForAttempt(attempt.id)));
    }
    return { ok: true as const, data: { attempts, receipts } };
  }
}
