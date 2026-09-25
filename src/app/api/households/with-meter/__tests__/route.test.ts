/**
 * POST /api/households/with-meter — route tests (#155).
 *
 * Released mutations route through the community-management Cordis
 * capability. Auth/role/plugin checks are mocked; Supabase chains cover
 * parent resolution and the household RPCs.
 *
 * Coverage focus: phone-required validation. The capability validates phone
 * BEFORE calling the RPC (defense-in-depth) so non-form callers (bulk
 * imports, scripts) get a structured 400 without a DB round-trip.
 *
 * Covers:
 *   - 400: missing primary_phone (key absent)
 *   - 400: empty primary_phone ("")
 *   - 400: whitespace primary_phone ("   ")
 *   - 400: null primary_phone
 *   - 400: invalid JSON
 *   - 422: missing microgrid_id / display_name / device_id
 *   - 201: happy path with valid phone
 *   - 400: RPC raises 'household_phone_required' (defense-in-depth path)
 *   - 403: caller has no role for the parent org
 *   - 409: community management disabled for the parent org
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockRpc = vi.fn();
let roleRows: unknown[] = [];
let pluginEnabled = true;
let currentUser: { id: string } | null = { id: "user-1" };

const ORG_ID = "660e8400-e29b-41d4-a716-446655440099";

const mockFrom = vi.fn((table: string) => {
  if (table === "microgrids") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: MG_UUID,
              community_id: COMMUNITY_ID,
              communities: { org_id: ORG_ID },
            },
            error: null,
          }),
        }),
      }),
    };
  }
  if (table === "communities") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { org_id: ORG_ID },
            error: null,
          }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table: ${table}`);
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => roleRows,
  currentUserCanAccessOrg: async () => roleRows.length > 0,
}));

vi.mock("@/lib/plugins/state", () => ({
  isCommunityManagementEnabled: async () => pluginEnabled,
}));

const MG_UUID = "660e8400-e29b-41d4-a716-446655440000";
const COMMUNITY_ID = "660e8400-e29b-41d4-a716-446655440010";
const DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544aaaa";
const NEW_HH_UUID = "660e8400-e29b-41d4-a716-446655440111";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/households/with-meter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  microgrid_id: MG_UUID,
  display_name: "Block A, Unit 1",
  device_id: DEVICE_UUID,
  primary_phone: "+256700000000",
};

describe("POST /api/households/with-meter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: "user-1" };
    roleRows = [
      {
        user_id: "user-1",
        role: "org_manager",
        scope_type: "org",
        scope_id: ORG_ID,
      },
    ];
    pluginEnabled = true;
    mockRpc.mockResolvedValue({ data: NEW_HH_UUID, error: null });
  });

  it("400: invalid JSON", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest("{not json"));
    expect(res.status).toBe(400);
  });

  it("422: missing microgrid_id", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, microgrid_id: "" })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("microgrid_id");
  });

  it("422: missing display_name", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, display_name: "" })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("display_name");
  });

  it("403: caller has no role for the parent org", async () => {
    roleRows = [];
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("409: community management disabled for the parent org", async () => {
    pluginEnabled = false;
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("community_management_disabled");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("201: empty device_id routes to fn_create_household (manual billing) (#158)", async () => {
    // #158: device_id is now optional. Empty/missing/null device_id routes
    // to fn_create_household (no meter wiring); a non-empty UUID still
    // routes to fn_create_household_with_meter.
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, device_id: "" })
    );
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0];
    expect(fnName).toBe("fn_create_household");
    expect((args as Record<string, unknown>).p_device_id).toBeNull();
  });

  it("400: #155 — primary_phone key missing returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const { primary_phone: _phone, ...withoutPhone } = VALID_BODY;
    void _phone;
    const res = await POST(makePostRequest(withoutPhone));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(json.field).toBe("primary_phone");
    // No DB round-trip
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400: #155 — empty primary_phone returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, primary_phone: "" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400: #155 — whitespace primary_phone returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, primary_phone: "   " })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400: #155 — null primary_phone returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, primary_phone: null })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("201: happy path with valid phone", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.household_id).toBe(NEW_HH_UUID);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0];
    expect(fnName).toBe("fn_create_household_with_meter");
    expect((args as Record<string, unknown>).p_primary_phone).toBe(
      "+256700000000"
    );
  });

  it("400: #155 — RPC raises household_phone_required → 400 (defense-in-depth)", async () => {
    // Should be unreachable in practice (capability guards first) but this path
    // protects against direct RPC callers if anyone bypasses the route.
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "household_phone_required" },
    });
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_BODY));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
  });

  it("201: #158 — null device_id calls fn_create_household with p_device_id=null", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, device_id: null })
    );
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0];
    expect(fnName).toBe("fn_create_household");
    expect((args as Record<string, unknown>).p_device_id).toBeNull();
    expect((args as Record<string, unknown>).p_primary_phone).toBe(
      "+256700000000"
    );
  });

  it("201: #158 — missing device_id key calls fn_create_household", async () => {
    const { POST } = await import("../route");
    const { device_id: _drop, ...withoutDeviceId } = VALID_BODY;
    void _drop;
    const res = await POST(makePostRequest(withoutDeviceId));
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0];
    expect(fnName).toBe("fn_create_household");
    expect((args as Record<string, unknown>).p_device_id).toBeNull();
  });

  it("201: #158 — non-empty device_id calls fn_create_household_with_meter", async () => {
    // Backwards compatibility: existing metered path is preserved.
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0];
    expect(fnName).toBe("fn_create_household_with_meter");
    expect((args as Record<string, unknown>).p_device_id).toBe(DEVICE_UUID);
  });

  it("400: #158 — null phone with null device_id still rejects (phone-required preserved)", async () => {
    // Coordinated #155 + #158: even on the no-meter path, phone is required.
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, device_id: null, primary_phone: null })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
