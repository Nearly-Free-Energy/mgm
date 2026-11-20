import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingCapability } from "../capability";
import { CLOSE_REFUSAL_COPY, fractionalTotalsMessage, parseCloseReview, type CloseReview } from "../close";
import { PERIOD_KEPT_CLOSED_MESSAGE, PERIOD_KEPT_PAYMENTS_MESSAGE } from "../period-delete";
import type {
  BillingGeneration,
  BillingRepository,
  BillingScope,
} from "../repository";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "770e8400-e29b-41d4-a716-446655440000";
const ITEM_ID = "880e8400-e29b-41d4-a716-446655440000";
const TENANT_ID = "990e8400-e29b-41d4-a716-446655441111";

const scope: BillingScope = {
  organizationId: ORG_ID,
  userId: "user-1",
  roles: [],
};

const REVIEW_ROW = {
  periodId: PERIOD_ID,
  microgridId: MG_ID,
  status: "draft",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  currency: "UGX",
  billCount: 1,
  totalAmount: 100,
  usageKwh: 10,
  unbilled: [] as { tenantId: string; tenantName: string }[],
  unmetered: [] as { tenantId: string; tenantName: string }[],
  fractionalTotals: [] as { tenantId: string; tenantName: string }[],
  acknowledgements: ["totals_reviewed"],
  digest: "v1:reviewed",
};

function review(overrides: Partial<typeof REVIEW_ROW> = {}): CloseReview {
  const parsed = parseCloseReview({ ...REVIEW_ROW, ...overrides });
  if (!parsed) throw new Error("review fixture does not parse");
  return parsed;
}

/** A delete of the September period as the host sends it. */
const TYPED = { confirmation: { acknowledged: [], typed: "September 2026" } };

/** A confirmation of REVIEW_ROW as the host sends it. */
const CONFIRMED = {
  confirmation: { digest: "v1:reviewed", acknowledged: ["totals_reviewed"], typed: "September 2026" },
};

const TARIFF = {
  microgrid_id: MG_ID,
  tiers: [{ label: "T1", min_kwh: 1, max_kwh: null, rate_per_kwh: 100 }],
  service_charge: 0,
  tax_rate: 0,
};

function stubRepo(overrides: Partial<BillingRepository> = {}): BillingRepository {
  return {
    getAuthenticatedUserId: async () => "user-1",
    getUserRoles: async () => [],
    isPluginEnabled: async () => true,
    getMicrogridOrganization: async (id: string) =>
      id === MG_ID
        ? { microgridId: MG_ID, communityId: "comm-1", orgId: ORG_ID }
        : null,
    getPeriodOrganization: async (id: string) =>
      id === PERIOD_ID
        ? { periodId: PERIOD_ID, microgridId: MG_ID, orgId: ORG_ID }
        : null,
    getLineItemOrganization: async (id: string) =>
      id === ITEM_ID
        ? { lineItemId: ITEM_ID, microgridId: MG_ID, orgId: ORG_ID }
        : null,
    getMicrogridTimezone: async () => "Africa/Kampala",
    getLatestRateSchedule: async () => null,
    createRateSchedule: async (input) => ({
      row: {
        id: "rs-1",
        microgrid_id: input.microgridId,
        tiers: input.tiers,
        service_charge: input.serviceCharge,
        tax_rate: input.taxRate,
        created_at: new Date().toISOString(),
      },
      error: null,
    }),
    createBillingPeriod: async (input) => ({
      row: {
        id: PERIOD_ID,
        microgrid_id: input.microgridId,
        start_date: input.startDate,
        end_date: input.endDate,
        status: "draft",
        timezone: input.timezone,
      },
      error: null,
    }),
    getPeriodSummary: async () => ({
      period: {
        id: PERIOD_ID,
        microgrid_id: MG_ID,
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        status: "draft",
        timezone: "Africa/Kampala",
      },
      lineItemCount: 0,
      totalAmount: 0,
      unresolved: [],
    }),
    getCloseReview: async () => review(),
    closeBillingPeriod: async () => ({
      row: {
        id: PERIOD_ID,
        microgrid_id: MG_ID,
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        status: "closed",
        timezone: "Africa/Kampala",
      },
      error: null,
    }),
    recordManualPayment: async () => ({ updated: { id: ITEM_ID }, error: null }),
    getBillingPeriod: async (id: string) =>
      id === PERIOD_ID
        ? {
            id: PERIOD_ID,
            microgrid_id: MG_ID,
            start_date: "2026-09-01",
            end_date: "2026-09-30",
            status: "draft",
            timezone: "Africa/Kampala",
          }
        : null,
    deleteBillingPeriod: async () => ({ deleted: true, error: null }),
    ...overrides,
  };
}

