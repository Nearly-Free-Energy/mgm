/**
 * PaymentsCapability — typed entry point for the Payments plugin.
 *
 * Import boundary: consumes the repository/provider-factory interfaces only —
 * never a database client, provider SDK, or framework module. See
 * `__tests__/payments-import-boundary.test.ts`.
 */
import "server-only";

import {
  canReuseAttempt,
  isBlockedForNewCheckout,
  isSupersedableAttempt,
  validateReceiptAgainstAttempt,
} from "./reconciliation";
import type {
  AttentionAttempt,
  BillSnapshot,
  PaymentsCapabilityContract,
  PaymentsRepository,
  PaymentsResult,
  PaymentsScope,
  ProviderFactory,
  RepositoryError,
} from "./repository";
import { ATTEMPT_NOT_OPEN, CHECKOUT_NOT_SUBMITTED, MAX_ATTENTION_ATTEMPTS } from "./repository";
import { checkoutWasNotSubmitted, snapshotToAttemptOutcome } from "./providers/types";
import type { CheckoutResult } from "./providers/types";
import { stablePaymentLinkPath } from "./payment-link";
import { RECONCILE_COPY } from "./schemas";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** getReadiness's refusal when a plugin's state could not be read: fixed copy, never the read's error. */
export const READINESS_UNREADABLE = "Could not check whether online payments are turned on. Try again shortly.";

/**
 * Failure codes this class writes for its own bookkeeping, which listAttention
 * leaves out of failures: a checkout replaced by a newer one before it
 * reached the provider (ensureCheckout), and one the provider never
 * accepted, which the customer is told to retry (ensureCheckout). No money
 * moved in either, and a manager has nothing to do about the bill. If either
 * code starts meaning a payment the customer made, or another bookkeeping
 * code is written, revisit.
 *
 * Only CHECKOUT_NOT_SUBMITTED can be asked for on its own (`failureCode`):
 * one says nothing, but several in a day point at the payment account, which
 * the `payments.not-submitted` watcher reports
 * (./surface/attention-signals.ts).
 */
const BOOKKEEPING_FAILURES = ["checkout_superseded", CHECKOUT_NOT_SUBMITTED] as const;

type AttentionQuery = { status: AttentionAttempt["status"]; since?: string; failureCode?: typeof CHECKOUT_NOT_SUBMITTED };

/** listAttention's input, or null when it is not one. */
function attentionQuery(input: unknown): AttentionQuery | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const { status, since, failureCode, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (status === "needs_reconciliation") return since === undefined && failureCode === undefined ? { status } : null;
  if (status !== "failed" || typeof since !== "string" || since.length > 40) return null;
  if (failureCode !== undefined && failureCode !== CHECKOUT_NOT_SUBMITTED) return null;
  const at = Date.parse(since);
  if (Number.isNaN(at)) return null;
  return { status, since: new Date(at).toISOString(), ...(failureCode === undefined ? {} : { failureCode }) };
}

