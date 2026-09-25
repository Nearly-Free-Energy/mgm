/**
 * PATCH /api/households/[id] — route tests (#145 + #146).
 *
 * Released mutations route through the community-management Cordis
 * capability. Auth/role/plugin checks are mocked; Supabase chains cover
 * household resolution, device reconciliation, and persistence.
 *
 * Covers:
 *   - 400: bad UUID, invalid JSON, empty diff, unsupported field, invalid display_name
 *   - 200: happy path (display_name only, no device touch)
 *   - 200: happy path (device_id link via delete-then-insert)
 *   - 200: happy path (device_id: null → unlink only, no field update)
 *   - 200: #146 — address_city, address_region, address_country, address_postal_code, geography_notes accepted
 *   - 403: forbidden when the caller has no role for the parent org
 *   - 404: not found (household missing or RLS-hidden)
 *   - 409: device_id partial-unique-index conflict (23505)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

let roleRows: unknown[] = [];
let pluginEnabled = true;
let currentUser: { id: string } | null = { id: "user-1" };

const ORG_ID = "660e8400-e29b-41d4-a716-446655440099";

// Per-test handlers for each Supabase chain entry-point.
const mockHouseholdsFetchSingle = vi.fn();
const mockHouseholdsUpdateSingle = vi.fn();
const mockHouseholdsRefetchSingle = vi.fn();
const mockHouseholdDevicesInsert = vi.fn();
const mockLinkCloseUpdate = vi.fn();
const mockLinkCloseResult = vi.fn(async () => ({ error: null }));
// Steal-check: SELECT household_id ... WHERE device_id=? AND role=? AND household_id != ? AND effective_to IS NULL
const mockHouseholdDevicesStealCheckMaybeSingle = vi.fn();
// Open-link lookup: SELECT id, device_id ... WHERE household_id=? AND role=? AND effective_to IS NULL
const mockOpenLinkMaybeSingle = vi.fn();
const mockUpdatePayload = vi.fn();
const mockHouseholdsDeleteSingle = vi.fn();
let billingLineItemCount: number | null = 0;

const OLD_DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544bbbb";

const mockFrom = vi.fn((table: string) => {
  if (table === "households") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => mockHouseholdsFetchSingle(),
          single: () => mockHouseholdsRefetchSingle(),
        }),
      }),
      update: (payload: unknown) => {
        mockUpdatePayload(payload);
        return {
          eq: () => ({
            select: () => ({
              single: () => mockHouseholdsUpdateSingle(),
            }),
          }),
        };
      },
      delete: () => ({
        eq: () => ({
          select: () => mockHouseholdsDeleteSingle(),
        }),
      }),
    };
  }
  if (table === "household_devices") {
    return {
      // Steal-check path: select().eq().eq().neq().is().maybeSingle()
      // Open-link path:   select().eq().eq().is().maybeSingle()
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              is: () => ({
                maybeSingle: () => mockHouseholdDevicesStealCheckMaybeSingle(),
              }),
            }),
            is: () => ({
              maybeSingle: () => mockOpenLinkMaybeSingle(),
            }),
          }),
        }),
      }),
      // Link close: update({ effective_to }).eq("id")
      update: (patch: unknown) => {
        mockLinkCloseUpdate(patch);
        return { eq: () => mockLinkCloseResult() };
      },
      insert: (row: unknown) => mockHouseholdDevicesInsert(row),
    };
  }
  if (table === "microgrids") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: MG_UUID,
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
  if (table === "billing_line_items") {
    return {
      select: () => ({
        eq: async () => ({ count: billingLineItemCount, error: null }),
      }),
    };
  }
  throw new Error(`Unexpected table: ${table}`);
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => roleRows,
  currentUserCanAccessOrg: async () => roleRows.length > 0,
  currentUserCanAccessMicrogrid: async () => roleRows.length > 0,
}));

vi.mock("@/lib/plugins/state", () => ({
  isCommunityManagementEnabled: async () => pluginEnabled,
}));

const HH_UUID = "660e8400-e29b-41d4-a716-446655440001";
const HH_UUID_B = "660e8400-e29b-41d4-a716-446655440002";
const MG_UUID = "660e8400-e29b-41d4-a716-446655440099";
const DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544aaaa";
const BAD_ID = "not-a-uuid";

function makePatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/households/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /api/households/[id]", () => {
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

    mockHouseholdsFetchSingle.mockReset().mockResolvedValue({
      data: { id: HH_UUID, microgrid_id: MG_UUID },
      error: null,
    });
    mockHouseholdsUpdateSingle.mockReset().mockResolvedValue({
      data: {
        id: HH_UUID,
        microgrid_id: MG_UUID,
        display_name: "Updated",
        primary_email: null,
        primary_phone: null,
        address_line1: null,
        address_line2: null,
        unit_label: null,
      },
      error: null,
    });
    mockHouseholdsRefetchSingle.mockReset().mockResolvedValue({
      data: {
        id: HH_UUID,
        microgrid_id: MG_UUID,
        display_name: "Existing",
        primary_email: null,
        primary_phone: null,
        address_line1: null,
        address_line2: null,
        unit_label: null,
      },
      error: null,
    });
    mockLinkCloseUpdate.mockReset();
    mockLinkCloseResult.mockReset().mockResolvedValue({ error: null });
    mockHouseholdDevicesInsert.mockReset().mockResolvedValue({
      error: null,
    });
    // Default: an open link to a different device (replacement path)
    mockOpenLinkMaybeSingle.mockReset().mockResolvedValue({
      data: { id: "link-1", device_id: OLD_DEVICE_UUID },
      error: null,
    });
    // Default: no existing cross-household link (steal check passes)
    mockHouseholdDevicesStealCheckMaybeSingle.mockReset().mockResolvedValue({
      data: null,
      error: null,
    });
  });

  it("400: bad UUID", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(BAD_ID, { display_name: "x" }), {
      params: Promise.resolve({ id: BAD_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: invalid JSON", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(HH_UUID, "{not json"), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: empty diff", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(HH_UUID, {}), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("empty_diff");
  });

  it("400: unsupported field rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { microgrid_id: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Unsupported field: microgrid_id");
    expect(json.reason).toBe("unsupported_field");
  });

  it("400: empty display_name rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "   " }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("invalid_display_name");
  });

  it("400: non-UUID device_id rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: "not-a-uuid" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("invalid_device_id");
  });

  it("200: happy path — display_name only", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "New Name" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.household).toBeDefined();
    expect(mockHouseholdsUpdateSingle).toHaveBeenCalledTimes(1);
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
    expect(mockHouseholdDevicesInsert).not.toHaveBeenCalled();
  });

  it("200: happy path — device link (close-and-open preserves history)", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(mockLinkCloseUpdate).toHaveBeenCalledWith({ effective_to: today });
    expect(mockHouseholdDevicesInsert).toHaveBeenCalledTimes(1);
    expect(mockHouseholdDevicesInsert).toHaveBeenCalledWith({
      household_id: HH_UUID,
      device_id: DEVICE_UUID,
      role: "primary_consumption_meter",
      effective_from: today,
    });
  });

  it("200: relinking the already-open device is a no-op (no history churn)", async () => {
    mockOpenLinkMaybeSingle.mockReset().mockResolvedValue({
      data: { id: "link-1", device_id: DEVICE_UUID },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
    expect(mockHouseholdDevicesInsert).not.toHaveBeenCalled();
  });

  it("200: happy path — device unlink (device_id: null) → close only, no insert, no household update", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: null }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(mockLinkCloseUpdate).toHaveBeenCalledWith({ effective_to: today });
    expect(mockHouseholdDevicesInsert).not.toHaveBeenCalled();
    // No household-field update — refetch path
    expect(mockHouseholdsUpdateSingle).not.toHaveBeenCalled();
    expect(mockHouseholdsRefetchSingle).toHaveBeenCalledTimes(1);
  });

  it("200: #146 — address fields accepted (address_city, region, country, postal_code, geography_notes)", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, {
        address_city: "Kampala",
        address_region: "Central Region",
        address_country: "Uganda",
        address_postal_code: "00256",
        geography_notes: "Near the market",
      }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.household).toBeDefined();
    expect(mockHouseholdsUpdateSingle).toHaveBeenCalledTimes(1);
  });

  it("403: caller has no role for the parent org", async () => {
    roleRows = [];
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("forbidden");
  });

  it("404: household not found", async () => {
    mockHouseholdsFetchSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(404);
  });

  it("409: device link conflict (Postgres 23505)", async () => {
    mockHouseholdDevicesInsert.mockResolvedValueOnce({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_already_linked");
  });

  it("409: cross-household device steal blocked before any mutation", async () => {
    // Pre-seed: DEVICE_UUID is already the primary_consumption_meter for HH_UUID_B.
    // Household A (HH_UUID) attempts to claim it.
    mockHouseholdDevicesStealCheckMaybeSingle.mockResolvedValueOnce({
      data: { household_id: HH_UUID_B },
      error: null,
    });

    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );

    // Should be rejected with 409 device_already_linked
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_already_linked");
    expect(json.error).toMatch(/already linked to another household/);

    // Steal check fires BEFORE any mutation — no household-row update,
    // no close, no insert on household_devices.
    expect(mockHouseholdsUpdateSingle).not.toHaveBeenCalled();
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
    expect(mockHouseholdDevicesInsert).not.toHaveBeenCalled();
  });

  it("409: overlapping replacement rejected by the effective-period guard", async () => {
    mockHouseholdDevicesInsert.mockResolvedValueOnce({
      error: {
        code: "23505",
        message:
          "primary meter assignment for household overlaps an existing assignment",
      },
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_assignment_overlap");
  });

  it("400: #155 — clearing primary_phone via empty string is rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { primary_phone: "" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("household_phone_required");
    expect(json.error).toBe("household_phone_required");
    // No DB write
    expect(mockHouseholdsUpdateSingle).not.toHaveBeenCalled();
  });

  it("400: #155 — clearing primary_phone via whitespace is rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { primary_phone: "   " }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("household_phone_required");
  });

  it("400: #155 — clearing primary_phone via null is rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { primary_phone: null }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("household_phone_required");
  });

  it("200: #155 — PATCH that omits primary_phone still succeeds (backwards-compat)", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "Renamed" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockHouseholdsUpdateSingle).toHaveBeenCalledTimes(1);
  });

  it("200: #155 — PATCH with non-empty primary_phone is accepted", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { primary_phone: "+256700000001" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockHouseholdsUpdateSingle).toHaveBeenCalledTimes(1);
  });

  it("403: RLS denial (42501) on household update", async () => {
    mockHouseholdsUpdateSingle.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "new row violates row-level security policy for table households",
      },
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("rls_denied");
  });
});

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/households/${id}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/households/[id]", () => {
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
    billingLineItemCount = 0;
    mockHouseholdsFetchSingle.mockReset().mockResolvedValue({
      data: { id: HH_UUID, display_name: "Household A", microgrid_id: MG_UUID },
      error: null,
    });
    mockHouseholdsDeleteSingle.mockReset().mockResolvedValue({
      data: [{ id: HH_UUID }],
      error: null,
    });
  });

  it("400: bad UUID", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(BAD_ID), {
      params: Promise.resolve({ id: BAD_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("404: household not found", async () => {
    mockHouseholdsFetchSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(HH_UUID), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("403: caller has no role for the parent org", async () => {
    roleRows = [];
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(HH_UUID), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(403);
  });

  it("409: community management disabled — records are preserved", async () => {
    pluginEnabled = false;
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(HH_UUID), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("community_management_disabled");
    expect(mockHouseholdsDeleteSingle).not.toHaveBeenCalled();
  });

  it("409: household with billing history is refused", async () => {
    billingLineItemCount = 3;
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(HH_UUID), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("household_has_billing_history");
    expect(mockHouseholdsDeleteSingle).not.toHaveBeenCalled();
  });

  it("204: happy path deletes through the capability", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(HH_UUID), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(204);
    expect(mockHouseholdsDeleteSingle).toHaveBeenCalledTimes(1);
  });
});
