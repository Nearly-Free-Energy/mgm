/**
 * providers/types.ts — provider-neutral contracts for the Payments capability.
 *
 * Payments owns checkout attempts, reconciliation and audit history; each
 * provider plugin (Pesapal first) supplies an implementation of
 * `PaymentProviderClient`. Billing and shared UI consume only these contracts
 * — never provider credentials, API types, or status mappings.
 */

export type PaymentProviderKind = "pesapal";

export interface ContactDetails {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
}

export interface CheckoutRequest {
  merchantReference: string;
  amount: number;
  currency: string;
  description: string;
  callbackUrl: string;
  contact: ContactDetails;
}

export interface CheckoutResult {
  redirectUrl: string;
  providerTrackingId: string;
  merchantReference: string;
}

export type VerifiedProviderStatus =
  | "completed"
  | "failed"
  | "reversed"
  | "pending"
  | "unknown";

export interface TransactionSnapshot {
  status: VerifiedProviderStatus;
  amount?: number;
  currency?: string;
  paymentMethod?: string;
  confirmationCode?: string;
  merchantReference?: string;
  raw: unknown;
}

export interface NotificationEnvelope {
  trackingId: string;
  merchantReference: string;
  raw: unknown;
}

export interface ConnectionTestResult {
  ok: boolean;
  reason: string;
  message: string;
}

export interface PaymentProviderClient {
  readonly provider: PaymentProviderKind;
  testConnection(): Promise<ConnectionTestResult>;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  getTransaction(trackingId: string): Promise<TransactionSnapshot>;
  parseNotification(raw: unknown): NotificationEnvelope | null;
}

/** Map a provider snapshot to the Payments attempt outcome. */
export function snapshotToAttemptOutcome(
  status: VerifiedProviderStatus
): "paid" | "failed" | "refunded" | null {
  switch (status) {
    case "completed":
      return "paid";
    case "failed":
      return "failed";
    case "reversed":
      return "refunded";
    default:
      return null;
  }
}
