/**
 * repository.ts — persistence boundary for the billing plugin (issue #5).
 *
 * The billing capability and its domain logic consume ONLY these interfaces.
 * The Supabase/PostgREST implementation lives in `infrastructure/`. An
 * import-boundary test fails the build if domain files import a database
 * client, server helper, vendor SDK, or framework module directly.
 *
 * Billing reuses the calculation engine (`calculations.ts`,
 * `precision.ts`, `generate.ts`, `csv-export.ts`) through injected
 * functions wired in `compose.ts` — the capability never constructs a
 * vendor client or resolves provider configuration itself.
 */
import type { UserRoleRecord } from "@/lib/types/domain";
import type { CloseReview } from "./close";
import type { ExpectedBill, GenerationResult, RunGenerationFatal } from "./generate";

export type { ExpectedBill };

export type BillingScope = {
  organizationId: string;
  userId: string;
  roles: UserRoleRecord[];
};

export type BillingResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 422 | 428 | 500 | 503;
      code: string;
      message: string;
      field?: string;
      reason?: string;
      unresolved?: PeriodSummary["unresolved"];
      /** On a close that is not confirmed, or confirmed against other totals: what to review now. */
      review?: CloseReview;
    };

export function billingFailure(
  error: Omit<Extract<BillingResult<never>, { ok: false }>, "ok">
): Extract<BillingResult<never>, { ok: false }> {
  return { ok: false, ...error };
}

/** `details` is PostgREST's DETAIL, such as the delete guard's `closed` or `payment_activity` (./period-delete.ts). */
export type RepositoryError = { code?: string; message: string; details?: string | null };

export type TierInput = {
  label?: string;
  min_kwh: number;
  max_kwh: number | null;
  rate_per_kwh: number;
};

export type RateScheduleRow = {
  id: string;
  microgrid_id: string;
  tiers: TierInput[];
  service_charge: number;
  tax_rate: number;
  created_at: string;
};

export type BillingPeriodRow = {
  id: string;
  microgrid_id: string;
  start_date: string;
  end_date: string;
  status: "draft" | "closed";
  timezone: string;
};

export type ManualReadingInput = {
  tenantId: string;
  startKwh: number;
  endKwh: number;
  reason?: string;
};

export type SeedReadingInput = {
  deviceId: string;
  dialReadingKwh: number;
  readAt: string;
  startKwh: number;
};

export type GenerationOutput = GenerationResult;

export type GenerationFatal = RunGenerationFatal;

/**
 * Bill generation delegate, wired in `compose.ts` to the bill engine
 * (`runGenerationFor`) with the request-scoped metering provider. The
 * capability validates scope and plugin state before delegating, so the
 * engine never sees an unauthorized call.
 */
export interface BillingGeneration {
  run(input: {
    periodId: string;
    tenantIds?: string[];
    manualReadings?: ManualReadingInput[];
    revertToEdgeTenantIds?: string[];
    seedReadings?: SeedReadingInput[];
    mode: "write" | "preview";
    actorUserId: string;
    /** A per-bill regeneration's bill as read (RunGenerationParams.expectedBill). */
    expectedBill?: ExpectedBill;
    /** A whole-period run from meter data (RunGenerationParams.guardExistingBills). */
    guardExistingBills?: boolean;
    /** A first bill for one tenant from readings typed by hand (RunGenerationParams.newBillOnly). */
    newBillOnly?: boolean;
  }): Promise<GenerationOutput | GenerationFatal>;
}

export type UnresolvedTenant = {
  tenantId: string;
  tenantName: string;
  reason: string;
};

export type PeriodSummary = {
  period: BillingPeriodRow;
  lineItemCount: number;
  totalAmount: number;
  unresolved: UnresolvedTenant[];
};

export type ManualPaymentStatus = "paid" | "unpaid";

