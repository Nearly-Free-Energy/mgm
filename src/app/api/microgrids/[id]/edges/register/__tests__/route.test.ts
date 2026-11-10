/**
 * POST /api/microgrids/[id]/edges/register — unit tests.
 *
 * Covers:
 *   - 400 bad UUID / empty body / malformed entries
 *   - 403 on RLS violation
 *   - 401 without a signed-in user, before the synthetic-id refusal
 *   - 400 for a reserved SYNTHETIC-EDGE- id unless MGM_METERING_FIXTURES is on
 *   - Happy path: computes inserted vs updated from the prefetched existing set
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const MG_ID = "550e8400-e29b-41d4-a716-446655440000";

const mockFrom = vi.fn();
const mockGetUser = vi.fn();

// The MGM runtime gate is covered by src/app/api/__tests__/runtime-gate-wiring.test.ts.
const { gateRoute } = vi.hoisted(() => ({ gateRoute: vi.fn(async () => null) }));
vi.mock("@/lib/runtime/gate", () => ({ gateRoute }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom, auth: { getUser: mockGetUser } }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/microgrids/${MG_ID}/edges/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

let handlers: Array<() => unknown> = [];
let index = 0;
function registerFrom(h: () => unknown) {
  handlers.push(h);
}

describe("POST /api/microgrids/[id]/edges/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = [];
    index = 0;
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockFrom.mockImplementation(() => {
      const h = handlers[index++];
      if (!h) throw new Error(`unexpected from() #${index}`);
      return h();
    });
  });

  it("returns 400 for bad UUID", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeReq({ edges: [{ openems_edge_id: "e", name: "n" }] }), {
      params: Promise.resolve({ id: "not-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty edges array", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeReq({ edges: [] }), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an entry missing openems_edge_id", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeReq({ edges: [{ name: "n" }] }), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 on RLS violation during upsert", async () => {
    // 1st from: prefetch returns empty.
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }));
    // 2nd from: upsert fails with 42501.
    registerFrom(() => ({
      upsert: () => ({
        select: () =>
          Promise.resolve({
            data: null,
            error: { code: "42501", message: "rls" },
          }),
      }),
    }));

    const { POST } = await import("../route");
    const res = await POST(
      makeReq({ edges: [{ openems_edge_id: "edge0", name: "Edge 0" }] }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it("happy path: computes inserted vs updated counts from prefetched Set", async () => {
    // 1st from: prefetch — edge0 already exists, edge1 does not.
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          in: () =>
            Promise.resolve({
              data: [{ id: "db-0", openems_edge_id: "edge0" }],
              error: null,
            }),
        }),
      }),
    }));
    // 2nd from: upsert returns both rows.
    registerFrom(() => ({
      upsert: () => ({
        select: () =>
          Promise.resolve({
            data: [
              {
                id: "db-0",
                microgrid_id: MG_ID,
                openems_edge_id: "edge0",
                name: "Edge 0 (renamed)",
                role: null,
              },
              {
                id: "db-1",
                microgrid_id: MG_ID,
                openems_edge_id: "edge1",
                name: "Edge 1",
                role: null,
              },
            ],
            error: null,
          }),
      }),
    }));

    const { POST } = await import("../route");
    const res = await POST(
      makeReq({
        edges: [
          { openems_edge_id: "edge0", name: "Edge 0 (renamed)" },
          { openems_edge_id: "edge1", name: "Edge 1" },
        ],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.inserted).toBe(1);
    expect(json.updated).toBe(1);
    expect(json.edges).toHaveLength(2);
  });

  describe("reserved synthetic edge ids", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const synthetic = {
      edges: [
        { openems_edge_id: "edge0", name: "Edge 0" },
        { openems_edge_id: " SYNTHETIC-EDGE-001 ", name: "Synthetic" },
      ],
    };

    it.each([["off", ""], ["on", "on"]])(
      "answers 401 without a signed-in user, whether the setting is %s, so the setting cannot be probed",
      async (_label, value) => {
        vi.stubEnv("MGM_METERING_FIXTURES", value);
        mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Auth session missing!" } });
        const { POST } = await import("../route");
        const res = await POST(makeReq(synthetic), { params: Promise.resolve({ id: MG_ID }) });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
        expect(gateRoute).not.toHaveBeenCalled();
        expect(mockFrom).not.toHaveBeenCalled();
      }
    );

    it.each([["unset", ""], ["off", "off"], ["invalid", "maybe"]])(
      "refuses them with 400 after authentication and before any other read or write while MGM_METERING_FIXTURES is %s",
      async (_label, value) => {
        vi.stubEnv("MGM_METERING_FIXTURES", value);
        const { POST } = await import("../route");
        const res = await POST(makeReq(synthetic), { params: Promise.resolve({ id: MG_ID }) });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.field).toBe("openems_edge_id");
        expect(json.error).toContain("SYNTHETIC-EDGE-");
        expect(mockGetUser).toHaveBeenCalledTimes(1);
        expect(gateRoute).not.toHaveBeenCalled();
        expect(mockFrom).not.toHaveBeenCalled();
      }
    );

    it("registers them while MGM_METERING_FIXTURES is on", async () => {
      vi.stubEnv("MGM_METERING_FIXTURES", "on");
      registerFrom(() => ({
        select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }),
      }));
      const upsert = vi.fn(() => ({
        select: () =>
          Promise.resolve({
            data: [{ id: "db-1", microgrid_id: MG_ID, openems_edge_id: "SYNTHETIC-EDGE-001", name: "Synthetic", role: null }],
            error: null,
          }),
      }));
      registerFrom(() => ({ upsert }));
      const { POST } = await import("../route");
      const res = await POST(
        makeReq({ edges: [{ openems_edge_id: "SYNTHETIC-EDGE-001", name: "Synthetic" }] }),
        { params: Promise.resolve({ id: MG_ID }) }
      );
      expect(res.status).toBe(200);
      expect(gateRoute).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledWith(
        [expect.objectContaining({ openems_edge_id: "SYNTHETIC-EDGE-001" })],
        { onConflict: "microgrid_id,openems_edge_id" }
      );
    });

    it("leaves ids that only look similar to the normal path while off", async () => {
      vi.stubEnv("MGM_METERING_FIXTURES", "");
      registerFrom(() => ({
        select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }),
      }));
      registerFrom(() => ({
        upsert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
      }));
      const { POST } = await import("../route");
      const res = await POST(
        makeReq({ edges: [{ openems_edge_id: "synthetic-edge-001", name: "Lower case" }] }),
        { params: Promise.resolve({ id: MG_ID }) }
      );
      expect(res.status).toBe(200);
    });
  });
});