function stubGeneration(
  overrides: Partial<BillingGeneration> = {}
): BillingGeneration {
  return {
    run: async () => ({ results: [] }),
    ...overrides,
  };
}

function setup(
  repoOverrides: Partial<BillingRepository> = {},
  generationOverrides: Partial<BillingGeneration> = {},
  isActive: () => boolean = () => true
) {
  const repo = stubRepo(repoOverrides);
  const generation = stubGeneration(generationOverrides);
  const capability = new BillingCapability(repo, scope, generation, isActive);
  return { capability, repo, generation };
}

describe("BillingCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects cross-organization tariffs without writing", async () => {
    const create = vi.fn();
    const { capability } = setup({ createRateSchedule: create });
    const result = await capability.createTariff({
      ...TARIFF,
      microgrid_id: "660e8400-e29b-41d4-a716-446655440099",
    });
    expect(result).toMatchObject({ ok: false, status: 403, code: "billing_scope_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed when the billing plugin is disabled", async () => {
    const create = vi.fn();
    const { capability } = setup({ isPluginEnabled: async () => false, createRateSchedule: create });
    const result = await capability.createTariff(TARIFF);
    expect(result).toMatchObject({ ok: false, status: 409, code: "billing_disabled" });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects non-contiguous tiers", async () => {
    const { capability } = setup();
    const result = await capability.createTariff({
      ...TARIFF,
      tiers: [
        { label: "T1", min_kwh: 1, max_kwh: 10, rate_per_kwh: 100 },
        { label: "T2", min_kwh: 12, max_kwh: null, rate_per_kwh: 200 },
      ],
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "billing_invalid_tariff" });
  });

  it("stamps the period timezone from the microgrid", async () => {
    const create = vi.fn(async (input: {
      microgridId: string;
      startDate: string;
      endDate: string;
      timezone: string;
    }) => ({
      row: {
        id: PERIOD_ID,
        microgrid_id: input.microgridId,
        start_date: input.startDate,
        end_date: input.endDate,
        status: "draft" as const,
        timezone: input.timezone,
      },
      error: null,
    }));
    const { capability } = setup({ createBillingPeriod: create });
    const result = await capability.createPeriod({
      microgrid_id: MG_ID,
      start_date: "2026-09-01",
      end_date: "2026-09-30",
    });
    expect(result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Africa/Kampala" })
    );
  });

  it("reports overlapping period rejection as a conflict", async () => {
    const { capability } = setup({
      createBillingPeriod: async () => ({
        row: null,
        error: { code: "23P01", message: "overlap" },
      }),
    });
    const result = await capability.createPeriod({
      microgrid_id: MG_ID,
      start_date: "2026-09-15",
      end_date: "2026-10-14",
    });
    expect(result).toMatchObject({
      ok: false, status: 409, code: "billing_period_overlap",
    });
  });

  it("rejects an inverted period range", async () => {
    const { capability } = setup();
    const result = await capability.createPeriod({
      microgrid_id: MG_ID,
      start_date: "2026-09-30",
      end_date: "2026-09-01",
    });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "billing_invalid_range",
      message: "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.",
      field: "start_date",
    });
  });

  it("parses a period with CreatePeriodBody, keeping its codes and its order of checks", async () => {
    const create = vi.fn();
    const { capability } = setup({ createBillingPeriod: create });
    expect(await capability.createPeriod({ microgrid_id: "{" + MG_ID + "}", start_date: "2026-09-01", end_date: "2026-09-30" }))
      .toMatchObject({ status: 400, code: "billing_invalid_microgrid", message: "microgrid_id must be a valid UUID.", field: "microgrid_id" });
    expect(await capability.createPeriod({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30", timezone: "UTC" }))
      .toMatchObject({ status: 400, code: "billing_invalid_period", message: "Unknown field: timezone" });
    expect(await capability.createPeriod(null)).toMatchObject({ status: 400, code: "billing_invalid_period" });
    expect(await capability.createPeriod({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-02-30" }))
      .toMatchObject({ status: 422, code: "billing_invalid_range", field: "end_date" });
    expect(create).not.toHaveBeenCalled();
    // A fault in the dates still answers only after the scope check.
    const other = setup({ getMicrogridOrganization: async () => ({ microgridId: MG_ID, communityId: "comm-1", orgId: "550e8400-e29b-41d4-a716-446655440099" }) });
    expect(await other.capability.createPeriod({ microgrid_id: MG_ID, start_date: "x", end_date: "y" }))
      .toMatchObject({ status: 403, code: "billing_scope_mismatch" });
  });

  it("answers 428 with the review when no confirmation is sent, and writes nothing", async () => {
    const close = vi.fn();
    const { capability } = setup({ closeBillingPeriod: close });
    for (const input of [undefined, {}]) {
      const result = await capability.closePeriod(PERIOD_ID, input);
      expect(result).toMatchObject({
        ok: false,
        status: 428,
        code: "billing_close_confirmation_required",
        review: {
          digest: "v1:reviewed",
          name: "September 2026",
          billCount: 1,
          totalAmount: 100,
          acknowledgements: [{ id: "totals_reviewed" }],
        },
      });
    }
    expect(close).not.toHaveBeenCalled();
  });

  it.each([undefined, CONFIRMED])("answers 409 to %j while a bill's total is not a whole number, and writes nothing", async (input) => {
    const close = vi.fn();
    const { capability } = setup({
      getCloseReview: async () => review({ totalAmount: 100.5, fractionalTotals: [{ tenantId: "hh-1", tenantName: "House 1" }] }),
      closeBillingPeriod: close,
    });
    expect(await capability.closePeriod(PERIOD_ID, input)).toMatchObject({
      ok: false,
      status: 409,
      code: "billing_close_fractional_totals",
      message: "Regenerate the bills for House 1 before closing: their totals are not whole numbers.",
      review: { fractionalTotals: [{ tenantName: "House 1" }] },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("names fractional totals in its 409 as the close checklist does, five and then a count", async () => {
    const fractional = Array.from({ length: 7 }, (_, i) => ({ tenantId: `hh-${i + 1}`, tenantName: `House ${i + 1}` }));
    const current = review({ totalAmount: 100.5, fractionalTotals: fractional });
    const { capability } = setup({ getCloseReview: async () => current });
    const result = await capability.closePeriod(PERIOD_ID, CONFIRMED);
    expect(result).toMatchObject({
      status: 409,
      code: "billing_close_fractional_totals",
      message:
        "Regenerate the bills for House 1, House 2, House 3, House 4, House 5 and 2 more before closing: their totals are not whole numbers.",
    });
    // The sentence the contributed close action's prepare and availability give (surface/close-checklist.ts).
    expect(result).toMatchObject({ message: fractionalTotalsMessage(current.fractionalTotals) });
  });

  it("answers 409 with the current review when the confirmed digest is not the current one", async () => {
    const close = vi.fn();
    const { capability } = setup({
      getCloseReview: async () => review({ digest: "v1:current", totalAmount: 250 }),
      closeBillingPeriod: close,
    });
    const result = await capability.closePeriod(PERIOD_ID, CONFIRMED);
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "billing_period_totals_changed",
      message: CLOSE_REFUSAL_COPY.totalsChanged,
      review: { digest: "v1:current", totalAmount: 250 },
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("requires every acknowledgement the review lists, then closes and reports the unbilled tenants", async () => {
    const close = vi.fn(async () => ({
      row: {
        id: PERIOD_ID,
        microgrid_id: MG_ID,
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        status: "closed" as const,
        timezone: "Africa/Kampala",
      },
      error: null,
    }));
    const { capability } = setup({
      getCloseReview: async () =>
        review({
          unbilled: [{ tenantId: "hh-1", tenantName: "No Bill" }],
          acknowledgements: ["totals_reviewed", "tenants_without_bills"],
        }),
      closeBillingPeriod: close,
    });
    const partial = await capability.closePeriod(PERIOD_ID, CONFIRMED);
    expect(partial).toMatchObject({
      ok: false,
      status: 428,
      code: "billing_close_acknowledgement_missing",
      field: "confirmation",
    });
    expect(close).not.toHaveBeenCalled();

    const acknowledged = ["totals_reviewed", "tenants_without_bills"];
    const confirmed = await capability.closePeriod(PERIOD_ID, {
      confirmation: { ...CONFIRMED.confirmation, acknowledged },
    });
    expect(confirmed).toMatchObject({
      ok: true,
      data: {
        period: { status: "closed" },
        unresolved: [
          { tenantId: "hh-1", tenantName: "No Bill", reason: "No bill generated for this tenant in this period." },
        ],
      },
    });
    expect(close).toHaveBeenCalledWith(PERIOD_ID, { digest: "v1:reviewed", acknowledged });
  });

  it.each([undefined, "", "October 2026", "September"])(
    "answers 428 when the typed name is %j rather than the period's name",
    async (typed) => {
      const close = vi.fn();
      const { capability } = setup({ closeBillingPeriod: close });
      const result = await capability.closePeriod(PERIOD_ID, {
        confirmation: { digest: "v1:reviewed", acknowledged: ["totals_reviewed"], ...(typed === undefined ? {} : { typed }) },
      });
      expect(result).toMatchObject({ ok: false, status: 428, code: "billing_close_name_mismatch" });
      expect(close).not.toHaveBeenCalled();
    }
  );

  it("accepts the period's name typed in another case or with other spacing", async () => {
    const { capability } = setup();
    const result = await capability.closePeriod(PERIOD_ID, {
      confirmation: { ...CONFIRMED.confirmation, typed: "  september   2026 " },
    });
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    [{ confirmed: true }, "Unknown field: confirmed"],
    [{ confirmation: { acknowledged: [] } }, undefined],
    [{ confirmation: { digest: "v1:reviewed", acknowledged: "totals_reviewed" } }, undefined],
    [[], "Request body must be an object"],
  ])("answers 400 to the body %j", async (input, message) => {
    const close = vi.fn();
    const { capability } = setup({ closeBillingPeriod: close });
    const result = await capability.closePeriod(PERIOD_ID, input);
    expect(result).toMatchObject({ ok: false, status: 400, code: "billing_invalid_body" });
    if (message) expect(result).toMatchObject({ message });
    expect(close).not.toHaveBeenCalled();
  });

  it.each([undefined, CONFIRMED])("blocks closure when the review cannot be read, with input %j", async (input) => {
    const close = vi.fn();
    const { capability } = setup({
      getCloseReview: async () => { throw new Error("query failed"); },
      closeBillingPeriod: close,
    });
    expect(await capability.closePeriod(PERIOD_ID, input)).toMatchObject({
      ok: false, status: 503, code: "billing_review_unavailable",
    });
    expect(close).not.toHaveBeenCalled();
    expect(await capability.getCloseReview(PERIOD_ID)).toMatchObject({
      ok: false, status: 503, code: "billing_review_unavailable",
    });
  });

  it("answers 404 when the review finds no period the caller can see", async () => {
    const { capability } = setup({ getCloseReview: async () => null });
    expect(await capability.closePeriod(PERIOD_ID, CONFIRMED)).toMatchObject({
      ok: false, status: 404, code: "billing_period_not_found",
    });
  });

  it("refuses to close an already-closed period", async () => {
    const close = vi.fn();
    const { capability } = setup({
      getCloseReview: async () => review({ status: "closed" }),
      closeBillingPeriod: close,
    });
    const result = await capability.closePeriod(PERIOD_ID, CONFIRMED);
    expect(result).toMatchObject({ ok: false, status: 409, code: "billing_period_closed" });
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "23514", message: "billing_close_totals_changed: the period's totals changed" }, 409, "billing_period_totals_changed"],
    [{ code: "23514", message: "billing_close_acknowledgement_missing: tenants_without_bills" }, 428, "billing_close_acknowledgement_missing"],
    [{ code: "23514", message: "billing_close_fractional_total: 1 bill(s) have a total that is not a whole number" }, 409, "billing_close_fractional_totals"],
    [{ code: "23514", message: "billing_period_closed: the billing period is already closed" }, 409, "billing_period_closed"],
    [{ code: "P0002", message: "billing_period_not_found: no such period" }, 404, "billing_period_not_found"],
    [{ code: "42501", message: "permission denied" }, 403, "billing_forbidden"],
    [{ code: "XX000", message: "boom" }, 500, "billing_unavailable"],
  ])("maps the database's refusal %j to %i %s", async (error, status, code) => {
    const { capability } = setup({
      closeBillingPeriod: async () => ({ row: null, error }),
    });
    expect(await capability.closePeriod(PERIOD_ID, CONFIRMED)).toMatchObject({ ok: false, status, code });
  });

  it("returns the current review when the database finds the totals changed during the close", async () => {
    let reads = 0;
    const { capability } = setup({
      getCloseReview: async () => (++reads === 1 ? review() : review({ digest: "v1:later", totalAmount: 300 })),
      closeBillingPeriod: async () => ({
        row: null,
        error: { code: "23514", message: "billing_close_totals_changed: the period's totals changed" },
      }),
    });
    expect(await capability.closePeriod(PERIOD_ID, CONFIRMED)).toMatchObject({
      ok: false,
      status: 409,
      code: "billing_period_totals_changed",
      message: CLOSE_REFUSAL_COPY.totalsChanged,
      review: { digest: "v1:later", totalAmount: 300 },
    });
  });

  it("reads the close review in scope, and refuses another organization's period", async () => {
    const { capability } = setup();
    expect(await capability.getCloseReview(PERIOD_ID)).toMatchObject({
      ok: true,
      data: { digest: "v1:reviewed", name: "September 2026" },
    });
    expect(await capability.getCloseReview("990e8400-e29b-41d4-a716-446655440000")).toMatchObject({
      ok: false, status: 403, code: "billing_scope_mismatch",
    });
    expect(await capability.getCloseReview("not-a-uuid")).toMatchObject({
      ok: false, status: 400, code: "billing_invalid_period",
    });
  });

  it("delegates preview without writing and maps fatal errors", async () => {
    const run = vi.fn(async () => ({
      kind: "fatal" as const,
      status: 404,
      body: { error: "Billing period not found" },
    }));
    const { capability } = setup({ isPluginEnabled: async () => false }, { run });
    const result = await capability.previewBills({ billingPeriodId: PERIOD_ID });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ mode: "preview" }));
  });

  it("passes revertToEdgeTenantIds to the generation delegate", async () => {
    const HH = "990e8400-e29b-41d4-a716-446655440000";
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    const result = await capability.generateBills({
      billingPeriodId: PERIOD_ID,
      tenantIds: [HH],
      revertToEdgeTenantIds: [HH],
    });
    expect(result).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "write", revertToEdgeTenantIds: [HH] })
    );
  });

  it("rejects a tenant in both manualReadings and revertToEdgeTenantIds", async () => {
    const HH = "990e8400-e29b-41d4-a716-446655440000";
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    const result = await capability.generateBills({
      billingPeriodId: PERIOD_ID,
      manualReadings: [{ tenantId: HH, startKwh: 1, endKwh: 2 }],
      revertToEdgeTenantIds: [HH],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: "billing_invalid_body",
      message: `Tenant ${HH} cannot be in both manualReadings and revertToEdgeTenantIds`,
      field: "revertToEdgeTenantIds",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("parses generation with GenerateBillsBody, seeds included in preview", async () => {
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    expect(await capability.generateBills({ billingPeriodId: PERIOD_ID, extra: 1 })).toMatchObject({
      status: 400,
      code: "billing_invalid_body",
      message: "Unknown field: extra",
    });
    expect(await capability.previewBills(null)).toMatchObject({
      status: 400,
      code: "billing_invalid_body",
      message: "Body must be an object",
    });
    const seed = { deviceId: MG_ID, dialReadingKwh: 10, readAt: "2026-08-20", startKwh: 4 };
    expect(await capability.previewBills({ billingPeriodId: PERIOD_ID, seedReadings: [seed] })).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ mode: "preview", seedReadings: [seed] }));
  });

  it("generates a period from meter data as a guarded whole-period run, and nothing else", async () => {
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    expect(await capability.generateFromMeters(PERIOD_ID)).toEqual({ ok: true, data: { results: [] } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      periodId: PERIOD_ID,
      tenantIds: undefined,
      manualReadings: undefined,
      revertToEdgeTenantIds: undefined,
      seedReadings: undefined,
      mode: "write",
      actorUserId: "user-1",
      guardExistingBills: true,
    });
  });

  it("refuses to generate from meter data for a bad id or another organization's period, before the engine", async () => {
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    expect(await capability.generateFromMeters("not-a-uuid")).toMatchObject({ ok: false, status: 400, code: "billing_invalid_period" });
    expect(await capability.generateFromMeters("990e8400-e29b-41d4-a716-446655440000")).toMatchObject({
      ok: false,
      status: 403,
      code: "billing_scope_mismatch",
    });
    expect(run).not.toHaveBeenCalled();
    const disposed = setup({}, { run }, () => false).capability;
    expect(await disposed.generateFromMeters(PERIOD_ID)).toMatchObject({ ok: false, code: "billing_composition_disposed" });
  });

  it("maps the engine's fatal refusal of a closed period", async () => {
    const run = vi.fn(async () => ({
      kind: "fatal" as const,
      status: 409,
      body: { error: "Bills cannot be generated in a closed period.", code: "billing_period_closed" },
    }));
    const { capability } = setup({}, { run });
    expect(await capability.generateFromMeters(PERIOD_ID)).toEqual({
      ok: false,
      status: 409,
      code: "billing_period_closed",
      message: "Bills cannot be generated in a closed period.",
    });
  });

  it("bills one tenant from readings as a first-bill run naming that tenant and their reading, and nothing else", async () => {
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    expect(await capability.billFromReadings(PERIOD_ID, TENANT_ID, { startKwh: 100.5, endKwh: 150, reason: "  Read on site  " })).toEqual({
      ok: true,
      data: { results: [] },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      periodId: PERIOD_ID,
      tenantIds: [TENANT_ID],
      manualReadings: [{ tenantId: TENANT_ID, startKwh: 100.5, endKwh: 150, reason: "Read on site" }],
      revertToEdgeTenantIds: undefined,
      seedReadings: undefined,
      mode: "write",
      actorUserId: "user-1",
      newBillOnly: true,
    });
  });

  it.each([undefined, "", "   "])("leaves out a reason of %j", async (reason) => {
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    await capability.billFromReadings(PERIOD_ID, TENANT_ID, { startKwh: 0, endKwh: 0, ...(reason === undefined ? {} : { reason }) });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ manualReadings: [{ tenantId: TENANT_ID, startKwh: 0, endKwh: 0 }] }));
  });

  it("refuses to bill from readings for a bad id, another organization's period or readings that go backwards, before the engine", async () => {
    const run = vi.fn(async () => ({ results: [] }));
    const { capability } = setup({}, { run });
    const readings = { startKwh: 1, endKwh: 2 };
    expect(await capability.billFromReadings("not-a-uuid", TENANT_ID, readings)).toMatchObject({ ok: false, status: 400, code: "billing_invalid_period" });
    expect(await capability.billFromReadings(PERIOD_ID, "not-a-uuid", readings)).toEqual({
      ok: false,
      status: 400,
      code: "billing_invalid_tenant",
      message: "Invalid tenant id — expected UUID.",
    });
    expect(await capability.billFromReadings("990e8400-e29b-41d4-a716-446655440000", TENANT_ID, readings)).toMatchObject({
      ok: false,
      status: 403,
      code: "billing_scope_mismatch",
    });
    expect(await capability.billFromReadings(PERIOD_ID, TENANT_ID, { startKwh: 2, endKwh: 1 })).toMatchObject({
      ok: false,
      status: 400,
      code: "billing_invalid_body",
    });
    expect(run).not.toHaveBeenCalled();
    const disposed = setup({}, { run }, () => false).capability;
    expect(await disposed.billFromReadings(PERIOD_ID, TENANT_ID, readings)).toMatchObject({ ok: false, code: "billing_composition_disposed" });
  });

  it("records manual paid/unpaid with trimmed notes", async () => {
    const record = vi.fn(async () => ({ updated: { id: ITEM_ID }, error: null }));
    const { capability } = setup({ recordManualPayment: record });
    const result = await capability.recordManualPayment(ITEM_ID, {
      status: "paid",
      notes: "  receipt #123  ",
    });
    expect(result).toMatchObject({ ok: true });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paid", notes: "receipt #123" })
    );
  });

  it("rejects gateway-class payment statuses", async () => {
    const { capability } = setup();
    const result = await capability.recordManualPayment(ITEM_ID, { status: "failed" });
    expect(result).toMatchObject({ ok: false, status: 400, code: "billing_invalid_payment" });
  });

  it("deactivates after dispose", async () => {
    const { capability } = setup({}, {}, () => false);
    const result = await capability.getPeriodSummary(PERIOD_ID);
    expect(result).toMatchObject({ ok: false, code: "billing_composition_disposed" });
  });
});

