/**
 * POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings:
 * one tenant with no bill in a draft period billed from readings typed by
 * hand, through the billing capability.
 *
 * Mocked at the supabase and composeBilling boundaries, as the
 * generate-from-meters route's tests are: the engine is tested in
 * generate-new-bill-only.test.ts and end to end by
 * bill-from-readings.db.test.ts.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PERIOD = "660e8400-e29b-41d4-a716-446655441000";
const TENANT = "660e8400-e29b-41d4-a716-446655442000";
const MICROGRID = "660e8400-e29b-41d4-a716-446655440000";
const OTHER_MICROGRID = "660e8400-e29b-41d4-a716-446655449999";
const ORG = "550e8400-e29b-41d4-a716-446655440000";
/** Text a database might send, which no answer may carry. */
const LEAK = "relation \"secret_table\" permission denied";

type Read = { data: unknown; error: { message: string } | null };
let user: { id: string } | null;
let rows: Record<string, Read>;
let composeResult: { ok: false; status: number; code: string; message: string; reason?: string } | null;
let billResult: unknown;
const billFromReadings = vi.fn<(periodId: string, tenantId: string, readings: unknown) => Promise<unknown>>(async () => billResult);
const dispose = vi.fn();
const reads: string[] = [];
const filters: Record<string, [string, unknown][]> = {};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          (filters[table] ??= []).push([column, value]);
          return chain;
        },
        maybeSingle: async () => {
          reads.push(table);
          const r = rows[table];
          return r.error ? { data: null, error: r.error } : r;
        },
      };
      return chain;
    },
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  }),
}));

vi.mock("@/lib/billing/compose", () => ({
  composeBilling: vi.fn(async (o: { organizationId: string; readOnly?: boolean }) => {
    if (composeResult) return composeResult;
    expect(o.organizationId).toBe(ORG);
    // A write: the composer checks the plugin gate.
    expect(o.readOnly).toBeUndefined();
    return { ok: true, data: { billing: { billFromReadings }, dispose } };
  }),
}));

import { composeBilling } from "@/lib/billing/compose";
import { BILL_FROM_READINGS_COPY } from "@/lib/billing/schemas";
import { POST } from "../route";

