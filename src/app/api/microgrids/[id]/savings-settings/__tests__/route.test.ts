/**
 * PUT /api/microgrids/[id]/savings-settings
 *
 * All Supabase I/O and the plugin gate are mocked — no real DB hits. The
 * RLS policy and CHECKs are covered by
 * src/lib/supabase/__tests__/grid_tariffs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ─── Fake Supabase client ─────────────────────────────────────────────────────

type Result = { data: unknown; error: { code?: string; message: string } | null };
type Call = { table: string; op: string; args: unknown[] };

const calls: Call[] = [];
/** Results returned, in order, by each table's terminal call. */
const results: Record<string, Result[]> = {};
let mockUser: { id: string } | null = { id: "user-1" };

function nextResult(table: string): Result {
  const queue = results[table] ?? [];
  return queue.shift() ?? { data: null, error: null };
}

function from(table: string) {
  const builder: Record<string, unknown> = {};
  for (const op of ["select", "eq", "insert", "upsert", "delete"]) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ table, op, args });
      return builder;
    };
  }
  builder.maybeSingle = () => Promise.resolve(nextResult(table));
  builder.single = () => Promise.resolve(nextResult(table));
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from,
    auth: { getUser: async () => ({ data: { user: mockUser }, error: null }) },
  }),
}));

