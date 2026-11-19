/**
 * POST /api/billing-periods/[periodId]/generate-from-meters: a draft
 * period's bills generated from meter data through the billing capability.
 *
 * Mocked at the supabase and composeBilling boundaries, as the regenerate
 * route's tests are: the engine is tested in generate-guard-existing.test.ts
 * and end to end by generate-from-meters.db.test.ts.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PERIOD = "660e8400-e29b-41d4-a716-446655441000";
const MICROGRID = "660e8400-e29b-41d4-a716-446655440000";
const ORG = "550e8400-e29b-41d4-a716-446655440000";
/** Text a database or metering source might send, which no answer may carry. */
const LEAK = "relation \"secret_table\" permission denied";

let user: { id: string } | null;
let period: { id: string; microgrid_id: string; status: string } | null;
let periodError: { message: string } | null;
let microgrid: { id: string; communities: { org_id: string } | { org_id: string }[] } | null;
let microgridError: { message: string } | null;
let composeResult: { ok: false; status: number; code: string; message: string; reason?: string } | null;
let generateResult: unknown;
const generateFromMeters = vi.fn(async () => generateResult);
const dispose = vi.fn();
const reads: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            reads.push(table);
            if (table === "billing_periods") return { data: periodError ? null : period, error: periodError };
            return { data: microgridError ? null : microgrid, error: microgridError };
          },
        }),
      }),
    }),
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  }),
}));

vi.mock("@/lib/billing/compose", () => ({
  composeBilling: vi.fn(async (o: { organizationId: string; readOnly?: boolean }) => {
    if (composeResult) return composeResult;
    expect(o.organizationId).toBe(ORG);
    // A write: the composer checks the plugin gate.
    expect(o.readOnly).toBeUndefined();
    return { ok: true, data: { billing: { generateFromMeters }, dispose } };
  }),
}));

import { composeBilling } from "@/lib/billing/compose";
import { GENERATE_FROM_METERS_COPY } from "@/lib/billing/schemas";
import { POST } from "../route";

