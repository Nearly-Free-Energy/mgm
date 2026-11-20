/**
 * BillingCapability — typed entry point for the billing plugin's domain
 * operations (issue #5).
 *
 * Import boundary: consumes the repository/generation interfaces only —
 * never a database client, vendor SDK, or framework module. See
 * `__tests__/billing-import-boundary.test.ts`. Bill math lives in the
 * engine (`calculations.ts`, `precision.ts`) and reaches this capability
 * only through the injected `BillingGeneration` delegate wired in
 * `compose.ts`.
 */
import "server-only";

import type {
  BillingCapabilityContract,
  BillingGeneration,
  BillingRepository,
  BillingResult,
  BillingScope,
  ExpectedBill,
  GenerationFatal,
  GenerationOutput,
  ManualPaymentStatus,
  PeriodSummary,
  TierInput,
  UnresolvedTenant,
} from "./repository";
import {
  CLOSE_REFUSAL_COPY,
  fractionalTotalsMessage,
  missingAcknowledgements,
  periodName,
  typedNameMatches,
  type CloseReview,
} from "./close";
import { isPeriodKeptError, PERIOD_KEPT_CLOSED_MESSAGE, periodDeleteErrorMessage } from "./period-delete";
import { ClosePeriodBody, CreatePeriodBody, DeletePeriodBody, GenerateBillsBody } from "./schemas";

/**
 * 409: a bill's total is not a whole number, so the period cannot close until
 * that bill is regenerated (fn_record_line_item_with_audit rounds it).
 */
function fractionalTotals(review: CloseReview | undefined) {
  return {
    ok: false as const,
    status: 409 as const,
    code: "billing_close_fractional_totals",
    message: fractionalTotalsMessage(review?.fractionalTotals ?? []),
    ...(review ? { review } : {}),
  };
}

/** 409: the totals changed after the person reviewed them. Carries the current review when it could be read. */
function totalsChanged(review: CloseReview | undefined) {
  return {
    ok: false as const,
    status: 409 as const,
    code: "billing_period_totals_changed",
    message: CLOSE_REFUSAL_COPY.totalsChanged,
    ...(review ? { review } : {}),
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tariffError(
  message: string,
  field?: string
): Extract<BillingResult<never>, { ok: false }> {
  return { ok: false, status: 400, code: "billing_invalid_tariff", message, field };
}

function validateTiers(tiers: unknown): { tiers?: TierInput[]; error?: string } {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { error: "tiers must be a non-empty array (at least 1 tier required)" };
  }
  const out: TierInput[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i] as Partial<TierInput>;
    const isLast = i === tiers.length - 1;
    if (typeof tier.min_kwh !== "number" || !Number.isFinite(tier.min_kwh) || tier.min_kwh < 0) {
      return { error: `Tier ${i + 1}: min_kwh must be a number >= 0` };
    }
    if (
      typeof tier.rate_per_kwh !== "number" ||
      !Number.isFinite(tier.rate_per_kwh) ||
      tier.rate_per_kwh <= 0
    ) {
      return { error: `Tier ${i + 1}: rate_per_kwh must be greater than 0` };
    }
    if (!isLast) {
      if (tier.max_kwh === null || tier.max_kwh === undefined || typeof tier.max_kwh !== "number") {
        return { error: `Tier ${i + 1}: only the last tier may have max_kwh null` };
      }
      if (i > 0) {
        const prev = tiers[i - 1] as Partial<TierInput>;
        if (typeof prev.max_kwh === "number" && tier.min_kwh !== prev.max_kwh + 1) {
          return {
            error: `Tier ${i + 1}: min_kwh must be ${prev.max_kwh + 1} (contiguous with tier ${i})`,
          };
        }
      }
    } else if (i > 0) {
      const prev = tiers[i - 1] as Partial<TierInput>;
      if (typeof prev.max_kwh === "number" && tier.min_kwh !== prev.max_kwh + 1) {
        return {
          error: `Tier ${i + 1}: min_kwh must be ${prev.max_kwh + 1} (contiguous with tier ${i})`,
        };
      }
    }
    out.push({
      ...(typeof tier.label === "string" ? { label: tier.label } : {}),
      min_kwh: tier.min_kwh,
      max_kwh: isLast ? (tier.max_kwh ?? null) : (tier.max_kwh as number),
      rate_per_kwh: tier.rate_per_kwh,
    });
  }
  return { tiers: out };
}