function splitName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  if (!trimmed) return { first: "", last: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** A name with its outer whitespace removed and inner runs collapsed to one space. */
const sameSpacing = (s: string) => s.trim().split(/\s+/).filter(Boolean).join(" ");

/**
 * fn_payment_reconcile's refusals as fixed copy, so a person never reads a
 * database message. Matches its RAISE texts and its 42501 actor check
 * (20261010202643_payments_integrity.sql, its only definition); if they
 * change, revisit. Anything else is a 500 with no detail.
 */
function reconcileRefusal(error: RepositoryError) {
  const refuse = (status: 403 | 409 | 500, code: string, message: string) => ({ ok: false as const, status, code, message });
  if (error.code === "42501") return refuse(403, "payments_scope_mismatch", RECONCILE_COPY.forbidden);
  const text = error.message.toLowerCase();
  if (text.includes("nothing to reconcile")) return refuse(409, "payments_nothing_to_reconcile", RECONCILE_COPY.notNeeded);
  if (text.includes("unknown submission outcome")) return refuse(409, "payments_unknown_outcome", RECONCILE_COPY.unknownOutcome);
  if (text.includes("mixed receipt currencies")) return refuse(409, "payments_mixed_currencies", RECONCILE_COPY.mixed);
  if (text.includes("receipts are not exact settlement")) return refuse(409, "payments_not_exact", RECONCILE_COPY.notExact);
  if (text.includes("must exactly reconcile")) return refuse(409, "payments_adjustment_inexact", RECONCILE_COPY.adjustmentInexact);
  return refuse(500, "payments_unavailable", RECONCILE_COPY.unavailable);
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

  /**
   * New checkouts only; every other method stays available while the
   * plugins are off (`__tests__/capability-gating.test.ts`). An unreadable
   * state fails closed with the gate's 503 code and wording (`checkGate`,
   * src/lib/runtime/gate.ts); if the gate's wording changes, change it here.
   * The 503 relies on the repository rejecting when it cannot read the
   * state, as the Supabase repository does through `isPluginEnabledForOrg`.
   * A repository that turns a failed read into `false` answers 409
   * `payments_disabled` instead; the gating test runs the real one.
   */
  private async requirePlugins(): Promise<Extract<
    PaymentsResult<never>,
    { ok: false }
  > | null> {
    let paymentsOn: boolean;
    let pesapalOn: boolean;
    try {
      paymentsOn = await this.repo.isPaymentsEnabled(this.scope.organizationId);
      pesapalOn = paymentsOn && (await this.repo.isPesapalEnabled(this.scope.organizationId));
    } catch {
      return {
        ok: false,
        status: 503,
        code: "payments_gate_unavailable",
        message: "Could not verify whether Payments is enabled. Retry the request.",
      };
    }
    if (!paymentsOn) {
      return {
        ok: false,
        status: 409,
        code: "payments_disabled",
        message:
          "Payments are disabled for this organization. Enable them in Settings → Plugins; history is preserved, and verification and reconciliation stay available.",
      };
    }
    if (!pesapalOn) {
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
    // The account and both plugin states are independent reads, so they load
    // together; the results are still applied in the order below.
    const [loaded, paymentsOn, pesapalOn] = await Promise.all([
      this.repo.loadMerchantAccountPublic({
        orgId: this.scope.organizationId,
        communityId,
      }),
      // null: the state could not be read (the repository rejects then).
      this.repo.isPaymentsEnabled(this.scope.organizationId).catch(() => null),
      this.repo.isPesapalEnabled(this.scope.organizationId).catch(() => null),
    ]);
    if (!loaded.ok) {
      return {
        ok: false as const,
        status: 500 as const,
        code: "payments_unavailable",
        message: loaded.message,
      };
    }
    // Either plugin read as off is off, whatever the other read did. A state
    // that could not be read, with neither read as off, is not an answer:
    // saying "disabled" would tell a manager payments are turned off when
    // they may not be. The invoice PDF route, the billing period page and
    // the send queue offer a payment link only for an answer of
    // `ready`/`sandbox`, and treat a refusal as no link, so they render
    // without one; the send queue says it could not check. If a caller
    // starts failing on a refusal here, revisit.
    if (paymentsOn !== false && pesapalOn !== false && (paymentsOn === null || pesapalOn === null)) {
      return {
        ok: false as const,
        status: 503 as const,
        code: "payments_unavailable",
        message: READINESS_UNREADABLE,
      };
    }
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
          state: (loaded.hasOverride ? "connection_error" : "unconfigured") as "connection_error" | "unconfigured",
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
    if (account.last_test_status !== "success" || !account.ipn_id) {
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
    return { ok: true as const, data: { url: this.appUrl(stablePaymentLinkPath(lineItemId)) } };
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
    if (bill.paymentStatus === "paid" || bill.paymentStatus === "refunded") {
      return { ok: false as const, status: 409 as const, code: "payments_already_settled", message: "This bill is already settled. Ask the manager to reconcile any balance." };
    }
    // Draft and closed bills are payable.
    if (!bill.contactEmail && !bill.contactPhone) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_missing_contact",
        message:
          "This tenant has no email or phone number. Add customer contact information before creating a checkout.",
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

    if (history.some(h => ["verified", "resolved", "reversed"].includes(h.status))) {
      return { ok: false as const, status: 409 as const, code: "payments_needs_reconciliation", message: "A receipt already exists for this bill. Reconcile its balance before collecting again." };
    }
    // An open attempt that never recorded a checkout URL or tracking ID
    // cannot collect payment; once old enough, fail it so this checkout can
    // replace it (`isSupersedableAttempt`). The write is conditional, so an
    // attempt another request has linked or closed since it was read stays.
    const now = Date.now();
    const superseded = history.filter(h => isSupersedableAttempt(h, now));
    for (const stale of superseded) {
      const { failed, error } = await this.repo.failUnlinkedAttempt({
        attemptId: stale.id,
        failureCode: "checkout_superseded",
        failureMessage: "No checkout URL or tracking ID was recorded; replaced by a new checkout.",
      });
      if (error || !failed) {
        return { ok: false as const, status: 409 as const, code: "payments_confirmation_pending", message: "An existing checkout may still collect payment. Refresh its status; do not submit another payment." };
      }
    }
    const remaining = history.filter(h => !superseded.includes(h));
    if (remaining.some(h => ["pending", "confirmation_pending"].includes(h.status) && (!h.checkout_url || Number(h.amount) !== bill.totalAmount || h.bill_revision_updated_at !== bill.updatedAt))) {
      return { ok: false as const, status: 409 as const, code: "payments_confirmation_pending", message: "An existing checkout may still collect payment. Refresh its status; do not submit another payment." };
    }
    // Repeated clicks reuse the active attempt while the bill is unchanged.
    {
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
      return {
        ok: false as const,
        status: 409 as const,
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
    const merchantReference = `MGM-${crypto.randomUUID()}`;
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
        status: (created.error?.code === "P0001" ? 409 : 500) as 409 | 500,
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

    const attemptId = created.attempt.id;
    const names = splitName(`${bill.contactFirstName} ${bill.contactLastName}`.trim());
    let checkout: CheckoutResult;
    try {
      checkout = await provider.provider.createCheckout({
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (checkoutWasNotSubmitted(err)) {
        // No order exists at the provider, so nothing can collect against
        // this attempt; failing it lets the next tap reserve a fresh one.
        await this.repo.markAttemptStatus({
          attemptId,
          status: "failed",
          failureCode: CHECKOUT_NOT_SUBMITTED,
          failureMessage: message.slice(0, 500),
        });
        return {
          ok: false as const, status: 503 as const, code: "payments_checkout_unavailable",
          message: "Online payment is unavailable right now. Try again in a few minutes.",
        };
      }
      return this.holdForConfirmation(attemptId, message);
    }
    // The tracking ID is written first and on its own, so refresh and the
    // worker can follow the order even when the checkout URL write fails.
    // Both writes require the attempt to be still open: a request that took
    // longer than the supersede window may find its attempt already replaced
    // by a newer checkout, and must not hand out a second payable URL.
    const tracked = await this.writeWithRetry(() =>
      this.repo.updateAttemptTracking({
        attemptId,
        providerTrackingId: checkout.providerTrackingId,
        requireOpen: true,
      })
    );
    if (tracked === "closed") return this.checkoutSuperseded();
    if (tracked === "failed") return this.holdForConfirmation(attemptId, "Checkout tracking ID could not be persisted");
    const linked = await this.writeWithRetry(() =>
      this.repo.updateAttemptTracking({
        attemptId,
        providerTrackingId: checkout.providerTrackingId,
        checkoutUrl: checkout.redirectUrl,
        requireOpen: true,
      })
    );
    if (linked === "closed") return this.checkoutSuperseded();
    if (linked === "failed") return this.holdForConfirmation(attemptId, "Checkout URL could not be persisted");
    const attempt = (await this.repo.getAttempt(attemptId).catch(() => null)) ?? {
      ...created.attempt,
      provider_tracking_id: checkout.providerTrackingId,
      checkout_url: checkout.redirectUrl,
    };
    return { ok: true as const, data: { redirectUrl: checkout.redirectUrl, attempt, reused: false } };
  }

  /**
   * Ambiguous provider outcomes become "confirmation pending" — do not
   * blindly submit another charge. A tracking ID already written stays, so
   * the attempt can still be refreshed and polled.
   */
  private async holdForConfirmation(attemptId: string, message: string) {
    await this.repo.markAttemptStatus({
      attemptId,
      status: "confirmation_pending",
      failureCode: "confirmation_pending",
      failureMessage: message.slice(0, 500),
    });
    return {
      ok: false as const, status: 503 as const, code: "payments_confirmation_pending",
      message: "Checkout confirmation is pending. Refresh the saved attempt before trying again.",
    };
  }

  /**
   * This request's attempt was closed while the provider call was running:
   * another checkout superseded it, or it settled. Nothing is written and no
   * checkout URL is returned; the next tap finds the current attempt.
   */
  private checkoutSuperseded() {
    return {
      ok: false as const, status: 409 as const, code: "payments_checkout_superseded",
      message: "This checkout was replaced by a newer one. Open the payment link again.",
    };
  }

  /**
   * Runs a repository write, retrying once; a throw counts as a failure.
   * "closed" means the write found the attempt no longer open, which a retry
   * cannot change.
   */
  private async writeWithRetry(
    write: () => Promise<RepositoryError | null>
  ): Promise<"written" | "closed" | "failed"> {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const error = await write();
        if (!error) return "written";
        if (error.code === ATTEMPT_NOT_OPEN) return "closed";
      } catch {
        // Counted as a failed write.
      }
    }
    return "failed";
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
    if (!attempt.provider_tracking_id) {
      return { ok: false as const, status: 409 as const, code: "payments_no_tracking", message: "Submission outcome is unknown. Await provider notification or investigate this reference with the provider; do not resubmit." };
    }
    const original = await this.repo.loadAttemptAccount(attempt);
    if (!original) return { ok: false as const, status: 409 as const, code: "payments_not_configured", message: "The original merchant account version is unavailable." };
    const account = { account: original };
    const provider = await this.providers.forAccount(account.account);
    if (!provider.ok) {
      return { ok: false as const, status: 503 as const, code: provider.code, message: provider.message };
    }
    let snapshot;
    try {
      snapshot = await provider.provider.getTransaction(attempt.provider_tracking_id);
    } catch {
      return {
        ok: false as const,
        status: 502 as const,
        code: "payments_provider_error",
        message: "Provider verification is unavailable. Please try refreshing later.",
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
    // The receipts a refresh answers with. The snapshot is already applied
    // by then, so a failed read of them answers none rather than turning the
    // applied refresh into an error; the next listHistory reads them again,
    // and throws if that read fails too.
    const receiptsAfter = () => this.repo.listReceiptsForAttempt(attempt.id).catch(() => [] as import("./repository").PaymentReceipt[]);
    const outcome = snapshotToAttemptOutcome(input.snapshot.status);
    if (!outcome) {
      if (["pending", "confirmation_pending"].includes(attempt.status)) await this.repo.markAttemptStatus({ attemptId: attempt.id, status: "confirmation_pending" });
      const refreshed = (await this.repo.getAttempt(attempt.id)) ?? attempt;
      return {
        ok: true as const,
        data: { attempt: refreshed, receipts: await receiptsAfter() },
      };
    }
    const verifiedAmount = input.snapshot.amount;
    const verifiedCurrency = input.snapshot.currency;
    if (typeof verifiedAmount !== "number" || !Number.isFinite(verifiedAmount) || !verifiedCurrency || !input.snapshot.merchantReference || !attempt.provider_tracking_id) {
      return { ok: false as const, status: 502 as const, code: "payments_incomplete_evidence", message: "Provider verification omitted required payment evidence." };
    }
    const envelopeCheck = validateReceiptAgainstAttempt({
      attempt: { merchant_reference: attempt.merchant_reference, provider_tracking_id: attempt.provider_tracking_id, amount: Number(attempt.amount), currency: attempt.currency },
      notification: { merchantReference: input.snapshot.merchantReference, trackingId: input.snapshot.trackingId },
      verified: { amount: verifiedAmount, currency: verifiedCurrency },
    });
    if (!envelopeCheck.ok && !["amount_mismatch", "currency_mismatch"].includes(envelopeCheck.kind)) {
      return { ok: false as const, status: 502 as const, code: "payments_invalid_evidence", message: "Provider verification does not match the saved checkout." };
    }
    const committed = await this.repo.commitVerification({
      attemptId: attempt.id, amount: verifiedAmount, currency: verifiedCurrency,
      providerStatus: input.snapshot.status, trackingId: attempt.provider_tracking_id,
      confirmationCode: input.snapshot.confirmationCode ?? null, paymentMethod: input.snapshot.paymentMethod ?? null, rawPayload: input.snapshot.raw,
    });
    if (committed.error) return { ok: false as const, status: 500 as const, code: "payments_unavailable", message: "Could not persist verified payment. It will be retried." };
    const refreshed = (await this.repo.getAttempt(attempt.id)) ?? attempt;
    return {
      ok: true as const,
      data: { attempt: refreshed, receipts: await receiptsAfter() },
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
      const stored = await this.repo.upsertNotification({
        orgId: input?.orgId ?? null,
        provider: "pesapal",
        trackingId: parsed.trackingId,
        merchantReference: parsed.merchantReference,
        rawPayload: raw ?? {},
      });
      if (stored.error) return { ok: false as const, status: 500 as const, code: "payments_unavailable", message: "Could not persist notification" };
      return { ok: true as const, data: { processed: false, attemptId: null } };
    }
    if (attempt.org_id !== this.scope.organizationId) {
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
    if (attempt.org_id !== this.scope.organizationId || (attempt.provider_tracking_id && attempt.provider_tracking_id !== parsed.trackingId)) {
      await this.repo.markNotification({ id: stored.id, status: "failed", lastError: "tracking_mismatch", retryInSeconds: 3600 });
      return { ok: false as const, status: 422 as const, code: "payments_invalid_notification", message: "Notification identity mismatch." };
    }
    const original = await this.repo.loadAttemptAccount(attempt);
    if (!original) {
      await this.repo.markNotification({ id: stored.id, status: "failed", lastError: "original_account_unavailable", retryInSeconds: 300 });
      return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
    }
    const account = { account: original };
    const provider = await this.providers.forAccount(account.account);
    if (!provider.ok) {
      await this.repo.markNotification({ id: stored.id, status: "failed", lastError: provider.message, retryInSeconds: 300 });
      return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
    }
    try {
      const snapshot = await provider.provider.getTransaction(parsed.trackingId);
      if (snapshot.merchantReference !== attempt.merchant_reference || snapshot.trackingId !== parsed.trackingId || typeof snapshot.amount !== "number" || !Number.isFinite(snapshot.amount) || !snapshot.currency) {
        throw new Error("Provider evidence does not match the saved checkout");
      }
      // Bind only after the server-returned evidence matches the reference.
      if (!attempt.provider_tracking_id) {
        const error = await this.repo.updateAttemptTracking({
          attemptId: attempt.id,
          providerTrackingId: parsed.trackingId,
          checkoutUrl: attempt.checkout_url ?? "",
        });
        if (error) throw new Error("Could not bind verified tracking identity");
      }
      const applied = await this.applySnapshot({ attemptId: attempt.id, snapshot });
      if (!applied.ok) {
        await this.repo.markNotification({ id: stored.id, status: "failed", lastError: applied.message, retryInSeconds: 300 });
        return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
      }
      if (["pending", "confirmation_pending"].includes(applied.data.attempt.status)) {
        await this.repo.markNotification({ id: stored.id, status: "failed", lastError: "confirmation_pending", retryInSeconds: 300 });
        return { ok: true as const, data: { processed: false, attemptId: attempt.id } };
      }
      const notificationError = await this.repo.markNotification({ id: stored.id, status: "processed", processedAttemptId: attempt.id });
      if (notificationError) throw new Error("Could not acknowledge persisted verification");
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
    if (attempt.status !== "needs_reconciliation") {
      return {
        ok: false as const,
        status: 409 as const,
        code: "payments_nothing_to_reconcile",
        message: RECONCILE_COPY.notNeeded,
      };
    }
    // These checks are for callers other than the reconcile route, which
    // parses ReconcileAttemptBody first (./schemas.ts): that refuses every
    // body they would refuse, and the route passes on only { error, reason }
    // of a refusal, not its field.
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
    if (action === "accept_exact" && rec.externalAmount !== undefined && rec.externalAmount !== 0) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_accept_takes_no_amount",
        message: RECONCILE_COPY.acceptNoAmount,
        field: "externalAmount",
      };
    }
    if (action === "record_external") {
      // The first missing field, in the order RecordAdjustmentBody lists them.
      const amountOk = typeof rec.externalAmount === "number" && Number.isFinite(rec.externalAmount);
      const missing = !amountOk ? "externalAmount" : !externalReference ? "externalReference" : !notes ? "notes" : null;
      if (missing) {
        return {
          ok: false as const,
          status: 400 as const,
          code: "payments_invalid_action",
          message: RECONCILE_COPY.adjustmentFields,
          field: missing,
        };
      }
    }
    if (action === "record_external") {
      // A completed adjustment records an amount from outside MGM, so the
      // person types the tenant's name, as a refund asks (the
      // payments.record-adjustment action's typed confirmation; the legacy
      // payment history dialog asks for it too).
      const confirmation = rec.confirmation as { typed?: unknown } | undefined;
      const typed = typeof confirmation?.typed === "string" ? sameSpacing(confirmation.typed) : "";
      if (typed === "") {
        return { ok: false as const, status: 428 as const, code: "payments_reconcile_name_required", message: RECONCILE_COPY.nameRequired };
      }
      let bill: BillSnapshot | null;
      try {
        bill = await this.repo.loadBillSnapshot(attempt.line_item_id);
      } catch {
        return { ok: false as const, status: 500 as const, code: "payments_unavailable", message: RECONCILE_COPY.unavailable };
      }
      if (!bill) return { ok: false as const, status: 404 as const, code: "payments_bill_not_found", message: "Bill not found" };
      // The snapshot carries the tenant's name split on whitespace
      // (loadBillSnapshot in ./infrastructure/supabase-repository.ts), so
      // both sides are compared with their spacing collapsed; if the
      // snapshot comes to carry the name whole, compare it as stored.
      const expected = sameSpacing(`${bill.contactFirstName} ${bill.contactLastName}`);
      if (expected === "" || typed !== expected) {
        return { ok: false as const, status: 428 as const, code: "payments_reconcile_name_mismatch", message: RECONCILE_COPY.nameMismatch };
      }
    }
    const { error } = await this.repo.reconcileAttempt({
      attemptId,
      action,
      externalAmount: typeof rec.externalAmount === "number" ? rec.externalAmount : 0,
      externalReference: externalReference || null,
      notes: notes || null,
      actorUserId: this.scope.userId,
    });
    if (error) return reconcileRefusal(error);
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
    const batches = await Promise.all(attempts.map(attempt => this.repo.listReceiptsForAttempt(attempt.id)));
    for (const batch of batches) receipts.push(...batch);
    const [bill, adjustments] = await Promise.all([this.repo.loadBillSnapshot(lineItemId), this.repo.listExternalAdjustments(lineItemId)]);
    if (!bill) return { ok: false as const, status: 404 as const, code: "payments_bill_not_found", message: "Bill not found" };
    const received = receipts.filter(r => r.currency === bill.currency).reduce((total, r) => total + (r.provider_status === "completed" ? Number(r.amount) : r.provider_status === "reversed" ? -Number(r.amount) : 0), 0) + adjustments.reduce((total, adjustment) => total + adjustment.amount, 0);
    return { ok: true as const, data: { attempts, receipts, currentTotal: bill.totalAmount, currency: bill.currency, received, difference: received - bill.totalAmount } };
  }

  async listAttention(input: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const query = attentionQuery(input);
    if (!query) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "payments_invalid_attention_query",
        message: "Ask for attempts needing reconciliation, or failed attempts since an instant, optionally only checkouts never submitted.",
      };
    }
    // Reads stay available while plugins are disabled — only scope applies.
    const rows = await this.repo.listAttentionAttempts({
      orgId: this.scope.organizationId,
      status: query.status,
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.failureCode !== undefined
        ? { onlyFailureCode: query.failureCode }
        : query.status === "failed"
          ? { exceptFailureCodes: BOOKKEEPING_FAILURES }
          : {}),
      limit: MAX_ATTENTION_ATTEMPTS + 1,
    });
    const attempts = rows.slice(0, MAX_ATTENTION_ATTEMPTS);
    return { ok: true as const, data: { attempts, truncated: rows.length > MAX_ATTENTION_ATTEMPTS } };
  }
}
