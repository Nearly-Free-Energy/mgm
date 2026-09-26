/**
 * repository.ts — persistence boundary for the billing plugin (issue #5).
 *
 * The billing capability and its domain logic consume ONLY these interfaces.
 * The Supabase/PostgREST implementation lives in `infrastructure/`. An
 * import-boundary test fails the build if domain files import a database
 * client, server helper, vendor SDK, or framework module directly.
 *
 * Billing reuses the MBE calculation engine (`calculations.ts`,
 * `precision.ts`, `generate.ts`, `csv-export.ts`) through injected
 * functions wired in `compose.ts` — the capability never constructs a
 * vendor client or resolves provider configuration itself.
 */
import type { UserRoleRecord } from "@/lib/types/domain";
import type { GenerationResult, RunGenerationFatal } from "./generate";

export type BillingScope = {
  organizationId: string;
  userId: string;
  roles: UserRoleRecord[];
};

export type BillingResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503;
      code: string;
      message: string;
      field?: string;
      reason?: string;
    };

export function billingFailure(
  error: Omit<Extract<BillingResult<never>, { ok: false }>, "ok">
): Extract<BillingResult<never>, { ok: false }> {
  return { ok: false, ...error };
}

export type RepositoryError = { code?: string; message: string };

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
  householdId: string;
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
 * Bill generation delegate, wired in `compose.ts` to the MBE engine
 * (`runGenerationFor`) with the request-scoped metering provider. The
 * capability validates scope and plugin state before delegating, so the
 * engine never sees an unauthorized call.
 */
export interface BillingGeneration {
  run(input: {
    periodId: string;
    householdIds?: string[];
    manualReadings?: ManualReadingInput[];
    seedReadings?: SeedReadingInput[];
    mode: "write" | "preview";
    actorUserId: string;
  }): Promise<GenerationOutput | GenerationFatal>;
}

export type UnresolvedHousehold = {
  householdId: string;
  householdName: string;
  reason: string;
};

export type PeriodSummary = {
  period: BillingPeriodRow;
  lineItemCount: number;
  totalAmount: number;
  unresolved: UnresolvedHousehold[];
};

export type ManualPaymentStatus = "paid" | "unpaid";

export interface BillingRepository {
  getAuthenticatedUserId(): Promise<string | null>;
  getUserRoles(): Promise<UserRoleRecord[]>;
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
  closeBillingPeriod(
    periodId: string
  ): Promise<{ row: BillingPeriodRow | null; error: RepositoryError | null }>;
  recordManualPayment(input: {
    lineItemId: string;
    status: ManualPaymentStatus;
    notes: string | null;
    actorUserId: string;
  }): Promise<{ updated: unknown; error: RepositoryError | null }>;
}

export interface BillingCapabilityContract {
  createTariff(input: unknown): Promise<BillingResult<RateScheduleRow>>;
  listTariffs(microgridId: string): Promise<BillingResult<RateScheduleRow[]>>;
  createPeriod(input: unknown): Promise<BillingResult<BillingPeriodRow>>;
  getPeriodSummary(periodId: string): Promise<BillingResult<PeriodSummary>>;
  closePeriod(
    periodId: string,
    input?: unknown
  ): Promise<BillingResult<{ period: BillingPeriodRow; unresolved: UnresolvedHousehold[] }>>;
  previewBills(input: unknown): Promise<BillingResult<GenerationOutput>>;
  generateBills(input: unknown): Promise<BillingResult<GenerationOutput>>;
  recordManualPayment(
    lineItemId: string,
    input: unknown
  ): Promise<BillingResult<unknown>>;
}