const post = (body: unknown, ids: { period?: string; tenant?: string } = {}, headers: Record<string, string> = {}) => {
  const periodId = ids.period ?? PERIOD;
  const tenantId = ids.tenant ?? TENANT;
  return POST(
    new NextRequest(`http://localhost/api/billing-periods/${periodId}/tenants/${tenantId}/bill-from-readings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ periodId, tenantId }) },
  );
};

const READINGS = { start_kwh: 100.1234, end_kwh: 150.5 };
const written = (o: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    results: [
      {
        kind: "written",
        tenantId: TENANT,
        tenantName: "Akello Grace",
        // NUMERIC columns as PostgREST may send them.
        lineItem: { id: "bill-1", usage_kwh: "50.377", total_amount: "36323" },
        previousTotalAmount: null,
        previousPaymentStatus: null,
        previousReadingSource: null,
        ...o,
      },
    ],
  },
});
const tenantError = (code: string, text = LEAK) => ({ ok: true, data: { results: [{ kind: "error", tenantId: TENANT, tenantName: "Akello Grace", code, error: text }] } });

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  for (const k of Object.keys(filters)) delete filters[k];
  user = { id: "11111111-1111-4111-8111-111111111111" };
  rows = {
    billing_periods: { data: { id: PERIOD, microgrid_id: MICROGRID, status: "draft" }, error: null },
    microgrids: { data: { id: MICROGRID, currency: "UGX", communities: { org_id: ORG } }, error: null },
    tenants: { data: { id: TENANT, display_name: "Akello Grace", microgrid_id: MICROGRID }, error: null },
    billing_line_items: { data: null, error: null },
  };
  composeResult = null;
  billResult = written();
});

describe("POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings", () => {
  it.each([
    [{ period: "not-a-uuid" }, "Invalid billing period id — expected UUID."],
    [{ tenant: "not-a-uuid" }, "Invalid tenant id — expected UUID."],
  ])("refuses a malformed id %j before reading anything", async (ids, error) => {
    const res = await post(READINGS, ids);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error, reason: "bad_request" });
    expect(reads).toEqual([]);
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined, undefined],
    ["text that is not JSON", "not json", undefined],
    ["an array", [], undefined],
    ["a negative start", { start_kwh: -1, end_kwh: 2 }, "start_kwh"],
    ["a string reading", { start_kwh: "1", end_kwh: 2 }, "start_kwh"],
    ["no end", { start_kwh: 1 }, "end_kwh"],
    ["an unknown key", { ...READINGS, tenantId: TENANT }, undefined],
    ["a confirmation", { ...READINGS, confirmation: { acknowledged: [] } }, undefined],
    ["a reason over 500 characters", { ...READINGS, reason: "x".repeat(501) }, "reason"],
    ["an end below the start", { start_kwh: 10, end_kwh: 9.999 }, "end_kwh"],
  ])("refuses %s, before the session check", async (_label, body, field) => {
    user = null;
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code ?? json.error).toBeTruthy();
    if (field) expect(json.field).toBe(field);
    expect(reads).toEqual([]);
    expect(billFromReadings).not.toHaveBeenCalled();
  });

  it("answers an end below the start with the regenerate route's copy", async () => {
    const res = await post({ start_kwh: 10, end_kwh: 9 });
    expect(await res.json()).toEqual({ error: "end_kwh must be greater than or equal to start_kwh", field: "end_kwh", code: "invalid_body" });
  });

  it("answers 401 without a session", async () => {
    user = null;
    const res = await post(READINGS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(reads).toEqual([]);
  });

  it("answers 404 for a period or microgrid the person cannot read (another organization's, or a tenant-only account's)", async () => {
    rows.billing_periods = { data: null, error: null };
    let res = await post(READINGS);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Billing period not found.", reason: "not_found" });
    rows.billing_periods = { data: { id: PERIOD, microgrid_id: MICROGRID, status: "draft" }, error: null };
    rows.microgrids = { data: null, error: null };
    res = await post(READINGS);
    expect(res.status).toBe(404);
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it.each(["billing_periods", "microgrids", "tenants", "billing_line_items"])(
    "answers a failed read of %s with fixed copy, never the database's message",
    async (table) => {
      rows[table] = { data: null, error: { message: LEAK } };
      const res = await post(READINGS);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: BILL_FROM_READINGS_COPY.failed, reason: "unknown_error" });
      expect(billFromReadings).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled for this organization." }, 409, "Billing is disabled for this organization."],
    [{ ok: false, status: 503, code: "billing_gate_unavailable", message: "Could not verify whether Billing is enabled. Retry the request." }, 503, "Could not verify whether Billing is enabled. Retry the request."],
    [{ ok: false, status: 403, code: "billing_forbidden", message: "Not authorized to act on this organization.", reason: "forbidden" }, 403, "Not authorized to act on this organization."],
    [{ ok: false, status: 500, code: "billing_composition_failed", message: `Could not compose billing: ${LEAK}` }, 500, BILL_FROM_READINGS_COPY.failed],
  ] as const)("answers the composer's refusal %#, with fixed copy, before reading the tenant", async (refusal, status, message) => {
    composeResult = { ...refusal };
    const res = await post(READINGS);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error).toBe(message);
    expect(JSON.stringify(body)).not.toContain("secret_table");
    expect(reads).not.toContain("tenants");
    expect(billFromReadings).not.toHaveBeenCalled();
  });

  it("refuses a closed period before reading the tenant, and disposes", async () => {
    rows.billing_periods = { data: { id: PERIOD, microgrid_id: MICROGRID, status: "closed" }, error: null };
    const res = await post(READINGS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BILL_FROM_READINGS_COPY.closed, reason: "period_closed" });
    expect(reads).not.toContain("tenants");
    expect(billFromReadings).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a tenant the person cannot read (another organization's)", async () => {
    rows.tenants = { data: null, error: null };
    const res = await post(READINGS);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: BILL_FROM_READINGS_COPY.tenantNotFound, reason: "tenant_not_found" });
    expect(billFromReadings).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses a tenant of another microgrid of the organization", async () => {
    rows.tenants = { data: { id: TENANT, display_name: "Akello Grace", microgrid_id: OTHER_MICROGRID }, error: null };
    const res = await post(READINGS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BILL_FROM_READINGS_COPY.otherMicrogrid, reason: "tenant_not_on_microgrid" });
    expect(reads).not.toContain("billing_line_items");
    expect(billFromReadings).not.toHaveBeenCalled();
  });

  it("refuses a tenant who already has a bill for the period, looking for it by period and tenant", async () => {
    rows.billing_line_items = { data: { id: "bill-0" }, error: null };
    const res = await post(READINGS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BILL_FROM_READINGS_COPY.hasBill, reason: "has_bill" });
    expect(filters.billing_line_items).toEqual([
      ["billing_period_id", PERIOD],
      ["tenant_id", TENANT],
    ]);
    expect(billFromReadings).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 409, code: "billing_period_closed", message: "Bills cannot be added to a closed period." }, 409, { error: BILL_FROM_READINGS_COPY.closed, reason: "period_closed" }],
    [{ status: 409, code: "RATE_SCHEDULE_UNPINNED", message: `No rate schedule ${LEAK}` }, 409, { error: BILL_FROM_READINGS_COPY.noTariff, reason: "no_tariff" }],
    [{ status: 400, code: "billing_invalid_body", message: "manualReadings[0].endKwh must be >= startKwh" }, 400, { error: expect.any(String), code: "invalid_body" }],
    [{ status: 404, code: "billing_generation_failed", message: "Billing period not found" }, 404, { error: "Billing period not found.", reason: "not_found" }],
    [{ status: 500, code: "billing_generation_failed", message: `Error fetching tenants: ${LEAK}` }, 500, { error: BILL_FROM_READINGS_COPY.failed, reason: "unknown_error" }],
    [{ status: 500, code: "billing_bills_unreadable", message: BILL_FROM_READINGS_COPY.failed }, 500, { error: BILL_FROM_READINGS_COPY.failed, reason: "unknown_error" }],
    [{ status: 400, code: "new_bill_only_mismatch", message: "A first bill from readings names one tenant and that tenant's readings only." }, 500, { error: BILL_FROM_READINGS_COPY.failed, reason: "unknown_error" }],
    [{ status: 403, code: "billing_scope_mismatch", message: "Not authorized to act on this organization." }, 403, { error: "Not authorized to act on this organization.", code: "billing_scope_mismatch" }],
    [{ status: 409, code: "billing_disabled", message: "Billing is disabled for this organization." }, 409, { error: "Billing is disabled for this organization.", code: "billing_disabled" }],
    [{ status: 503, code: "billing_gate_unavailable", message: "Could not verify whether Billing is enabled. Retry the request." }, 503, { error: "Could not verify whether Billing is enabled. Retry the request.", code: "billing_gate_unavailable" }],
  ])("answers the capability's refusal %# with fixed copy", async (refusal, status, body) => {
    billResult = { ok: false, ...refusal };
    const res = await post(READINGS);
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json).toEqual(body);
    expect(JSON.stringify(json)).not.toContain("secret_table");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["bill_exists", 409, { error: BILL_FROM_READINGS_COPY.hasBill, reason: "has_bill" }],
    ["unknown_tenant", 409, { error: BILL_FROM_READINGS_COPY.otherMicrogrid, reason: "tenant_not_on_microgrid" }],
    ["tariff_changed", 409, { error: BILL_FROM_READINGS_COPY.tariffChanged, reason: "tariff_changed" }],
    ["invalid_manual_reading", 400, { error: expect.any(String), code: "invalid_body" }],
    ["line_item_write_failed", 500, { error: BILL_FROM_READINGS_COPY.failed, reason: "unknown_error" }],
    ["unmetered_no_manual", 500, { error: BILL_FROM_READINGS_COPY.failed, reason: "unknown_error" }],
  ])("answers the engine's %s for the tenant with fixed copy, never its text", async (code, status, body) => {
    billResult = tenantError(code, `Failed to write line item: ${LEAK}`);
    const res = await post(READINGS);
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json).toEqual(body);
    expect(JSON.stringify(json)).not.toContain("secret_table");
    expect(JSON.stringify(json)).not.toContain("Failed to write");
  });

  it("answers 500 when the engine reports nothing for the tenant", async () => {
    billResult = { ok: true, data: { results: [] } };
    const res = await post(READINGS);
    expect(res.status).toBe(500);
  });

  it("bills the tenant and answers 201 with a message in the request's locale and the microgrid's currency", async () => {
    const res = await post({ ...READINGS, reason: "  Read on site  " }, {}, { "accept-language": "de-DE" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      lineItemId: "bill-1",
      tenantId: TENANT,
      usageKwh: 50.377,
      totalAmount: 36323,
      message: expect.stringMatching(/^Billed Akello Grace from the readings entered: 50,377\s?kWh\. The bill's total is .*36\.323.*\.$/),
    });
    expect(body.message.length).toBeLessThanOrEqual(300);
    expect(billFromReadings).toHaveBeenCalledWith(PERIOD, TENANT, { startKwh: 100.1234, endKwh: 150.5, reason: "Read on site" });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("sends no reason when none was given, and keeps a long tenant name's message within 300 characters", async () => {
    rows.tenants = { data: { id: TENANT, display_name: "N".repeat(400), microgrid_id: MICROGRID }, error: null };
    const res = await post({ ...READINGS, reason: "   " });
    expect(res.status).toBe(201);
    expect((await res.json()).message.length).toBeLessThanOrEqual(300);
    expect(billFromReadings).toHaveBeenCalledWith(PERIOD, TENANT, { startKwh: 100.1234, endKwh: 150.5 });
  });

  it("disposes the composition when billing throws", async () => {
    billFromReadings.mockRejectedValueOnce(new Error("boom"));
    await expect(post(READINGS)).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