export class BillingCapability implements BillingCapabilityContract {
  constructor(
    private readonly repo: BillingRepository,
    private readonly scope: BillingScope,
    private readonly generation: BillingGeneration,
    private readonly isActive: () => boolean
  ) {}

  private ensureActive(): Extract<BillingResult<never>, { ok: false }> | null {
    if (this.isActive()) return null;
    return {
      ok: false,
      status: 500,
      code: "billing_composition_disposed",
      message: "Billing composition has been disposed.",
    };
  }

  private scopeMismatch() {
    return {
      ok: false as const,
      status: 403 as const,
      code: "billing_scope_mismatch",
      message: "Not authorized to act on this organization.",
      reason: "forbidden",
    };
  }

  /**
   * The plugin can be turned off between composition and a write, so each
   * write reads its state again here, with composeBilling's policy. An
   * unreadable state fails closed with the gate's 503 code and wording
   * (`MgmGate.check`, src/lib/runtime/gate.ts); if the gate's codes or
   * wording change, change them here. The 503 relies on the repository
   * rejecting when it cannot read the state, as the Supabase repository does
   * through `isPluginEnabledForOrg`; a repository that turns a failed read
   * into `false` answers 409 `billing_disabled` instead.
   */
  private async requirePlugin(): Promise<Extract<
    BillingResult<never>,
    { ok: false }
  > | null> {
    let enabled: boolean;
    try {
      enabled = await this.repo.isPluginEnabled(this.scope.organizationId);
    } catch {
      return {
        ok: false,
        status: 503,
        code: "billing_gate_unavailable",
        message: "Could not verify whether Billing is enabled. Retry the request.",
      };
    }
    if (enabled) return null;
    return {
      ok: false,
      status: 409,
      code: "billing_disabled",
      message:
        "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.",
    };
  }

  async createTariff(input: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return tariffError("Body must be an object.");
    }
    const rec = input as Record<string, unknown>;
    const microgridId = typeof rec.microgrid_id === "string" ? rec.microgrid_id : "";
    if (!UUID_RE.test(microgridId)) {
      return tariffError("microgrid_id must be a valid UUID.", "microgrid_id");
    }
    const resolved = await this.repo.getMicrogridOrganization(microgridId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const checked = validateTiers(rec.tiers);
    if (checked.error || !checked.tiers) {
      return tariffError(checked.error ?? "Invalid tiers.", "tiers");
    }
    if (
      typeof rec.service_charge !== "number" ||
      !Number.isFinite(rec.service_charge) ||
      rec.service_charge < 0
    ) {
      return tariffError("service_charge must be a number >= 0.", "service_charge");
    }
    if (
      typeof rec.tax_rate !== "number" ||
      !Number.isFinite(rec.tax_rate) ||
      rec.tax_rate < 0 ||
      rec.tax_rate > 1
    ) {
      return tariffError("tax_rate must be a number between 0 and 1 (inclusive).", "tax_rate");
    }

    const { row, error } = await this.repo.createRateSchedule({
      microgridId,
      tiers: checked.tiers,
      serviceCharge: rec.service_charge,
      taxRate: rec.tax_rate,
    });
    if (error || !row) {
      if (error && (error.code === "42501" || error.message.includes("row-level security"))) {
        return {
          ok: false as const,
          status: 403 as const,
          code: "billing_forbidden",
          message: "Not authorized to create a tariff for this microgrid.",
        };
      }
      return {
        ok: false as const,
        status: 500 as const,
        code: "billing_unavailable",
        message: `Could not create tariff: ${error?.message ?? "unknown error"}.`,
      };
    }
    return { ok: true as const, data: row };
  }

