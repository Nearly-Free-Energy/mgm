/**
 * repository.ts — persistence boundary for the Payments plugin.
 *
 * The Payments capability consumes ONLY these interfaces. The
 * Supabase/PostgREST implementation lives in `infrastructure/`, provider
 * wiring in `compose.ts`. Billing and shared UI never import provider
 * modules directly — see `__tests__/payments-import-boundary.test.ts`.
 */
import type { UserRoleRecord } from "@/lib/types/domain";

export type PaymentsScope = {
  organizationId: string;
  userId: string | null;
  roles: UserRoleRecord[];
};

export type PaymentsResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503;
      code: string;
      message: string;
      field?: string;
      reason?: string;
    };

export function paymentsFailure(
  error: Omit<Extract<PaymentsResult<never>, { ok: false }>, "ok">
): Extract<PaymentsResult<never>, { ok: false }> {
  return { ok: false, ...error };
}

export type RepositoryError = { code?: string; message: string };

export type MerchantAccountPublic = {
  id: string;
  org_id: string;
  provider: "pesapal";
  display_name: string;
  sandbox: boolean;
  consumer_key: string;
  base_url: string;
  ipn_id: string | null;
  ipn_url: string | null;
  version: number;
  disabled: boolean;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_test_message: string | null;
  /** Origin: org default or community override. Never includes secrets. */
  origin: "org_default" | "community_override";
  community_id: string | null;
};

export type MerchantAccountSecret = MerchantAccountPublic & {
  secret: string;
};

export type PaymentReadiness =
  | { state: "disabled"; message: string }
  | { state: "unconfigured"; message: string }
  | { state: "sandbox"; message: string; account: MerchantAccountPublic }
  | { state: "ready"; message: string; account: MerchantAccountPublic }
  | { state: "connection_error"; message: string; account: MerchantAccountPublic };

export type AttemptStatus =
  | "pending"
  | "confirmation_pending"
  | "verified"
  | "failed"
  | "reversed"
  | "needs_reconciliation"
  | "resolved";

export type PaymentAttempt = {
  id: string;
  org_id: string;
  line_item_id: string;
  community_id: string | null;
  merchant_account_id: string | null;
  merchant_account_version: number;
  amount: number;
  currency: string;
  bill_revision_total: number;
  bill_revision_updated_at: string | null;
  merchant_reference: string;
  provider_tracking_id: string | null;
  provider: "pesapal";
  status: AttemptStatus;
  checkout_url: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
};

export type PaymentReceipt = {
  id: string;
  attempt_id: string;
  amount: number;
  currency: string;
  provider_status: string;
  provider_tracking_id: string | null;
  confirmation_code: string | null;
  payment_method: string | null;
  created_at: string;
};

export type BillSnapshot = {
  lineItemId: string;
  orgId: string;
  communityId: string;
  totalAmount: number;
  currency: string;
  updatedAt: string | null;
  periodStatus: "draft" | "closed";
  contactEmail: string | null;
  contactPhone: string | null;
  contactFirstName: string;
  contactLastName: string;
  periodLabel: string;
};

