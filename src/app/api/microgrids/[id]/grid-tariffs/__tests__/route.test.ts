/**
 * Grid tariff write routes.
 *
 *   POST   /api/microgrids/[id]/grid-tariffs
 *   DELETE /api/microgrids/[id]/grid-tariffs/[tariffId]
 *
 * All Supabase I/O and the plugin gate are mocked — no real DB hits. The
 * RLS policy itself is covered by src/lib/supabase/__tests__/grid_tariffs.test.ts.
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
  builder.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(nextResult(table)).then(resolve, reject);
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
const TARIFF_ID = "770e8400-e29b-41d4-a716-446655440002";

const BANDS = [
  { from_hour: 0, to_hour: 6, rate: 400 },
  { from_hour: 6, to_hour: 18, rate: 550 },
  { from_hour: 18, to_hour: 24, rate: 650 },
];

function postRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/microgrids/${MICROGRID_ID}/grid-tariffs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function post(body: unknown, id = MICROGRID_ID) {
  const { POST } = await import("../route");
  return POST(postRequest(body), { params: Promise.resolve({ id }) });
}

async function del(id = MICROGRID_ID, tariffId = TARIFF_ID) {
  const { DELETE } = await import("../[tariffId]/route");
  const req = new NextRequest(
    `http://localhost/api/microgrids/${id}/grid-tariffs/${tariffId}`,
    { method: "DELETE" }
  );
  return DELETE(req, { params: Promise.resolve({ id, tariffId }) });
}

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(results)) delete results[key];
  mockUser = { id: "user-1" };
  mockGateRoute.mockReset();
  mockGateRoute.mockResolvedValue(null);
});

// ─── POST ─────────────────────────────────────────────────────────────────────

describe("POST /api/microgrids/[id]/grid-tariffs", () => {
  it("inserts the validated bands and answers 201 with the row", async () => {
    const row = {
      id: TARIFF_ID,
      microgrid_id: MICROGRID_ID,
      effective_from: "2026-10-01",
      bands: BANDS,
      created_at: "2026-11-06T00:00:00Z",
    };
    results.microgrids = [{ data: { id: MICROGRID_ID }, error: null }];
    results.grid_tariffs = [{ data: row, error: null }];

    // Bands in any order are accepted and stored sorted.
    const res = await post({ effective_from: "2026-10-01", bands: [BANDS[2], BANDS[0], BANDS[1]] });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(row);
    const insert = calls.find((c) => c.table === "grid_tariffs" && c.op === "insert");
    expect(insert?.args[0]).toEqual({
      microgrid_id: MICROGRID_ID,
      effective_from: "2026-10-01",
      bands: BANDS,
    });
  });

  it("gates the billing plugin as a write on the microgrid", async () => {
    results.microgrids = [{ data: { id: MICROGRID_ID }, error: null }];
    results.grid_tariffs = [{ data: {}, error: null }];
    await post({ effective_from: "2026-10-01", bands: BANDS });
    expect(mockGateRoute).toHaveBeenCalledWith(expect.anything(), {
      plugin: "billing",
      target: { kind: "microgrid", id: MICROGRID_ID },
      method: "POST",
      access: "write",
    });
  });

  it("returns the gate's response when billing is disabled, writing nothing", async () => {
    mockGateRoute.mockResolvedValue(
      NextResponse.json({ error: "Billing is disabled", code: "billing_disabled" }, { status: 409 })
    );
    const res = await post({ effective_from: "2026-10-01", bands: BANDS });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("billing_disabled");
    expect(calls.some((c) => c.table === "grid_tariffs")).toBe(false);
  });

  it("answers 401 without a session, before the gate or any write", async () => {
    mockUser = null;
    const res = await post({ effective_from: "2026-10-01", bands: BANDS });
    expect(res.status).toBe(401);
    expect(mockGateRoute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("answers 400 for a microgrid id that is not a UUID", async () => {
    const res = await post({ effective_from: "2026-10-01", bands: BANDS }, "not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });

  it.each([
    ["missing", undefined],
    ["not a date", "October"],
    ["a day that does not exist", "2026-02-30"],
    ["a timestamp", "2026-10-01T00:00:00Z"],
  ])("answers 400 when effective_from is %s", async (_label, effective_from) => {
    const res = await post({ effective_from, bands: BANDS });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("effective_from");
    expect(mockGateRoute).not.toHaveBeenCalled();
  });

  it.each([
    ["a gap", [{ from_hour: 0, to_hour: 6, rate: 400 }, { from_hour: 7, to_hour: 24, rate: 550 }]],
    ["no full day", [{ from_hour: 0, to_hour: 18, rate: 400 }]],
    ["a negative rate", [{ from_hour: 0, to_hour: 24, rate: -1 }]],
    ["a string rate", [{ from_hour: 0, to_hour: 24, rate: "400" }]],
    ["empty", []],
    ["not an array", { from_hour: 0, to_hour: 24, rate: 400 }],
  ])("answers 400 when bands have %s", async (_label, bands) => {
    const res = await post({ effective_from: "2026-10-01", bands });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("bands");
    expect(calls.some((c) => c.table === "grid_tariffs")).toBe(false);
  });

  it("answers 404 when the microgrid is not visible to the caller", async () => {
    results.microgrids = [{ data: null, error: null }];
    const res = await post({ effective_from: "2026-10-01", bands: BANDS });
    expect(res.status).toBe(404);
    expect(calls.some((c) => c.table === "grid_tariffs")).toBe(false);
  });

  it("answers 409 when a version already starts that day", async () => {
    results.microgrids = [{ data: { id: MICROGRID_ID }, error: null }];
    results.grid_tariffs = [
      { data: null, error: { code: "23505", message: "duplicate key value" } },
    ];
    const res = await post({ effective_from: "2026-10-01", bands: BANDS });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.field).toBe("effective_from");
    expect(json.error).toMatch(/2026-10-01/);
  });

  it("answers 403 when RLS refuses the insert", async () => {
    results.microgrids = [{ data: { id: MICROGRID_ID }, error: null }];
    results.grid_tariffs = [
      { data: null, error: { code: "42501", message: "new row violates row-level security policy" } },
    ];
    const res = await post({ effective_from: "2026-10-01", bands: BANDS });
    expect(res.status).toBe(403);
  });

  it("answers 500 without echoing the database message on other errors", async () => {
    results.microgrids = [{ data: { id: MICROGRID_ID }, error: null }];
    results.grid_tariffs = [{ data: null, error: { code: "XX000", message: "internal detail" } }];
    const res = await post({ effective_from: "2026-10-01", bands: BANDS });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/internal detail/);
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

describe("DELETE /api/microgrids/[id]/grid-tariffs/[tariffId]", () => {
  it("deletes the row scoped to the microgrid and answers 204", async () => {
    results.grid_tariffs = [{ data: [{ id: TARIFF_ID }], error: null }];
    const res = await del();
    expect(res.status).toBe(204);
    const ops = calls.filter((c) => c.table === "grid_tariffs").map((c) => [c.op, ...c.args]);
    expect(ops).toContainEqual(["delete"]);
    expect(ops).toContainEqual(["eq", "id", TARIFF_ID]);
    expect(ops).toContainEqual(["eq", "microgrid_id", MICROGRID_ID]);
  });

  it("gates the billing plugin as a write on the microgrid", async () => {
    results.grid_tariffs = [{ data: [{ id: TARIFF_ID }], error: null }];
    await del();
    expect(mockGateRoute).toHaveBeenCalledWith(expect.anything(), {
      plugin: "billing",
      target: { kind: "microgrid", id: MICROGRID_ID },
      method: "DELETE",
      access: "write",
    });
  });

  it("returns the gate's response when billing is disabled, deleting nothing", async () => {
    mockGateRoute.mockResolvedValue(
      NextResponse.json({ error: "Billing is disabled", code: "billing_disabled" }, { status: 409 })
    );
    const res = await del();
    expect(res.status).toBe(409);
    expect(calls.some((c) => c.table === "grid_tariffs")).toBe(false);
  });

  it("answers 401 without a session", async () => {
    mockUser = null;
    const res = await del();
    expect(res.status).toBe(401);
    expect(mockGateRoute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["microgrid", "nope", TARIFF_ID],
    ["tariff", MICROGRID_ID, "nope"],
  ])("answers 400 for a %s id that is not a UUID", async (_label, id, tariffId) => {
    const res = await del(id, tariffId);
    expect(res.status).toBe(400);
  });

  it("answers 404 when no visible row matched", async () => {
    results.grid_tariffs = [{ data: [], error: null }];
    const res = await del();
    expect(res.status).toBe(404);
  });

  it("answers 500 on a database error", async () => {
    results.grid_tariffs = [{ data: null, error: { code: "XX000", message: "boom" } }];
    const res = await del();
    expect(res.status).toBe(500);
  });
});
