import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingCapability } from "../capability";
import type {
  BillingGeneration,
  BillingRepository,
  BillingScope,
} from "../repository";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "770e8400-e29b-41d4-a716-446655440000";
const ITEM_ID = "880e8400-e29b-41d4-a716-446655440000";

const scope: BillingScope = {
  organizationId: ORG_ID,
  userId: "user-1",
  roles: [],
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

  it("rejects an inverted period range", async () => {
    const { capability } = setup();
    const result = await capability.createPeriod({
      microgrid_id: MG_ID,
      start_date: "2026-09-30",
      end_date: "2026-09-01",
    });
    expect(result).toMatchObject({ ok: false, status: 422, code: "billing_invalid_range" });
  });

  it("requires explicit confirmation to close with unresolved households", async () => {
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
    const { capability } = setup(
      {
        getPeriodSummary: async () => ({
          period: {
            id: PERIOD_ID,
            microgrid_id: MG_ID,
            start_date: "2026-09-01",
            end_date: "2026-09-30",
            status: "draft",
            timezone: "Africa/Kampala",
          },
          lineItemCount: 1,
          totalAmount: 100,
          unresolved: [
            { householdId: "hh-1", householdName: "No Bill", reason: "No bill generated." },
          ],
        }),
        closeBillingPeriod: close,
      }
    );
    const unconfirmed = await capability.closePeriod(PERIOD_ID);
    expect(unconfirmed).toMatchObject({
      ok: false,
      status: 409,
      code: "billing_unresolved_households",
    });
    expect(close).not.toHaveBeenCalled();

    const confirmed = await capability.closePeriod(PERIOD_ID, { confirmed: true });
    expect(confirmed).toMatchObject({ ok: true });
    expect(close).toHaveBeenCalled();
  });

  it.each([undefined, { confirmed: true }])("blocks closure on summary failure even with confirmation %j", async (input) => {
    const close = vi.fn();
    const { capability } = setup({
      getPeriodSummary: async () => { throw new Error("query failed"); },
      closeBillingPeriod: close,
    });
    expect(await capability.closePeriod(PERIOD_ID, input)).toMatchObject({
      ok: false, status: 503, code: "billing_summary_unavailable",
    });
    expect(close).not.toHaveBeenCalled();
    expect(await capability.getPeriodSummary(PERIOD_ID)).toMatchObject({
      ok: false, status: 503, code: "billing_summary_unavailable",
    });
  });

  it("refuses to close an already-closed period", async () => {
    const { capability } = setup({
      getPeriodSummary: async () => ({
        period: {
          id: PERIOD_ID,
          microgrid_id: MG_ID,
          start_date: "2026-09-01",
          end_date: "2026-09-30",
          status: "closed",
          timezone: "Africa/Kampala",
        },
        lineItemCount: 1,
        totalAmount: 100,
        unresolved: [],
      }),
    });
    const result = await capability.closePeriod(PERIOD_ID, { confirmed: true });
    expect(result).toMatchObject({ ok: false, status: 409, code: "billing_period_closed" });
  });

  it("delegates preview without writing and maps fatal errors", async () => {
    const run = vi.fn(async () => ({
      kind: "fatal" as const,
      status: 404,
      body: { error: "Billing period not found" },
    }));
    const { capability } = setup({}, { run });
    const result = await capability.previewBills({ billingPeriodId: PERIOD_ID });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ mode: "preview" }));
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