export interface PaymentsRepository {
  isPaymentsEnabled(organizationId: string): Promise<boolean>;
  isPesapalEnabled(organizationId: string): Promise<boolean>;
  getLineItemOrganization(
    lineItemId: string
  ): Promise<{ lineItemId: string; orgId: string } | null>;
  loadBillSnapshot(lineItemId: string): Promise<BillSnapshot | null>;
  resolveMerchantAccount(input: {
    orgId: string;
    communityId: string;
  }): Promise<
    | { ok: true; account: MerchantAccountSecret; origin: MerchantAccountPublic["origin"] }
    | { ok: false; code: "unconfigured" | "override_broken" | "disabled"; message: string }
  >;
  loadMerchantAccountPublic(input: {
    orgId: string;
    communityId: string;
  }): Promise<
    | { ok: true; account: MerchantAccountPublic | null; hasOverride: boolean }
    | { ok: false; code: string; message: string }
  >;
  findActiveAttempt(input: {
    lineItemId: string;
    amount: number;
    currency: string;
  }): Promise<PaymentAttempt | null>;
  findBlockedAttempt(lineItemId: string): Promise<PaymentAttempt | null>;
  createAttempt(input: {
    orgId: string;
    lineItemId: string;
    communityId: string;
    merchantAccountId: string;
    merchantAccountVersion: number;
    amount: number;
    currency: string;
    billRevisionTotal: number;
    billRevisionUpdatedAt: string | null;
    merchantReference: string;
  }): Promise<{ attempt: PaymentAttempt | null; error: RepositoryError | null }>;
  updateAttemptTracking(input: {
    attemptId: string;
    providerTrackingId: string;
    checkoutUrl: string;
    status?: AttemptStatus;
  }): Promise<RepositoryError | null>;
  markAttemptStatus(input: {
    attemptId: string;
    status: AttemptStatus;
    failureCode?: string | null;
    failureMessage?: string | null;
  }): Promise<RepositoryError | null>;
  getAttempt(attemptId: string): Promise<PaymentAttempt | null>;
  listAttemptsForLineItem(lineItemId: string): Promise<PaymentAttempt[]>;
  recordReceipt(input: {
    orgId: string;
    attemptId: string;
    amount: number;
    currency: string;
    providerStatus: string;
    providerTrackingId: string | null;
    confirmationCode: string | null;
    paymentMethod: string | null;
    rawPayload: unknown;
  }): Promise<{ created: boolean; error: RepositoryError | null }>;
  listReceiptsForAttempt(attemptId: string): Promise<PaymentReceipt[]>;
  upsertNotification(input: {
    orgId: string | null;
    provider: "pesapal";
    trackingId: string;
    merchantReference: string;
    rawPayload: unknown;
  }): Promise<{ id: string; error: RepositoryError | null }>;
  markNotification(input: {
    id: string;
    status: "processed" | "failed";
    lastError?: string | null;
    processedAttemptId?: string | null;
    retryInSeconds?: number | null;
  }): Promise<RepositoryError | null>;
  dueNotifications(limit: number): Promise<
    { id: string; tracking_id: string; merchant_reference: string; attempt_count: number; raw_payload: unknown }[]
  >;
  findAttemptByReference(merchantReference: string): Promise<PaymentAttempt | null>;
  findAttemptByTracking(trackingId: string): Promise<PaymentAttempt | null>;
  applyBillPayment(input: {
    lineItemId: string;
    toStatus: "paid" | "failed" | "refunded";
    rawPayload: unknown;
    actorRef: string;
  }): Promise<{ error: RepositoryError | null }>;
  reconcileAttempt(input: {
    attemptId: string;
    action: "accept_exact" | "record_external";
    externalReference?: string | null;
    notes?: string | null;
    actorUserId: string;
  }): Promise<{ error: RepositoryError | null }>;
}

export interface ProviderFactory {
  forAccount(
    account: MerchantAccountSecret
  ): Promise<
    | { ok: true; provider: import("./providers/types").PaymentProviderClient }
    | { ok: false; code: string; message: string }
  >;
}

export interface PaymentsCapabilityContract {
  getReadiness(communityId: string): Promise<PaymentsResult<PaymentReadiness>>;
  stablePaymentLink(lineItemId: string): Promise<PaymentsResult<{ url: string }>>;
  ensureCheckout(
    lineItemId: string,
    input?: { callbackUrl?: string; force?: boolean }
  ): Promise<
    PaymentsResult<{
      redirectUrl: string;
      attempt: PaymentAttempt;
      reused: boolean;
    }>
  >;
  refreshPaymentStatus(
    attemptId: string
  ): Promise<PaymentsResult<{ attempt: PaymentAttempt; receipts: PaymentReceipt[] }>>;
  handleNotification(
    raw: unknown,
    input?: { orgId?: string | null }
  ): Promise<PaymentsResult<{ processed: boolean; attemptId: string | null }>>;
  reconcile(
    attemptId: string,
    input: unknown
  ): Promise<PaymentsResult<{ attempt: PaymentAttempt }>>;
  listHistory(
    lineItemId: string
  ): Promise<PaymentsResult<{ attempts: PaymentAttempt[]; receipts: PaymentReceipt[] }>>;
}
