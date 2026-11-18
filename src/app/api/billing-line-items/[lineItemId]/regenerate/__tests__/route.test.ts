/**
 * POST /api/billing-line-items/[lineItemId]/regenerate: one bill regenerated
 * through the billing capability, for the bill's own tenant only.
 *
 * Mocked at the supabase and composeBilling boundaries, as the generate
 * route's tests are: the capability is tested in billing-capability.test.ts
 * and the engine end to end by the live-database suites.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LINE_ITEM = "660e8400-e29b-41d4-a716-446655443001";
const PERIOD = "660e8400-e29b-41d4-a716-446655441000";
const MICROGRID = "660e8400-e29b-41d4-a716-446655440000";
const ORG = "550e8400-e29b-41d4-a716-446655440000";
const TENANT = "660e8400-e29b-41d4-a716-446655442001";

type Bill = { id: string; tenant_id: string; billing_period_id: string; reading_source: string | null; payment_status: string };

let user: { id: string } | null;
let bill: Bill | null;
let billError: { message: string } | null;
let period: { id: string; microgrid_id: string } | null;
let microgrid: { id: string; communities: { org_id: string } } | null;
let composeResult: { ok: false; status: number; code: string; message: string } | null;
let generateResult: unknown;
const generateBills = vi.fn();
const dispose = vi.fn();
const reads: [string, string][] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: () => ({
          maybeSingle: async () => {
            reads.push([table, columns]);
            if (table === "billing_line_items") return { data: bill, error: billError };
            return { data: table === "billing_periods" ? period : microgrid, error: null };
          },
        }),
      }),
    }),
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  }),
}));

vi.mock("@/lib/billing/compose", () => ({
  composeBilling: vi.fn(async (o: { organizationId: string }) => {
    if (composeResult) return composeResult;
    expect(o.organizationId).toBe(ORG);
    return { ok: true, data: { billing: { generateBills }, dispose } };
  }),
}));

import { POST } from "../route";

const post = (body: unknown, id = LINE_ITEM) =>
  POST(
    new NextRequest(`http://localhost/api/billing-line-items/${id}/regenerate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ lineItemId: id }) },
  );

const written = (total = 5200, previous: number | null = 5000) => ({
  ok: true,
  data: {
    results: [
      { kind: "written", tenantId: TENANT, tenantName: "Unit 1", lineItem: { id: LINE_ITEM, total_amount: total }, previousTotalAmount: previous },
    ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  user = { id: "11111111-1111-4111-8111-111111111111" };
  bill = { id: LINE_ITEM, tenant_id: TENANT, billing_period_id: PERIOD, reading_source: "edge", payment_status: "unpaid" };
  billError = null;
  period = { id: PERIOD, microgrid_id: MICROGRID };
  microgrid = { id: MICROGRID, communities: { org_id: ORG } };
  composeResult = null;
  generateResult = written();
  generateBills.mockImplementation(async () => generateResult);
  dispose.mockResolvedValue(undefined);
});

describe("POST /api/billing-line-items/[lineItemId]/regenerate", () => {
  it("400 for an id that is not a UUID, before anything is read", async () => {
    const res = await post({ readings: "edge" }, "not-a-uuid");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid line item id — expected UUID.", reason: "bad_request" });
    expect(reads).toEqual([]);
  });

  it("400 for a body RegenerateBillBody refuses, before the session check", async () => {
    user = null;
    const res = await post({ readings: "edge", tenantIds: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown field: tenantIds", code: "invalid_body" });
  });

  it.each([
    [{ readings: "edge", start_kwh: 1 }, "Readings are taken from the meter in edge mode", "start_kwh"],
    [{ readings: "edge", end_kwh: 1 }, "Readings are taken from the meter in edge mode", "end_kwh"],
    [{ readings: "edge", reason: "x" }, "Readings are taken from the meter in edge mode", "reason"],
    [{ readings: "manual", end_kwh: 20 }, "start_kwh is required for manual readings", "start_kwh"],
    [{ readings: "manual", start_kwh: 10 }, "end_kwh is required for manual readings", "end_kwh"],
    [{ readings: "manual", start_kwh: 10, end_kwh: 9 }, "end_kwh must be greater than or equal to start_kwh", "end_kwh"],
  ])("400 for %j, naming the field", async (body, error, field) => {
    user = null;
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error, field, code: "invalid_body" });
    expect(generateBills).not.toHaveBeenCalled();
  });

  it("401 with no session", async () => {
    user = null;
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
  });

  it.each([
    ["the bill", () => (bill = null)],
    ["its period", () => (period = null)],
    ["its microgrid", () => (microgrid = null)],
  ])("404 when row-level security hides %s", async (_label, hide) => {
    hide();
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Billing line item not found.", reason: "not_found" });
    expect(generateBills).not.toHaveBeenCalled();
  });

  it("500 when the bill cannot be read, without the database's message", async () => {
    billError = { message: "permission denied for table billing_line_items" };
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("permission denied");
  });

  it("reads the bill through the person's client, with the columns it needs", async () => {
    await post({ readings: "edge" });
    expect(reads[0]).toEqual(["billing_line_items", "id, tenant_id, billing_period_id, reading_source, payment_status"]);
  });

  it("answers the capability's refusal when composing fails (the plugin gate)", async () => {
    composeResult = { ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled for this organization." };
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "billing_disabled", message: "Billing is disabled for this organization.", error: "Billing is disabled for this organization." });
    expect(generateBills).not.toHaveBeenCalled();
  });

  it("409 for a refunded bill, and still disposes the scope", async () => {
    bill!.payment_status = "refunded";
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "A refunded bill cannot be regenerated.", reason: "refunded" });
    expect(generateBills).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("regenerates an edge bill from the meter for its one tenant", async () => {
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lineItemId: LINE_ITEM, totalAmount: 5200, previousTotalAmount: 5000 });
    expect(generateBills).toHaveBeenCalledWith({ billingPeriodId: PERIOD, tenantIds: [TENANT], revertToEdgeTenantIds: undefined });
  });

  it("switches a manual bill back to edge data", async () => {
    bill!.reading_source = "manual";
    await post({ readings: "edge" });
    expect(generateBills).toHaveBeenCalledWith({ billingPeriodId: PERIOD, tenantIds: [TENANT], revertToEdgeTenantIds: [TENANT] });
  });

  it("sends manual readings, with the trimmed reason when one is given", async () => {
    await post({ readings: "manual", start_kwh: 10, end_kwh: 25.5, reason: "  dial photo " });
    expect(generateBills).toHaveBeenLastCalledWith({
      billingPeriodId: PERIOD,
      tenantIds: [TENANT],
      manualReadings: [{ tenantId: TENANT, startKwh: 10, endKwh: 25.5, reason: "dial photo" }],
    });
    await post({ readings: "manual", start_kwh: 10, end_kwh: 10 });
    expect(generateBills).toHaveBeenLastCalledWith({
      billingPeriodId: PERIOD,
      tenantIds: [TENANT],
      manualReadings: [{ tenantId: TENANT, startKwh: 10, endKwh: 10 }],
    });
  });

  it("409 with generation's code when it refused this tenant", async () => {
    generateResult = {
      ok: true,
      data: { results: [{ kind: "error", tenantId: TENANT, tenantName: "Unit 1", error: "No meter reading for this period.", code: "no_meter_reading" }] },
    };
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "No meter reading for this period.", reason: "no_meter_reading" });
  });

  it.each([
    ["kept", [{ kind: "kept", tenantId: TENANT, tenantName: "Unit 1", readingSource: "manual" }]],
    ["no result for the tenant", []],
  ])("500 when the bill was not written (%s)", async (_label, results) => {
    generateResult = { ok: true, data: { results } };
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "The bill was not regenerated.", reason: "unknown_error" });
  });

  it("answers the capability's refusal from generation", async () => {
    generateResult = { ok: false, status: 400, code: "billing_invalid_body", message: "Body must be an object" };
    const res = await post({ readings: "edge" });
    expect(res.status).toBe(400);
  });

  it("disposes the scope whatever generation does", async () => {
    await post({ readings: "edge" });
    generateBills.mockRejectedValueOnce(new Error("engine failed"));
    await expect(post({ readings: "edge" })).rejects.toThrow("engine failed");
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
