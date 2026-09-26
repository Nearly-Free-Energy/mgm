/**
 * BillingCapability — typed entry point for the billing plugin's domain
 * operations (issue #5).
 *
 * Import boundary: consumes the repository/generation interfaces only —
 * never a database client, vendor SDK, or framework module. See
 * `__tests__/billing-import-boundary.test.ts`. Bill math lives in the MBE
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
  GenerationFatal,
  GenerationOutput,
  ManualPaymentStatus,
  TierInput,
} from "./repository";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

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

type GenerationBody = {
  billingPeriodId: string;
  householdIds?: string[];
  manualReadings?: { householdId: string; startKwh: number; endKwh: number; reason?: string }[];
  seedReadings?: { deviceId: string; dialReadingKwh: number; readAt: string; startKwh: number }[];
};

function parseGenerationBody(raw: unknown):
  | { parsed: GenerationBody }
  | { error: string; field?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Body must be an object" };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.billingPeriodId !== "string" || !UUID_RE.test(rec.billingPeriodId)) {
    return { error: "billingPeriodId must be a UUID string", field: "billingPeriodId" };
  }
  let householdIds: string[] | undefined;
  if (rec.householdIds !== undefined) {
    if (!Array.isArray(rec.householdIds)) {
      return { error: "householdIds must be an array of UUIDs", field: "householdIds" };
    }
    for (const h of rec.householdIds) {
      if (typeof h !== "string" || !UUID_RE.test(h)) {
        return { error: "householdIds entries must be UUID strings", field: "householdIds" };
      }
    }
    householdIds = rec.householdIds as string[];
  }
  let manualReadings: GenerationBody["manualReadings"];
  if (rec.manualReadings !== undefined) {
    if (!Array.isArray(rec.manualReadings)) {
      return { error: "manualReadings must be an array", field: "manualReadings" };
    }
    const out: NonNullable<GenerationBody["manualReadings"]> = [];
    for (let i = 0; i < rec.manualReadings.length; i++) {
      const m = rec.manualReadings[i] as Record<string, unknown>;
      if (!m || typeof m !== "object") {
        return { error: `manualReadings[${i}] must be an object`, field: "manualReadings" };
      }
      if (typeof m.householdId !== "string" || !UUID_RE.test(m.householdId)) {
        return { error: `manualReadings[${i}].householdId must be a UUID`, field: "manualReadings" };
      }
      if (typeof m.startKwh !== "number" || !Number.isFinite(m.startKwh) || m.startKwh < 0) {
        return {
          error: `manualReadings[${i}].startKwh must be a non-negative finite number`,
          field: "manualReadings",
        };
      }
      if (typeof m.endKwh !== "number" || !Number.isFinite(m.endKwh) || m.endKwh < 0) {
        return {
          error: `manualReadings[${i}].endKwh must be a non-negative finite number`,
          field: "manualReadings",
        };
      }
      if ((m.endKwh as number) < (m.startKwh as number)) {
        return { error: `manualReadings[${i}].endKwh must be >= startKwh`, field: "manualReadings" };
      }
      let reason: string | undefined;
      if (m.reason !== undefined) {
        if (typeof m.reason !== "string") {
          return { error: `manualReadings[${i}].reason must be a string`, field: "manualReadings" };
        }
        if (m.reason.length > 500) {
          return { error: `manualReadings[${i}].reason must be <= 500 chars`, field: "manualReadings" };
        }
        reason = m.reason;
      }
      out.push({
        householdId: m.householdId as string,
        startKwh: m.startKwh as number,
        endKwh: m.endKwh as number,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    manualReadings = out;
  }
  let seedReadings: GenerationBody["seedReadings"];
  if (rec.seedReadings !== undefined) {
    if (!Array.isArray(rec.seedReadings)) {
      return { error: "seedReadings must be an array", field: "seedReadings" };
    }
    const out: NonNullable<GenerationBody["seedReadings"]> = [];
    const seen = new Set<string>();
    for (let i = 0; i < rec.seedReadings.length; i++) {
      const r = rec.seedReadings[i] as Record<string, unknown>;
      if (!r || typeof r !== "object") {
        return { error: `seedReadings[${i}] must be an object`, field: "seedReadings" };
      }
      if (typeof r.deviceId !== "string" || !UUID_RE.test(r.deviceId)) {
        return { error: `seedReadings[${i}].deviceId must be a UUID`, field: "seedReadings" };
      }
      if (seen.has(r.deviceId)) {
        return {
          error: `seedReadings has more than one entry for device ${r.deviceId}`,
          field: "seedReadings",
        };
      }
      seen.add(r.deviceId);
      for (const f of ["dialReadingKwh", "startKwh"] as const) {
        const v = r[f];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          return {
            error: `seedReadings[${i}].${f} must be a non-negative finite number`,
            field: "seedReadings",
          };
        }
      }
      if (typeof r.readAt !== "string" || Number.isNaN(Date.parse(r.readAt))) {
        return { error: `seedReadings[${i}].readAt must be an ISO timestamp`, field: "seedReadings" };
      }
      if ((r.startKwh as number) > (r.dialReadingKwh as number)) {
        return {
          error: `seedReadings[${i}].startKwh cannot exceed dialReadingKwh`,
          field: "seedReadings",
        };
      }
      out.push({
        deviceId: r.deviceId,
        dialReadingKwh: r.dialReadingKwh as number,
        readAt: r.readAt as string,
        startKwh: r.startKwh as number,
      });
    }
    seedReadings = out;
  }
  return {
    parsed: {
      billingPeriodId: rec.billingPeriodId as string,
      ...(householdIds !== undefined ? { householdIds } : {}),
      ...(manualReadings !== undefined ? { manualReadings } : {}),
      ...(seedReadings !== undefined ? { seedReadings } : {}),
    },
  };
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

  private async requirePlugin(): Promise<Extract<
    BillingResult<never>,
    { ok: false }
  > | null> {
    if (await this.repo.isPluginEnabled(this.scope.organizationId)) return null;
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
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_period",
        message: "Body must be an object.",
      };
    }
    const rec = input as Record<string, unknown>;
    const microgridId = typeof rec.microgrid_id === "string" ? rec.microgrid_id : "";
    if (!UUID_RE.test(microgridId)) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_microgrid",
        message: "microgrid_id must be a valid UUID.",
        field: "microgrid_id",
      };
    }
    const resolved = await this.repo.getMicrogridOrganization(microgridId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const startDate = typeof rec.start_date === "string" ? rec.start_date : "";
    const endDate = typeof rec.end_date === "string" ? rec.end_date : "";
    if (!isRealDate(startDate) || !isRealDate(endDate) || startDate > endDate) {
      return {
        ok: false as const,
        status: 422 as const,
        code: "billing_invalid_range",
        message: "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.",
        field: "start_date",
      };
    }
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
    const summary = await this.repo.getPeriodSummary(periodId);
    if (!summary) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "billing_period_not_found",
        message: "Billing period not found.",
      };
    }
    return { ok: true as const, data: summary };
  }

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

    const summary = await this.repo.getPeriodSummary(periodId);
    if (!summary) {
      return {
        ok: false as const,
        status: 404 as const,
        code: "billing_period_not_found",
        message: "Billing period not found.",
      };
    }
    if (summary.period.status === "closed") {
      return {
        ok: false as const,
        status: 409 as const,
        code: "billing_period_closed",
        message: "Billing period is already closed.",
      };
    }
    const confirmed =
      !!input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>).confirmed === true
        : false;
    if (summary.unresolved.length > 0 && !confirmed) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "billing_unresolved_households",
        message: `Period has ${summary.unresolved.length} unresolved household(s). Confirm explicitly to close anyway.`,
      };
    }
    const { row, error } = await this.repo.closeBillingPeriod(periodId);
    if (error || !row) {
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
    return { ok: true as const, data: { period: row, unresolved: summary.unresolved } };
  }

  private async runGeneration(input: unknown, mode: "write" | "preview") {
    const inactive = this.ensureActive();
    if (inactive) return inactive;
    const parsed = parseGenerationBody(input);
    if ("error" in parsed) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "billing_invalid_body",
        message: parsed.error,
        ...(parsed.field ? { field: parsed.field } : {}),
      };
    }
    const resolved = await this.repo.getPeriodOrganization(parsed.parsed.billingPeriodId);
    if (!resolved || resolved.orgId !== this.scope.organizationId) {
      return this.scopeMismatch();
    }
    const gated = await this.requirePlugin();
    if (gated) return gated;

    const out = await this.generation.run({
      periodId: parsed.parsed.billingPeriodId,
      householdIds: parsed.parsed.householdIds,
      manualReadings: parsed.parsed.manualReadings,
      seedReadings: parsed.parsed.seedReadings,
      mode,
      actorUserId: this.scope.userId,
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

  async generateBills(input: unknown) {
    return this.runGeneration(input, "write");
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