  async listTariffs(microgridId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(microgridId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_microgrid",
        message: "Invalid microgrid id — expected UUID.",
      };
    }
    const resolved = await this.repo.getMicrogridOrganization(microgridId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    // Reads stay available while the plugin is disabled — only scope applies.
    const row = await this.repo.getLatestRateSchedule(microgridId);
    return { ok: true as const, data: row ? [row] : [] };
  }

  async createPeriod(input: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    // The route parses with the same schema first; this keeps a direct
    // caller to the codes it has always had. A fault in the body itself or
    // in microgrid_id answers before the scope check; a fault in the dates,
    // which CreatePeriodBody checks after microgrid_id, only after the scope
    // and plugin checks, as before.
    const body = CreatePeriodBody.safeParse(input);
    const issue = body.success ? undefined : body.error.issues[0];
    const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
    if (issue && field !== "start_date" && field !== "end_date") {
      return {
        ok: false as const,
        status: 400 as const,
        code: field === "microgrid_id" ? "billing_invalid_microgrid" : "billing_invalid_period",
        message: issue.message,
        ...(field ? { field } : {}),
      };
    }
    // Past the check above, microgrid_id parsed: zod reports the shape's keys in order.
    const microgridId = (input as { microgrid_id: string }).microgrid_id;
    const resolved = await this.repo.getMicrogridOrganization(microgridId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    if (!body.success) {
      return {
        ok: false as const,
        status: 422 as const,
        code: "billing_invalid_range",
        message: body.error.issues[0].message,
        field: field ?? "start_date",
      };
    }
    const { start_date: startDate, end_date: endDate } = body.data;
    // The period timezone is stamped once from the microgrid and never
    // re-derived, so regenerating after a microgrid timezone change
    // reproduces the identical window.
    const timezone = (await this.repo.getMicrogridTimezone(microgridId)) ?? "UTC";
    const { row, error } = await this.repo.createBillingPeriod({
      microgridId,
      startDate,
      endDate,
      timezone,
    });
    if (error || !row) {
      if (error?.code === "23P01") {
        return {
          ok: false as const,
          status: 409 as const,
          code: "billing_period_overlap",
          message: "This billing period overlaps an existing period for the microgrid.",
        };
      }
      if (error && (error.code === "42501" || error.message.includes("row-level security"))) {
        return {
          ok: false as const,
          status: 403 as const,
          code: "billing_forbidden",
          message: "Not authorized to create a billing period for this microgrid.",
        };
      }
      return {
        ok: false as const,
        status: 500 as const,
        code: "billing_unavailable",
        message: `Could not create billing period: ${error?.message ?? "unknown error"}.`,
      };
    }
    return { ok: true as const, data: row };
  }

  private async loadPeriodSummary(periodId: string): Promise<BillingResult<PeriodSummary>> {
    try {
      const summary = await this.repo.getPeriodSummary(periodId);
      if (!summary) return {
        ok: false, status: 404, code: "billing_period_not_found",
        message: "Billing period not found.",
      };
      return { ok: true, data: summary };
    } catch {
      return {
        ok: false, status: 503, code: "billing_summary_unavailable",
        message: "Could not verify period completeness. Retry before closing the period.",
      };
    }
  }

  async getPeriodSummary(periodId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(periodId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_period",
        message: "Invalid billing period id — expected UUID.",
      };
    }
    const resolved = await this.repo.getPeriodOrganization(periodId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    // Reads stay available while the plugin is disabled — only scope applies.
    const loaded = await this.loadPeriodSummary(periodId);
    if (!loaded.ok) return loaded;
    const summary = loaded.data;
    return { ok: true as const, data: summary };
  }

  /**
   * The close review, or a refusal. A period the caller cannot see is 404,
   * like getPeriodSummary; a review that cannot be read is 503, so a failed
   * read is never taken for a period with nothing to confirm.
   */
  private async loadCloseReview(periodId: string): Promise<BillingResult<CloseReview>> {
    try {
      const review = await this.repo.getCloseReview(periodId);
      if (!review) return {
        ok: false, status: 404, code: "billing_period_not_found",
        message: "Billing period not found.",
      };
      return { ok: true, data: review };
    } catch {
      return {
        ok: false, status: 503, code: "billing_review_unavailable",
        message: CLOSE_REFUSAL_COPY.reviewUnavailable,
      };
    }
  }

  async getCloseReview(periodId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(periodId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_period",
        message: "Invalid billing period id — expected UUID.",
      };
    }
    const resolved = await this.repo.getPeriodOrganization(periodId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    // Reads stay available while the plugin is disabled — only scope applies.
    return this.loadCloseReview(periodId);
  }

  /**
   * Closes a period against the totals the person reviewed (#201). The body
   * is ClosePeriodBody: without `confirmation` the answer is 428 with the
   * review to confirm; with a digest of other totals it is 409 with the
   * current review. The database checks the digest and acknowledgements
   * again inside the write (fn_close_billing_period), so a change between
   * this check and the write is still refused there; the typed name is
   * checked here only, as it guards attention rather than data.
   */
  async closePeriod(periodId: string, input?: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(periodId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_period",
        message: "Invalid billing period id — expected UUID.",
      };
    }
    const resolved = await this.repo.getPeriodOrganization(periodId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const body = ClosePeriodBody.safeParse(input ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_body",
        message: issue.message,
        ...(typeof issue.path[0] === "string" ? { field: issue.path[0] } : {}),
      };
    }

    const loaded = await this.loadCloseReview(periodId);
    if (!loaded.ok) return loaded;
    const review = loaded.data;
    if (review.status === "closed") {
      return {
        ok: false as const,
        status: 409 as const,
        code: "billing_period_closed",
        message: CLOSE_REFUSAL_COPY.closed,
      };
    }

    if (review.fractionalTotals.length > 0) {
      return fractionalTotals(review);
    }

    const confirmation = body.data.confirmation;
    if (!confirmation) {
      return {
        ok: false as const,
        status: 428 as const,
        code: "billing_close_confirmation_required",
        message: `Review the totals for ${review.name}, tick each acknowledgement and type the period's name to close it.`,
        review,
      };
    }
    if (confirmation.digest !== review.digest) {
      return totalsChanged(review);
    }
    const missing = missingAcknowledgements(review, confirmation.acknowledged);
    if (missing.length > 0) {
      return {
        ok: false as const,
        status: 428 as const,
        code: "billing_close_acknowledgement_missing",
        message: "Tick every acknowledgement to close the period.",
        field: "confirmation",
        review,
      };
    }
    if (!typedNameMatches(confirmation.typed, review.name)) {
      return {
        ok: false as const,
        status: 428 as const,
        code: "billing_close_name_mismatch",
        message: `Type the period's name, ${review.name}, to close it.`,
        field: "confirmation",
        review,
      };
    }

    const { row, error } = await this.repo.closeBillingPeriod(periodId, {
      digest: confirmation.digest,
      acknowledged: confirmation.acknowledged,
    });
    if (error || !row) {
      // The tokens are fn_close_billing_period's (migration 20261118130000).
      const token = error?.message.split(":", 1)[0];
      if (token === "billing_close_totals_changed") {
        const current = await this.loadCloseReview(periodId);
        return totalsChanged(current.ok ? current.data : undefined);
      }
      if (token === "billing_close_fractional_total") {
        const current = await this.loadCloseReview(periodId);
        return fractionalTotals(current.ok ? current.data : undefined);
      }
      if (token === "billing_close_acknowledgement_missing") {
        return {
          ok: false as const,
          status: 428 as const,
          code: "billing_close_acknowledgement_missing",
          message: "Tick every acknowledgement to close the period.",
          field: "confirmation",
        };
      }
      if (token === "billing_period_closed") {
        return {
          ok: false as const,
          status: 409 as const,
          code: "billing_period_closed",
          message: CLOSE_REFUSAL_COPY.closed,
        };
      }
      if (token === "billing_period_not_found" || error?.code === "P0002") {
        return {
          ok: false as const,
          status: 404 as const,
          code: "billing_period_not_found",
          message: "Billing period not found.",
        };
      }
      if (error && (error.code === "42501" || error.message.includes("row-level security"))) {
        return {
          ok: false as const,
          status: 403 as const,
          code: "billing_forbidden",
          message: "Not authorized to close this billing period.",
        };
      }
      return {
        ok: false as const,
        status: 500 as const,
        code: "billing_unavailable",
        message: `Could not close billing period: ${error?.message ?? "unknown error"}.`,
      };
    }
    const unresolved: UnresolvedTenant[] = review.unbilled.map((t) => ({
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      reason: "No bill generated for this tenant in this period.",
    }));
    return { ok: true as const, data: { period: row, unresolved } };
  }

