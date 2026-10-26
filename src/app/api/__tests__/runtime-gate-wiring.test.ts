/**
 * Every route that calls the MGM runtime gate (docs/cordis-runtime.md
 * § "The gate") must stop before doing any work when the gate blocks, and
 * must ask with the right plugin, target, and method. The gate's own policy
 * is tested in src/lib/runtime/__tests__/gate.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-test-key";
process.env.MGM_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";

const gateRoute = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({ gateRoute }));

const from = vi.fn(() => {
  throw new Error("route queried the database before the gate");
});
const supabase = {
  from,
  rpc: vi.fn(),
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ID = "550e8400-e29b-41d4-a716-446655440001";
const URL_BASE = "http://localhost";

function json(method: string, body: unknown) {
  return new NextRequest(`${URL_BASE}/api/x`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = { params: Promise.resolve({ id: ID }) };
const TIERS = [{ min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }];

type Case = {
  name: string;
  call: () => Promise<Response>;
  expected: Record<string, unknown>;
};

const CASES: Case[] = [
  {
    name: "POST /api/devices",
    call: async () =>
      (await import("../devices/route")).POST(
        json("POST", {
          edgeId: ID,
          devices: [{ componentId: "meter0", deviceType: "consumption_meter", name: "Meter" }],
        })
      ),
    expected: { plugin: "metering", target: { kind: "edge", id: ID }, method: "POST" },
  },
  {
    name: "PATCH /api/devices/[id]",
    call: async () =>
      (await import("../devices/[id]/route")).PATCH(json("PATCH", { name: "Meter" }), params),
    expected: { plugin: "metering", target: { kind: "device", id: ID }, method: "PATCH" },
  },
  {
    name: "PATCH /api/edges/[id]",
    call: async () =>
      (await import("../edges/[id]/route")).PATCH(json("PATCH", { name: "Edge" }), params),
    expected: { plugin: "metering", target: { kind: "edge", id: ID }, method: "PATCH" },
  },
  {
    name: "DELETE /api/edges/[id]",
    call: async () =>
      (await import("../edges/[id]/route")).DELETE(
        new NextRequest(`${URL_BASE}/api/edges/${ID}`, { method: "DELETE" }),
        params
      ),
    expected: { plugin: "metering", target: { kind: "edge", id: ID }, method: "DELETE" },
  },
  {
    name: "GET /api/edges/[id]/discover-devices",
    call: async () =>
      (await import("../edges/[id]/discover-devices/route")).GET(
        new NextRequest(`${URL_BASE}/api/edges/${ID}/discover-devices`),
        params
      ),
    expected: {
      plugin: "metering",
      target: { kind: "edge", id: ID },
      method: "GET",
      access: "write",
    },
  },
  {
    name: "POST /api/microgrids/[id]/edges/register",
    call: async () =>
      (await import("../microgrids/[id]/edges/register/route")).POST(
        json("POST", { edges: [{ openems_edge_id: "edge0", name: "Edge 0" }] }),
        params
      ),
    expected: { plugin: "metering", target: { kind: "microgrid", id: ID }, method: "POST" },
  },
  {
    name: "PUT /api/microgrids/[id]/openems-backend",
    call: async () =>
      (await import("../microgrids/[id]/openems-backend/route")).PUT(
        json("PUT", {
          type: "direct_url",
          backendUrl: "http://localhost:8075",
          known_edge_ids: ["edge0"],
        }),
        params
      ),
    expected: { plugin: "metering", target: { kind: "microgrid", id: ID }, method: "PUT" },
  },
  {
    name: "POST /api/microgrids/[id]/openems-backend/discover",
    call: async () =>
      (await import("../microgrids/[id]/openems-backend/discover/route")).POST(
        new NextRequest(`${URL_BASE}/api/x`, { method: "POST" }),
        params
      ),
    expected: { plugin: "metering", target: { kind: "microgrid", id: ID }, method: "POST" },
  },
  {
    name: "POST /api/rate-schedules",
    call: async () =>
      (await import("../rate-schedules/route")).POST(
        json("POST", { microgrid_id: ID, tiers: TIERS, service_charge: 0, tax_rate: 0 })
      ),
    expected: { plugin: "billing", target: { kind: "microgrid", id: ID }, method: "POST" },
  },
  {
    name: "PUT /api/rate-schedules/[id]",
    call: async () =>
      (await import("../rate-schedules/[id]/route")).PUT(
        json("PUT", { tiers: TIERS, service_charge: 0, tax_rate: 0 }),
        params
      ),
    expected: { plugin: "billing", target: { kind: "rateSchedule", id: ID }, method: "PUT" },
  },
  {
    name: "POST /api/openems/channels",
    call: async () =>
      (await import("../openems/channels/route")).POST(
        json("POST", { microgridId: ID, edgeIds: ["edge0"], channels: ["_sum/State"] })
      ),
    expected: {
      plugin: "metering",
      target: { kind: "microgrid", id: ID },
      method: "POST",
      access: "write",
    },
  },
  {
    name: "GET /api/openems/status",
    call: async () =>
      (await import("../openems/status/route")).GET(
        new NextRequest(`${URL_BASE}/api/openems/status?microgridId=${ID}&edgeIds=edge0`)
      ),
    expected: {
      plugin: "metering",
      target: { kind: "microgrid", id: ID },
      method: "GET",
      access: "write",
    },
  },
];

describe("routes gated by the MGM runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateRoute.mockResolvedValue(
      NextResponse.json({ error: "disabled", code: "plugin_disabled" }, { status: 409 })
    );
  });

  it.each(CASES.flatMap(c => [409, 503].map(status => [c.name, c, status] as const)))(
    "%s stops before touching data when the gate returns %s",
    async (_name, testCase, status) => {
      gateRoute.mockResolvedValue(NextResponse.json({ error: "blocked", code: "plugin_blocked" }, { status }));
      const response = await testCase.call();
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code: "plugin_blocked" });
      expect(gateRoute).toHaveBeenCalledTimes(1);
      expect(gateRoute).toHaveBeenCalledWith(supabase, testCase.expected);
      expect(from).not.toHaveBeenCalled();
    }
  );
});

describe("POST /api/openems/energy", () => {
  it("resolves the devices' microgrid, then stops at the gate before calling OpenEMS", async () => {
    vi.clearAllMocks();
    gateRoute.mockResolvedValue(
      NextResponse.json({ error: "disabled", code: "metering_disabled" }, { status: 409 })
    );
    from.mockImplementationOnce((() => ({
      select: () => ({
        in: async () => ({
          data: [
            {
              id: ID,
              openems_component_id: "meter0",
              edges: { openems_edge_id: "edge0", microgrid_id: ID },
            },
          ],
          error: null,
        }),
      }),
    })) as never);
    const { POST } = await import("../openems/energy/route");
    const response = await POST(
      json("POST", { deviceIds: [ID], fromDate: "2026-09-01", toDate: "2026-09-30" })
    );
    expect(response.status).toBe(409);
    expect(gateRoute).toHaveBeenCalledWith(supabase, {
      plugin: "metering",
      target: { kind: "microgrid", id: ID },
      method: "POST",
      access: "write",
    });
    expect(from).toHaveBeenCalledTimes(1);
  });
});