const mockGateRoute = vi.fn<(...args: unknown[]) => Promise<NextResponse | null>>();
vi.mock("@/lib/runtime/gate", () => ({
  gateRoute: (...args: unknown[]) => mockGateRoute(...args),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MICROGRID_ID = "660e8400-e29b-41d4-a716-446655440001";

const VALID = {
  solar_savings_from: "2026-09-01",
  arbitrage_from: null,
  round_trip_efficiency: 0.9,
};

async function put(body: unknown, id = MICROGRID_ID) {
  const { PUT } = await import("../route");
  const req = new NextRequest(`http://localhost/api/microgrids/${id}/savings-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return PUT(req, { params: Promise.resolve({ id }) });
}

function upsertCall(): Call | undefined {
  return calls.find((c) => c.table === "microgrid_savings_settings" && c.op === "upsert");
}

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(results)) delete results[key];
  mockUser = { id: "user-1" };
  mockGateRoute.mockReset();
  mockGateRoute.mockResolvedValue(null);
  results.microgrids = [{ data: { id: MICROGRID_ID }, error: null }];
});

describe("PUT /api/microgrids/[id]/savings-settings", () => {
  it("upserts on microgrid_id, sets updated_at, and answers 200 with the row", async () => {
    const row = { microgrid_id: MICROGRID_ID, ...VALID, updated_at: "2026-11-06T00:00:00Z" };
    results.microgrid_savings_settings = [{ data: row, error: null }];

    const before = Date.now();
    const res = await put(VALID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(row);
    const call = upsertCall();
    const [values, options] = call?.args as [Record<string, unknown>, unknown];
    expect(values).toMatchObject({ microgrid_id: MICROGRID_ID, ...VALID });
    expect(Date.parse(values.updated_at as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(options).toEqual({ onConflict: "microgrid_id" });
  });

  it("accepts both start dates null and an efficiency of exactly 1", async () => {
    results.microgrid_savings_settings = [{ data: {}, error: null }];
    const res = await put({ solar_savings_from: null, arbitrage_from: null, round_trip_efficiency: 1 });
    expect(res.status).toBe(200);
    expect(upsertCall()?.args[0]).toMatchObject({
      solar_savings_from: null,
      arbitrage_from: null,
      round_trip_efficiency: 1,
    });
  });

  it("rounds the efficiency to the column's three decimals", async () => {
    results.microgrid_savings_settings = [{ data: {}, error: null }];
    await put({ ...VALID, round_trip_efficiency: 0.8876 });
    expect(upsertCall()?.args[0]).toMatchObject({ round_trip_efficiency: 0.888 });
  });

  it("writes only the contract's fields, with the microgrid from the path", async () => {
    results.microgrid_savings_settings = [{ data: {}, error: null }];
    await put(VALID);
    const values = upsertCall()?.args[0] as Record<string, unknown>;
    expect(Object.keys(values).sort()).toEqual(
      ["arbitrage_from", "microgrid_id", "round_trip_efficiency", "solar_savings_from", "updated_at"]
    );
    expect(values.microgrid_id).toBe(MICROGRID_ID);
  });

  it("refuses fields outside the contract, before the gate or any write", async () => {
    results.microgrid_savings_settings = [{ data: {}, error: null }];
    const res = await put({ ...VALID, microgrid_id: "someone-else", extra: true });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("invalid_body");
    expect(json).not.toHaveProperty("field");
    expect(upsertCall()).toBeUndefined();
    expect(mockGateRoute).not.toHaveBeenCalled();
  });

  it("gates the billing plugin as a write on the microgrid", async () => {
    results.microgrid_savings_settings = [{ data: {}, error: null }];
    await put(VALID);
    expect(mockGateRoute).toHaveBeenCalledWith(expect.anything(), {
      plugin: "billing",
      target: { kind: "microgrid", id: MICROGRID_ID },
      method: "PUT",
      access: "write",
    });
  });

  it("returns the gate's response when billing is disabled, writing nothing", async () => {
    mockGateRoute.mockResolvedValue(
      NextResponse.json({ error: "Billing is disabled", code: "billing_disabled" }, { status: 409 })
    );
    const res = await put(VALID);
    expect(res.status).toBe(409);
    expect(upsertCall()).toBeUndefined();
  });

  it("answers 401 without a session, before the gate or any write", async () => {
    mockUser = null;
    const res = await put(VALID);
    expect(res.status).toBe(401);
    expect(mockGateRoute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("answers 401 without a session before reading a malformed body", async () => {
    mockUser = null;
    for (const body of ["{nope", { ...VALID, extra: true }]) {
      const res = await put(body);
      expect(res.status).toBe(401);
      expect(await res.json()).not.toHaveProperty("code");
    }
    expect(mockGateRoute).not.toHaveBeenCalled();
  });

  it("answers 400 for a microgrid id that is not a UUID", async () => {
    const res = await put(VALID, "nope");
    expect(res.status).toBe(400);
  });

  it("answers 400 for a body that is not JSON or not an object", async () => {
    for (const body of ["{nope", [VALID]]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_body");
    }
  });

  it.each([
    ["solar_savings_from", "missing", undefined],
    ["solar_savings_from", "not a date", "September"],
    ["arbitrage_from", "a day that does not exist", "2026-02-29"],
    ["arbitrage_from", "a number", 20260901],
    ["round_trip_efficiency", "missing", undefined],
    ["round_trip_efficiency", "zero", 0],
    ["round_trip_efficiency", "negative", -0.5],
    ["round_trip_efficiency", "above 1", 1.001],
    ["round_trip_efficiency", "rounded to zero", 0.0004],
    ["round_trip_efficiency", "a string", "0.9"],
    ["round_trip_efficiency", "null", null],
  ])("answers 400 when %s is %s", async (field, _label, value) => {
    const body: Record<string, unknown> = { ...VALID, [field]: value };
    if (value === undefined) delete body[field];
    const res = await put(body);
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe(field);
    expect(upsertCall()).toBeUndefined();
  });

  it("answers 404 when the microgrid is not visible to the caller", async () => {
    results.microgrids = [{ data: null, error: null }];
    const res = await put(VALID);
    expect(res.status).toBe(404);
    expect(upsertCall()).toBeUndefined();
  });

  it("answers 403 when RLS refuses the upsert", async () => {
    results.microgrid_savings_settings = [
      { data: null, error: { code: "42501", message: "new row violates row-level security policy" } },
    ];
    const res = await put(VALID);
    expect(res.status).toBe(403);
  });

  it("answers 400 when the database CHECK refuses the efficiency", async () => {
    results.microgrid_savings_settings = [
      { data: null, error: { code: "23514", message: "violates check constraint" } },
    ];
    const res = await put(VALID);
    expect(res.status).toBe(400);
  });

  it("answers 500 without echoing the database message on other errors", async () => {
    results.microgrid_savings_settings = [
      { data: null, error: { code: "XX000", message: "internal detail" } },
    ];
    const res = await put(VALID);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/internal detail/);
  });
});