describe("BillingCapability.deletePeriod (#201)", () => {
  const SEPTEMBER = {
    id: PERIOD_ID,
    microgrid_id: MG_ID,
    start_date: "2026-09-01",
    end_date: "2026-09-30",
    status: "draft" as const,
    timezone: "Africa/Kampala",
  };

  it("deletes a draft against its typed name and names the list to return to", async () => {
    const remove = vi.fn(async () => ({ deleted: true, error: null }));
    const { capability } = setup({ deleteBillingPeriod: remove });
    expect(await capability.deletePeriod(PERIOD_ID, TYPED)).toEqual({
      ok: true,
      data: { periodId: PERIOD_ID, microgridId: MG_ID, name: "September 2026" },
    });
    expect(remove).toHaveBeenCalledWith(PERIOD_ID);
  });

  it("matches the typed name whatever its case and spacing", async () => {
    const { capability } = setup();
    const result = await capability.deletePeriod(PERIOD_ID, { confirmation: { acknowledged: [], typed: "  september   2026 " } });
    expect(result).toMatchObject({ ok: true });
  });

  it("400 for an id that is not a UUID, before any read", async () => {
    const lookup = vi.fn();
    const { capability } = setup({ getPeriodOrganization: lookup });
    expect(await capability.deletePeriod("nope", TYPED)).toMatchObject({ ok: false, status: 400, code: "billing_invalid_period" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("403 for a period in another organization, or one the caller cannot see", async () => {
    const remove = vi.fn();
    const other = setup({
      getPeriodOrganization: async () => ({ periodId: PERIOD_ID, microgridId: MG_ID, orgId: "550e8400-e29b-41d4-a716-446655440099" }),
      deleteBillingPeriod: remove,
    });
    expect(await other.capability.deletePeriod(PERIOD_ID, TYPED)).toMatchObject({ ok: false, status: 403, code: "billing_scope_mismatch" });
    const hidden = setup({ getPeriodOrganization: async () => null, deleteBillingPeriod: remove });
    expect(await hidden.capability.deletePeriod(PERIOD_ID, TYPED)).toMatchObject({ ok: false, status: 403, code: "billing_scope_mismatch" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("409 while billing is disabled", async () => {
    const remove = vi.fn();
    const { capability } = setup({ isPluginEnabled: async () => false, deleteBillingPeriod: remove });
    expect(await capability.deletePeriod(PERIOD_ID, TYPED)).toMatchObject({ ok: false, status: 409, code: "billing_disabled" });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown field", { confirmed: true }, undefined],
    ["a digest", { confirmation: { digest: "v1:x", acknowledged: [], typed: "September 2026" } }, "confirmation"],
    ["no acknowledgements", { confirmation: { typed: "September 2026" } }, "confirmation"],
  ])("400 for %s", async (_label, input, field) => {
    const { capability } = setup();
    const result = await capability.deletePeriod(PERIOD_ID, input);
    expect(result).toMatchObject({ ok: false, status: 400, code: "billing_invalid_body" });
    expect((result as { field?: string }).field).toBe(field);
  });

  it("404 when the period is gone by the time it is read", async () => {
    const { capability } = setup({ getBillingPeriod: async () => null });
    expect(await capability.deletePeriod(PERIOD_ID, TYPED)).toMatchObject({ ok: false, status: 404, code: "billing_period_not_found" });
  });

  it("503 when the period cannot be read", async () => {
    const { capability } = setup({
      getBillingPeriod: async () => {
        throw new Error("timeout");
      },
    });
    expect(await capability.deletePeriod(PERIOD_ID, TYPED)).toMatchObject({ ok: false, status: 503, code: "billing_unavailable" });
  });

  it("409 for a closed period before asking for its name", async () => {
    const remove = vi.fn();
    const { capability } = setup({ getBillingPeriod: async () => ({ ...SEPTEMBER, status: "closed" }), deleteBillingPeriod: remove });
    expect(await capability.deletePeriod(PERIOD_ID, {})).toEqual({
      ok: false,
      status: 409,
      code: "billing_period_kept",
      message: PERIOD_KEPT_CLOSED_MESSAGE,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("428 naming the period when no confirmation is sent, and deletes nothing", async () => {
    const remove = vi.fn();
    const { capability } = setup({ deleteBillingPeriod: remove });
    expect(await capability.deletePeriod(PERIOD_ID, {})).toEqual({
      ok: false,
      status: 428,
      code: "billing_delete_confirmation_required",
      message: "Type the period's name, September 2026, to delete it.",
    });
    expect(await capability.deletePeriod(PERIOD_ID)).toMatchObject({ status: 428 });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    ["the wrong name", { acknowledged: [], typed: "October 2026" }],
    ["no name", { acknowledged: [] }],
  ])("428 on the confirmation field for %s", async (_label, confirmation) => {
    const remove = vi.fn();
    const { capability } = setup({ deleteBillingPeriod: remove });
    expect(await capability.deletePeriod(PERIOD_ID, { confirmation })).toEqual({
      ok: false,
      status: 428,
      code: "billing_delete_name_mismatch",
      message: "Type the period's name, September 2026, to delete it.",
      field: "confirmation",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "23514", message: "billing_period_kept: closed", details: "closed" }, 409, "billing_period_kept", PERIOD_KEPT_CLOSED_MESSAGE],
    [
      { code: "23514", message: "billing_period_kept: payments", details: "payment_activity" },
      409,
      "billing_period_kept",
      PERIOD_KEPT_PAYMENTS_MESSAGE,
    ],
    [
      { code: "23503", message: "violates foreign key constraint", details: null },
      409,
      "billing_period_referenced",
      "This period has imported pilot data and cannot be deleted.",
    ],
    [
      { code: "55000", message: "billing_disabled: billing is turned off for this organization", details: null },
      409,
      "billing_disabled",
      "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.",
    ],
    // Another 55000 is not the function's gate refusal.
    [{ code: "55000", message: "object not in prerequisite state", details: null }, 500, "billing_unavailable", "Could not delete the billing period."],
    [{ code: "42501", message: "permission denied", details: null }, 403, "billing_forbidden", "Not authorized to delete this billing period."],
    [{ code: "XX000", message: "boom", details: null }, 500, "billing_unavailable", "Could not delete the billing period."],
  ])("maps the database's refusal %j", async (error, status, code, message) => {
    const { capability } = setup({ deleteBillingPeriod: async () => ({ deleted: false, error }) });
    expect(await capability.deletePeriod(PERIOD_ID, TYPED)).toEqual({ ok: false, status, code, message });
  });

  it("404 when row-level security lets no row be deleted", async () => {
    const { capability } = setup({ deleteBillingPeriod: async () => ({ deleted: false, error: null }) });
    expect(await capability.deletePeriod(PERIOD_ID, TYPED)).toMatchObject({ ok: false, status: 404, code: "billing_period_not_found" });
  });

  it("answers inactive after disposal", async () => {
    const remove = vi.fn();
    const { capability } = setup({ deleteBillingPeriod: remove }, {}, () => false);
    expect(await capability.deletePeriod(PERIOD_ID, TYPED)).toMatchObject({ ok: false, code: "billing_composition_disposed" });
    expect(remove).not.toHaveBeenCalled();
  });
});

/**
 * Every write re-reads plugin state just before it writes. The lookups that
 * resolve the organization run first; anything else on the repository or the
 * bill engine runs only once the re-check passes. Whether the wording matches
 * the gate's is checked end to end, through the real repository, in
 * runtime/__tests__/compose-fail-closed.test.ts.
 */
const READ_BEFORE_RECHECK = new Set<string>([
  "getMicrogridOrganization",
  "getPeriodOrganization",
  "getLineItemOrganization",
  "isPluginEnabled",
]);

const WRITES: { method: string; run: (capability: BillingCapability) => Promise<unknown> }[] = [
  { method: "createTariff", run: (c) => c.createTariff(TARIFF) },
  {
    method: "createPeriod",
    run: (c) =>
      c.createPeriod({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30" }),
  },
  { method: "closePeriod", run: (c) => c.closePeriod(PERIOD_ID, CONFIRMED) },
  { method: "deletePeriod", run: (c) => c.deletePeriod(PERIOD_ID, TYPED) },
  { method: "generateBills", run: (c) => c.generateBills({ billingPeriodId: PERIOD_ID }) },
  { method: "generateFromMeters", run: (c) => c.generateFromMeters(PERIOD_ID) },
  { method: "billFromReadings", run: (c) => c.billFromReadings(PERIOD_ID, TENANT_ID, { startKwh: 1, endKwh: 2 }) },
  { method: "recordManualPayment", run: (c) => c.recordManualPayment(ITEM_ID, { status: "paid" }) },
];

function spiedSetup(isPluginEnabled: BillingRepository["isPluginEnabled"]) {
  const repo = Object.fromEntries(
    Object.entries(stubRepo({ isPluginEnabled })).map(([name, fn]) => [name, vi.fn(fn)])
  ) as unknown as BillingRepository & Record<string, ReturnType<typeof vi.fn>>;
  const run = vi.fn(stubGeneration().run);
  const capability = new BillingCapability(repo, scope, { run }, () => true);
  const calledAfterRecheck = () => [
    ...Object.entries(repo)
      .filter(([name, spy]) => !READ_BEFORE_RECHECK.has(name) && spy.mock.calls.length > 0)
      .map(([name]) => name),
    ...(run.mock.calls.length > 0 ? ["generation.run"] : []),
  ];
  return { capability, repo, calledAfterRecheck };
}

describe("BillingCapability plugin re-check before each write", () => {
  it.each(WRITES)("$method answers 409 and writes nothing when the plugin is disabled", async ({ run }) => {
    const { capability, repo, calledAfterRecheck } = spiedSetup(async () => false);
    const result = await run(capability);
    expect(result).toMatchObject({ ok: false, status: 409, code: "billing_disabled" });
    expect(repo.isPluginEnabled).toHaveBeenCalledWith(ORG_ID);
    expect(calledAfterRecheck()).toEqual([]);
  });

  it.each(WRITES)("$method answers 503 and writes nothing when plugin state cannot be read", async ({ run }) => {
    const { capability, repo, calledAfterRecheck } = spiedSetup(async () => {
      throw new Error("canceling statement due to statement timeout");
    });
    const result = await run(capability);
    expect(result).toMatchObject({ ok: false, status: 503, code: "billing_gate_unavailable" });
    expect(repo.isPluginEnabled).toHaveBeenCalledWith(ORG_ID);
    expect(calledAfterRecheck()).toEqual([]);
  });

  it.each(WRITES)("$method goes on to the repository or bill engine when the plugin is enabled", async ({ run }) => {
    // Keeps the two refusals above from passing vacuously.
    const { capability, calledAfterRecheck } = spiedSetup(async () => true);
    await run(capability);
    expect(calledAfterRecheck()).not.toEqual([]);
  });

  it("previews bills without reading plugin state", async () => {
    const { capability, repo } = spiedSetup(async () => {
      throw new Error("canceling statement due to statement timeout");
    });
    const result = await capability.previewBills({ billingPeriodId: PERIOD_ID });
    expect(result).toMatchObject({ ok: true });
    expect(repo.isPluginEnabled).not.toHaveBeenCalled();
  });
});