  /**
   * Deletes a draft period against the name the person typed (#201). The
   * body is DeletePeriodBody: without `confirmation` the answer is 428 with
   * the name to type. A closed period is refused before any name is asked.
   * The typed name is checked here only, as it guards attention rather than
   * data: fn_billing_period_before_delete_guard stays the authority on closed
   * periods and payment activity, and its refusal is mapped below.
   */
  async deletePeriod(periodId: string, input?: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(periodId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_period",
        message: "Invalid billing period id — expected UUID.",
      };
    }
    const resolved = await this.repo.getPeriodOrganization(periodId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const body = DeletePeriodBody.safeParse(input ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_body",
        message: issue.message,
        ...(typeof issue.path[0] === "string" ? { field: issue.path[0] } : {}),
      };
    }

    let period;
    try {
      period = await this.repo.getBillingPeriod(periodId);
    } catch {
      return {
        ok: false as const,
        status: 503 as const,
        code: "billing_unavailable",
        message: "Could not load the billing period. Try again shortly.",
      };
    }
    if (!period) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "billing_period_not_found",
        message: "Billing period not found.",
      };
    }
    if (period.status === "closed") {
      return {
        ok: false as const,
        status: 409 as const,
        code: "billing_period_kept",
        message: PERIOD_KEPT_CLOSED_MESSAGE,
      };
    }
    const name = periodName(period.start_date, period.end_date);
    if (name === null) {
      return {
        ok: false as const,
        status: 500 as const,
        code: "billing_unavailable",
        message: "Could not name the billing period.",
      };
    }

    const confirmation = body.data.confirmation;
    if (!confirmation) {
      return {
        ok: false as const,
        status: 428 as const,
        code: "billing_delete_confirmation_required",
        message: `Type the period's name, ${name}, to delete it.`,
      };
    }
    if (!typedNameMatches(confirmation.typed, name)) {
      return {
        ok: false as const,
        status: 428 as const,
        code: "billing_delete_name_mismatch",
        message: `Type the period's name, ${name}, to delete it.`,
        field: "confirmation",
      };
    }

    const { deleted, error } = await this.repo.deleteBillingPeriod(periodId);
    if (error) {
      if (isPeriodKeptError(error)) {
        return {
          ok: false as const,
          status: 409 as const,
          code: "billing_period_kept",
          message: periodDeleteErrorMessage(error),
        };
      }
      // pilot_import_batches.billing_period_id has no ON DELETE
      // (migration 20261114222000): an imported period cannot be deleted.
      if (error.code === "23503") {
        return {
          ok: false as const,
          status: 409 as const,
          code: "billing_period_referenced",
          message: "This period has imported pilot data and cannot be deleted.",
        };
      }
      if (error.code === "42501" || error.message.includes("row-level security")) {
        return {
          ok: false as const,
          status: 403 as const,
          code: "billing_forbidden",
          message: "Not authorized to delete this billing period.",
        };
      }
      return {
        ok: false as const,
        status: 500 as const,
        code: "billing_unavailable",
        message: "Could not delete the billing period.",
      };
    }
    if (!deleted) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "billing_period_not_found",
        message: "Billing period not found.",
      };
    }
    return { ok: true as const, data: { periodId, microgridId: period.microgrid_id, name } };
  }

  private async runGeneration(
    input: unknown,
    mode: "write" | "preview",
    expectedBill?: ExpectedBill,
    guardExistingBills?: true,
  ) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    // The routes parse first (generate with this schema, regenerate-preview
    // with PreviewBillsBody, which is this one without seedReadings); this
    // keeps a direct caller to the same rules. Preview accepts seeds here
    // as it always has.
    const body = GenerateBillsBody.safeParse(input);
    if (!body.success) {
      const issue = body.error.issues[0];
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_body",
        message: issue.message,
        ...(typeof issue.path[0] === "string" ? { field: issue.path[0] } : {}),
      };
    }
    const parsed = body.data;
    const resolved = await this.repo.getPeriodOrganization(parsed.billingPeriodId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = mode === "write" ? await this.requirePlugin() : null;
    if (gated) return gated;

    const out = await this.generation.run({
      periodId: parsed.billingPeriodId,
      tenantIds: parsed.tenantIds,
      manualReadings: parsed.manualReadings,
      revertToEdgeTenantIds: parsed.revertToEdgeTenantIds,
      seedReadings: parsed.seedReadings,
      mode,
      actorUserId: this.scope.userId,
      ...(expectedBill ? { expectedBill } : {}),
      ...(guardExistingBills ? { guardExistingBills } : {}),
    });
    if ((out as GenerationFatal).kind === "fatal") {
      const fatal = out as GenerationFatal;
      const status = (
        [400, 401, 403, 404, 409, 422, 500, 503] as const
      ).includes(fatal.status as never)
        ? (fatal.status as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503)
        : 500;
      return {
        ok: false as const,
        status,
        code: fatal.body.code ?? "billing_generation_failed",
        message: fatal.body.error,
      };
    }
    return { ok: true as const, data: out as GenerationOutput };
  }

  async previewBills(input: unknown) {
    return this.runGeneration(input, "preview");
  }

  async generateBills(input: unknown, options: { expectedBill?: ExpectedBill } = {}) {
    return this.runGeneration(input, "write", options.expectedBill);
  }

  async generateFromMeters(periodId: string) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(periodId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_period",
        message: "Invalid billing period id — expected UUID.",
      };
    }
    // Scope and the plugin re-check run in runGeneration, as for every write.
    return this.runGeneration({ billingPeriodId: periodId }, "write", undefined, true);
  }

  async recordManualPayment(lineItemId: string, input: unknown) {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    if (!UUID_RE.test(lineItemId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_line_item",
        message: "Invalid line item id — expected UUID.",
      };
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_body",
        message: "Body must be an object.",
      };
    }
    const rec = input as Record<string, unknown>;
    if (rec.status !== "paid" && rec.status !== "unpaid") {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_payment",
        message: "status must be 'paid' or 'unpaid'.",
        field: "status",
      };
    }
    let notes: string | null = null;
    if (rec.notes !== undefined && rec.notes !== null) {
      if (typeof rec.notes !== "string") {
        return {
          ok: false as const,
          status: 400 as const,
          code: "billing_invalid_payment",
          message: "notes must be a string.",
          field: "notes",
        };
      }
      const trimmed = rec.notes.trim();
      if (trimmed.length > 500) {
        return {
          ok: false as const,
          status: 400 as const,
          code: "billing_invalid_payment",
          message: "notes must be <= 500 chars.",
          field: "notes",
        };
      }
      notes = trimmed.length === 0 ? null : trimmed;
    }
    const resolved = await this.repo.getLineItemOrganization(lineItemId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const { updated, error } = await this.repo.recordManualPayment({
      lineItemId,
      status: rec.status as ManualPaymentStatus,
      notes,
      actorUserId: this.scope.userId,
    });
    if (error) {
      if (error.code === "42501" || error.message.includes("row-level security")) {
        return {
          ok: false as const,
          status: 403 as const,
          code: "billing_forbidden",
          message: "Not authorized to record payments for this line item.",
        };
      }
      return {
        ok: false as const,
        status: 500 as const,
        code: "billing_unavailable",
        message: `Could not record manual payment: ${error.message}.`,
      };
    }
    return { ok: true as const, data: updated };
  }
}