export interface BillingRepository {
  getAuthenticatedUserId(): Promise<string | null>;
  getUserRoles(): Promise<UserRoleRecord[]>;
  /** Rejects when plugin state cannot be read; the capability answers 503. */
  isPluginEnabled(organizationId: string): Promise<boolean>;
  getMicrogridOrganization(
    microgridId: string
  ): Promise<{ microgridId: string; communityId: string; orgId: string } | null>;
  getPeriodOrganization(
    periodId: string
  ): Promise<{ periodId: string; microgridId: string; orgId: string } | null>;
  getLineItemOrganization(
    lineItemId: string
  ): Promise<{ lineItemId: string; microgridId: string; orgId: string } | null>;
  getMicrogridTimezone(microgridId: string): Promise<string | null>;
  getLatestRateSchedule(microgridId: string): Promise<RateScheduleRow | null>;
  createRateSchedule(input: {
    microgridId: string;
    tiers: TierInput[];
    serviceCharge: number;
    taxRate: number;
  }): Promise<{ row: RateScheduleRow | null; error: RepositoryError | null }>;
  createBillingPeriod(input: {
    microgridId: string;
    startDate: string;
    endDate: string;
    timezone: string;
  }): Promise<{ row: BillingPeriodRow | null; error: RepositoryError | null }>;
  getPeriodSummary(periodId: string): Promise<PeriodSummary | null>;
  /**
   * fn_billing_period_close_review, parsed. Null when the period is not
   * visible to the caller; rejects when it cannot be read or parsed.
   */
  getCloseReview(periodId: string): Promise<CloseReview | null>;
  /** fn_close_billing_period: closes against the digest and acknowledgements the person confirmed. */
  closeBillingPeriod(
    periodId: string,
    confirmation: { digest: string; acknowledged: string[] }
  ): Promise<{ row: BillingPeriodRow | null; error: RepositoryError | null }>;
  recordManualPayment(input: {
    lineItemId: string;
    status: ManualPaymentStatus;
    notes: string | null;
    actorUserId: string;
  }): Promise<{ updated: unknown; error: RepositoryError | null }>;
  /** Null when the period is not visible to the caller; rejects when it cannot be read. */
  getBillingPeriod(periodId: string): Promise<BillingPeriodRow | null>;
  /**
   * Deletes the period through fn_delete_draft_billing_period (migration
   * 20261120130000). `deleted` is false when no row was removed, as when the
   * period is not the caller's to delete; fn_billing_period_before_delete_guard
   * refuses a closed period or one with payment activity with an error.
   */
  deleteBillingPeriod(periodId: string): Promise<{ deleted: boolean; error: RepositoryError | null }>;
}

export interface BillingCapabilityContract {
  createTariff(input: unknown): Promise<BillingResult<RateScheduleRow>>;
  listTariffs(microgridId: string): Promise<BillingResult<RateScheduleRow[]>>;
  createPeriod(input: unknown): Promise<BillingResult<BillingPeriodRow>>;
  getPeriodSummary(periodId: string): Promise<BillingResult<PeriodSummary>>;
  /** What a person reviews and confirms before closing the period. A read. */
  getCloseReview(periodId: string): Promise<BillingResult<CloseReview>>;
  closePeriod(
    periodId: string,
    input?: unknown
  ): Promise<BillingResult<{ period: BillingPeriodRow; unresolved: UnresolvedTenant[] }>>;
  previewBills(input: unknown): Promise<BillingResult<GenerationOutput>>;
  /**
   * Regenerates one bill as it was read: `options.expectedBill` makes the
   * run a per-bill regeneration (RunGenerationParams.expectedBill), and is
   * required, so this never rewrites a bill it has not read. It is not part
   * of the body (GenerateBillsBody), so it never arrives in a caller's
   * input. POST /api/billing-line-items/[lineItemId]/regenerate calls it.
   */
  generateBills(input: unknown, options: { expectedBill: ExpectedBill }): Promise<BillingResult<GenerationOutput>>;
  /**
   * Generates every bill of a draft period from meter data
   * (RunGenerationParams.guardExistingBills): manual bills are kept, and
   * invoiced, paid and refunded bills left as they are; any other existing
   * bill is changed only as it was read. POST
   * /api/billing-periods/[periodId]/generate-from-meters calls it.
   */
  generateFromMeters(periodId: string): Promise<BillingResult<GenerationOutput>>;
  /**
   * Bills one tenant who has no bill in a draft period from readings typed
   * by hand (RunGenerationParams.newBillOnly), through the same engine as
   * generateBills: the same tariff pin, rounding and audit row. A tenant
   * who already has a bill is refused (`bill_exists`), as is a closed
   * period. POST
   * /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings
   * calls it.
   */
  billFromReadings(
    periodId: string,
    tenantId: string,
    readings: { startKwh: number; endKwh: number; reason?: string },
  ): Promise<BillingResult<GenerationOutput>>;
  recordManualPayment(
    lineItemId: string,
    input: unknown
  ): Promise<BillingResult<unknown>>;
  /** Deletes a draft period, against the name the person typed (DeletePeriodBody). */
  deletePeriod(
    periodId: string,
    input?: unknown
  ): Promise<BillingResult<{ periodId: string; microgridId: string; name: string }>>;
}