const post = (body: unknown, id = PERIOD, headers: Record<string, string> = {}) =>
  POST(
    new NextRequest(`http://localhost/api/billing-periods/${id}/generate-from-meters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ periodId: id }) },
  );

let n = 0;
const tenant = () => ({ tenantId: `t-${++n}`, tenantName: `Unit ${n}` });
const written = () => ({ kind: "written", ...tenant(), lineItem: { id: "b", total_amount: 1 }, previousTotalAmount: null });
const unchanged = () => ({ kind: "unchanged", ...tenant(), lineItemId: "b", totalAmount: 1 });
const kept = () => ({ kind: "kept", ...tenant(), readingSource: "manual" });
const error = (code: string, text = LEAK) => ({ kind: "error", ...tenant(), code, error: text });
const ok = (...results: unknown[]) => ({ ok: true, data: { results } });

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  user = { id: "11111111-1111-4111-8111-111111111111" };
  period = { id: PERIOD, microgrid_id: MICROGRID, status: "draft" };
  periodError = null;
  microgrid = { id: MICROGRID, communities: { org_id: ORG } };
  microgridError = null;
  composeResult = null;
  generateResult = ok(written());
});

describe("POST /api/billing-periods/[periodId]/generate-from-meters", () => {
  it("refuses a malformed id before reading anything", async () => {
    const res = await post({}, "not-a-uuid");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid billing period id — expected UUID.", reason: "bad_request" });
    expect(reads).toEqual([]);
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["text that is not JSON", "not json"],
    ["a key", { billingPeriodId: PERIOD }],
    ["a confirmation", { confirmation: { acknowledged: [] } }],
    ["an array", []],
    ["null", null],
  ])("refuses %s, before the session check", async (_label, body) => {
    user = null;
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(reads).toEqual([]);
    expect(generateFromMeters).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    user = null;
    const res = await post({});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(reads).toEqual([]);
  });

  it("answers 404 for a period or microgrid the person cannot read (another organization's, or a tenant-only account's)", async () => {
    period = null;
    let res = await post({});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Billing period not found.", reason: "not_found" });
    period = { id: PERIOD, microgrid_id: MICROGRID, status: "draft" };
    microgrid = null;
    res = await post({});
    expect(res.status).toBe(404);
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it("answers a failed read with fixed copy, never the database's message", async () => {
    periodError = { message: LEAK };
    let res = await post({});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: GENERATE_FROM_METERS_COPY.failed, reason: "unknown_error" });
    periodError = null;
    microgridError = { message: LEAK };
    res = await post({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret_table");
  });

  it.each([
    [{ ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled for this organization." }, 409, "Billing is disabled for this organization."],
    [{ ok: false, status: 503, code: "billing_gate_unavailable", message: "Could not verify whether Billing is enabled. Retry the request." }, 503, "Could not verify whether Billing is enabled. Retry the request."],
    [{ ok: false, status: 403, code: "billing_forbidden", message: "Not authorized to act on this organization.", reason: "forbidden" }, 403, "Not authorized to act on this organization."],
    [{ ok: false, status: 500, code: "billing_composition_failed", message: `Could not compose billing: ${LEAK}` }, 500, GENERATE_FROM_METERS_COPY.failed],
  ] as const)("answers the composer's refusal %#, with fixed copy", async (refusal, status, message) => {
    composeResult = { ...refusal };
    const res = await post({});
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error).toBe(message);
    expect(JSON.stringify(body)).not.toContain("secret_table");
    expect(generateFromMeters).not.toHaveBeenCalled();
  });

  it("refuses a closed period before generating, and disposes", async () => {
    period = { id: PERIOD, microgrid_id: MICROGRID, status: "closed" };
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: GENERATE_FROM_METERS_COPY.closed, reason: "period_closed" });
    expect(generateFromMeters).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 409, code: "billing_period_closed", message: "Bills cannot be generated in a closed period." }, 409, { error: GENERATE_FROM_METERS_COPY.closed, reason: "period_closed" }],
    [{ status: 409, code: "RATE_SCHEDULE_UNPINNED", message: `No rate schedule exists for this microgrid ${LEAK}` }, 409, { error: GENERATE_FROM_METERS_COPY.noTariff, reason: "no_tariff" }],
    [{ status: 503, code: "METERING_UNAVAILABLE", message: `OpenEMS said: ${LEAK}` }, 503, { error: GENERATE_FROM_METERS_COPY.meters, reason: "metering_unavailable" }],
    [{ status: 409, code: "METERING_CONFIGURATION", message: `mixed edges ${LEAK}` }, 503, { error: GENERATE_FROM_METERS_COPY.meters, reason: "metering_unavailable" }],
    [{ status: 404, code: "billing_generation_failed", message: "Billing period not found" }, 404, { error: "Billing period not found.", reason: "not_found" }],
    [{ status: 500, code: "billing_generation_failed", message: `Error fetching tenants: ${LEAK}` }, 500, { error: GENERATE_FROM_METERS_COPY.failed, reason: "unknown_error" }],
    [{ status: 500, code: "billing_bills_unreadable", message: GENERATE_FROM_METERS_COPY.failed }, 500, { error: GENERATE_FROM_METERS_COPY.failed, reason: "unknown_error" }],
    [{ status: 403, code: "billing_scope_mismatch", message: "Not authorized to act on this organization." }, 403, { error: "Not authorized to act on this organization.", code: "billing_scope_mismatch" }],
  ])("answers the capability's refusal %# with fixed copy", async (refusal, status, body) => {
    generateResult = { ok: false, ...refusal };
    const res = await post({});
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("answers 200 with counts, each tenant's outcome and code, and a message in the request's locale", async () => {
    generateResult = ok(
      ...Array.from({ length: 1200 }, written),
      unchanged(),
      kept(),
      error("paid"),
      error("unmetered_no_manual"),
      error("no_meter_reading"),
      error("line_item_write_failed"),
    );
    const res = await post({}, PERIOD, { "accept-language": "de-DE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      generated: 1200,
      unchanged: 1,
      kept: 1,
      left: 1,
      changed: 0,
      notBilled: { noMeter: 1, meterAssignment: 0, noReading: 1, failed: 1 },
    });
    expect(body.tenants).toHaveLength(1206);
    expect(body.tenants.at(-1)).toEqual({ tenantId: expect.any(String), tenantName: expect.any(String), outcome: "not_billed", code: "line_item_write_failed" });
    expect(body.message).toBe(
      "Generated 1.200 bills from meter data; 1 already up to date. Not billed: 1 with no meter, 1 with no meter data, 1 not saved. Left as they were: 1 entered by hand, 1 paid, invoiced or refunded.",
    );
    expect(JSON.stringify(body)).not.toContain("secret_table");
    expect(generateFromMeters).toHaveBeenCalledWith(PERIOD);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("answers 200 when every bill is already up to date", async () => {
    generateResult = ok(unchanged(), unchanged());
    const res = await post({});
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("Nothing changed: every bill already has the latest meter figures.");
  });

  it("answers 409 nothing_generated when no tenant was billed or up to date and some were not billed, with the summary", async () => {
    generateResult = ok(kept(), error("no_meter_reading"), error("unmetered_no_manual"));
    const res = await post({});
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      reason: "nothing_generated",
      error: "No bill was generated. Not billed: 1 with no meter, 1 with no meter data. Left as they were: 1 entered by hand.",
      generated: 0,
      notBilled: { noMeter: 1, noReading: 1 },
    });
    expect(body.message).toBe(body.error);
  });

  it("answers 409 nothing_generated when the only bills left were not refreshed, and says they were left", async () => {
    generateResult = ok({ ...error("unmetered_no_manual"), hadBill: true });
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      reason: "nothing_generated",
      error: "No bill was generated. Left as they were: 1 not refreshed.",
      notRefreshed: 1,
      notBilled: { noMeter: 0 },
    });
  });

  it("answers 409 nothing_to_read for a microgrid with no tenants", async () => {
    generateResult = ok();
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: GENERATE_FROM_METERS_COPY.nothingToRead, reason: "nothing_to_read" });
  });

  it("disposes the composition when generation throws", async () => {
    generateFromMeters.mockRejectedValueOnce(new Error("boom"));
    await expect(post({})).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
