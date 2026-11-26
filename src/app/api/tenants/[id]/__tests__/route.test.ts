/**
 * PATCH /api/tenants/[id] — route tests (#145 + #146).
 *
 * Released mutations route through the community-management Cordis
 * capability. Auth/role/plugin checks are mocked; Supabase chains cover
 * tenant resolution, device reconciliation, and persistence.
 *
 * Covers:
 *   - 400: bad UUID, invalid JSON, empty diff, unsupported field, invalid display_name
 *   - 200: happy path (display_name only, no device touch)
 *   - 200: happy path (device_id link via delete-then-insert)
 *   - 200: happy path (device_id: null → unlink only, no field update)
 *   - 200: #146 — address_city, address_region, address_country, address_postal_code, geography_notes accepted
 *   - 403: forbidden when the caller has no role for the parent org
 *   - 404: not found (tenant missing or RLS-hidden)
 *   - 409: device_id partial-unique-index conflict (23505)
 *
 * DELETE /api/tenants/[id] requires the tenant's name typed: 428 with no
 * confirmation (no body, `{}`, or a confirmation with nothing typed) or the
 * wrong name, 409 for a tenant with no name to type.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

let roleRows: unknown[] = [];
let pluginEnabled = true;
let currentUser: { id: string } | null = { id: "user-1" };

const ORG_ID = "660e8400-e29b-41d4-a716-446655440099";

// Per-test handlers for each Supabase chain entry-point.
const mockTenantsFetchSingle = vi.fn();
const mockTenantsUpdateSingle = vi.fn();
const mockTenantsRefetchSingle = vi.fn();
const mockTenantDevicesInsert = vi.fn();
const mockLinkCloseUpdate = vi.fn();
const mockLinkCloseResult = vi.fn(async () => ({ error: null }));
// Steal-check: SELECT tenant_id ... WHERE device_id=? AND role=? AND tenant_id != ? AND effective_to IS NULL
const mockTenantDevicesStealCheckMaybeSingle = vi.fn();
// Open-link lookup: SELECT id, device_id, effective_from ... WHERE tenant_id=? AND role=? AND effective_to IS NULL
const mockOpenLinkMaybeSingle = vi.fn();
const mockUpdatePayload = vi.fn();
const mockTenantsDeleteSingle = vi.fn();
const mockLinkDelete = vi.fn(async () => ({ error: null }));
const mockReplaceRpc = vi.fn(
  async (): Promise<{
    data: string | null;
    error: { code: string; message: string } | null;
  }> => ({ data: "link-new", error: null })
);
let billingLineItemCount: number | null = 0;

const OLD_DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544bbbb";

const mockFrom = vi.fn((table: string) => {
  if (table === "tenants") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => mockTenantsFetchSingle(),
          single: () => mockTenantsRefetchSingle(),
        }),
      }),
      update: (payload: unknown) => {
        mockUpdatePayload(payload);
        return {
          eq: () => ({
            select: () => ({
              single: () => mockTenantsUpdateSingle(),
            }),
          }),
        };
      },
      delete: () => ({
        eq: () => ({
          select: () => mockTenantsDeleteSingle(),
        }),
      }),
    };
  }
  if (table === "tenant_devices") {
    return {
      // Steal-check path: select().eq().eq().neq().is().maybeSingle()
      // Open-link path:   select().eq().eq().is().maybeSingle()
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              is: () => ({
                maybeSingle: () => mockTenantDevicesStealCheckMaybeSingle(),
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
      // Same-day correction: delete().eq("id")
      delete: () => ({
        eq: () => mockLinkDelete(),
      }),
      insert: (row: unknown) => mockTenantDevicesInsert(row),
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
    rpc: mockReplaceRpc,
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
  isPluginEnabledForOrg: async () => pluginEnabled,
}));

const HH_UUID = "660e8400-e29b-41d4-a716-446655440001";
const HH_UUID_B = "660e8400-e29b-41d4-a716-446655440002";
const MG_UUID = "660e8400-e29b-41d4-a716-446655440099";
const DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544aaaa";
const BAD_ID = "not-a-uuid";

function makePatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/tenants/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /api/tenants/[id]", () => {
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

    mockTenantsFetchSingle.mockReset().mockResolvedValue({
      data: { id: HH_UUID, microgrid_id: MG_UUID },
      error: null,
    });
    mockTenantsUpdateSingle.mockReset().mockResolvedValue({
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
    mockTenantsRefetchSingle.mockReset().mockResolvedValue({
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
    mockTenantDevicesInsert.mockReset().mockResolvedValue({
      error: null,
    });
    // Default: an open link to a different device, opened in the past
    // (replacement path)
    mockOpenLinkMaybeSingle.mockReset().mockResolvedValue({
      data: { id: "link-1", device_id: OLD_DEVICE_UUID, effective_from: "2026-01-01" },
      error: null,
    });
    // Default: no existing cross-tenant link (steal check passes)
    mockTenantDevicesStealCheckMaybeSingle.mockReset().mockResolvedValue({
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
    expect(json.tenant).toBeDefined();
    expect(mockTenantsUpdateSingle).toHaveBeenCalledTimes(1);
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
    expect(mockTenantDevicesInsert).not.toHaveBeenCalled();
  });

  it("200: happy path — device link (atomic close-and-open preserves history)", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    // Single atomic swap — no separate close update or direct insert.
    expect(mockReplaceRpc).toHaveBeenCalledWith("fn_replace_tenant_device", {
      p_tenant_id: HH_UUID,
      p_device_id: DEVICE_UUID,
      p_effective_date: today,
    });
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
    expect(mockTenantDevicesInsert).not.toHaveBeenCalled();
  });

  it("200: relinking the already-open device is a no-op (no history churn)", async () => {
    mockOpenLinkMaybeSingle.mockReset().mockResolvedValue({
      data: { id: "link-1", device_id: DEVICE_UUID, effective_from: "2026-01-01" },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockReplaceRpc).not.toHaveBeenCalled();
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
    expect(mockTenantDevicesInsert).not.toHaveBeenCalled();
  });

  it("200: happy path — device unlink (device_id: null) → close only, no insert, no tenant update", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: null }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(mockLinkCloseUpdate).toHaveBeenCalledWith({ effective_to: today });
    expect(mockTenantDevicesInsert).not.toHaveBeenCalled();
    expect(mockReplaceRpc).not.toHaveBeenCalled();
    // No tenant-field update — refetch path
    expect(mockTenantsUpdateSingle).not.toHaveBeenCalled();
    expect(mockTenantsRefetchSingle).toHaveBeenCalledTimes(1);
  });

  it("200: same-day unlink deletes the link instead of zero-length closing", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockOpenLinkMaybeSingle.mockReset().mockResolvedValue({
      data: { id: "link-1", device_id: OLD_DEVICE_UUID, effective_from: today },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: null }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockLinkDelete).toHaveBeenCalledTimes(1);
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
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
    expect(json.tenant).toBeDefined();
    expect(mockTenantsUpdateSingle).toHaveBeenCalledTimes(1);
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

  it("404: tenant not found", async () => {
    mockTenantsFetchSingle.mockResolvedValueOnce({
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
    mockReplaceRpc.mockResolvedValueOnce({
      data: null,
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

  it("409: exclusion-conflict on concurrent replacement maps to overlap", async () => {
    mockReplaceRpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23P01",
        message: 'conflicting key value violates exclusion constraint "tenant_devices_primary_no_overlap"',
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

  it("409: cross-tenant device steal blocked before any mutation", async () => {
    // Pre-seed: DEVICE_UUID is already the primary_consumption_meter for HH_UUID_B.
    // Tenant A (HH_UUID) attempts to claim it.
    mockTenantDevicesStealCheckMaybeSingle.mockResolvedValueOnce({
      data: { tenant_id: HH_UUID_B },
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
    expect(json.error).toMatch(/already linked to another tenant/);

    // Steal check fires BEFORE any mutation — no tenant-row update,
    // no close, no insert, no replace RPC on tenant_devices.
    expect(mockTenantsUpdateSingle).not.toHaveBeenCalled();
    expect(mockLinkCloseUpdate).not.toHaveBeenCalled();
    expect(mockTenantDevicesInsert).not.toHaveBeenCalled();
    expect(mockReplaceRpc).not.toHaveBeenCalled();
  });

  it("409: overlapping replacement rejected by the effective-period guard", async () => {
    mockReplaceRpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message:
          "primary meter assignment for tenant overlaps an existing assignment",
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
    expect(json.reason).toBe("tenant_phone_required");
    expect(json.error).toBe("tenant_phone_required");
    // No DB write
    expect(mockTenantsUpdateSingle).not.toHaveBeenCalled();
  });

  it("400: #155 — clearing primary_phone via whitespace is rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { primary_phone: "   " }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("tenant_phone_required");
  });

  it("400: #155 — clearing primary_phone via null is rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { primary_phone: null }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("tenant_phone_required");
  });

  it("200: #155 — PATCH that omits primary_phone still succeeds (backwards-compat)", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "Renamed" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockTenantsUpdateSingle).toHaveBeenCalledTimes(1);
  });

  it("200: #155 — PATCH with non-empty primary_phone is accepted", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { primary_phone: "+256700000001" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockTenantsUpdateSingle).toHaveBeenCalledTimes(1);
  });

  it("403: RLS denial (42501) on tenant update", async () => {
    mockTenantsUpdateSingle.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "new row violates row-level security policy for table tenants",
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

/** A DELETE with the tenant's name typed, as the tenants page and the GUI host send it. */
function makeDeleteRequest(id: string, typed = "Tenant A"): NextRequest {
  return new NextRequest(`http://localhost/api/tenants/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: { acknowledged: [], typed } }),
  });
}

describe("DELETE /api/tenants/[id]", () => {
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
    mockTenantsFetchSingle.mockReset().mockResolvedValue({
      data: { id: HH_UUID, display_name: "Tenant A", microgrid_id: MG_UUID },
      error: null,
    });
    mockTenantsDeleteSingle.mockReset().mockResolvedValue({
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

  it("404: tenant not found", async () => {
    mockTenantsFetchSingle.mockResolvedValueOnce({
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
    expect(mockTenantsDeleteSingle).not.toHaveBeenCalled();
  });

  it("409: tenant with billing history is refused", async () => {
    billingLineItemCount = 3;
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(HH_UUID), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("tenant_has_billing_history");
    expect(mockTenantsDeleteSingle).not.toHaveBeenCalled();
  });

  it("204: happy path deletes through the capability", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(makeDeleteRequest(HH_UUID), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(204);
    expect(mockTenantsDeleteSingle).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/tenants/[id] with the GUI host's typed confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: "user-1" };
    roleRows = [{ user_id: "user-1", role: "org_manager", scope_type: "org", scope_id: ORG_ID }];
    pluginEnabled = true;
    billingLineItemCount = 0;
    mockTenantsFetchSingle.mockReset().mockResolvedValue({
      data: { id: HH_UUID, display_name: "Block A, Unit 1", microgrid_id: MG_UUID },
      error: null,
    });
    mockTenantsDeleteSingle.mockReset().mockResolvedValue({ data: [{ id: HH_UUID }], error: null });
  });

  const withBody = (body: string) =>
    new NextRequest(`http://localhost/api/tenants/${HH_UUID}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body,
    });
  const confirmed = (typed: string) => withBody(JSON.stringify({ confirmation: { acknowledged: [], typed } }));

  it("204: deletes when the name typed is the tenant's, ignoring case and spacing", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(confirmed("block a,  unit 1"), { params: Promise.resolve({ id: HH_UUID }) });
    expect(res.status).toBe(204);
    expect(mockTenantsDeleteSingle).toHaveBeenCalledTimes(1);
  });

  it("428: deletes nothing when the name typed is another, or none was typed", async () => {
    const { DELETE } = await import("../route");
    for (const request of [confirmed("Block A"), withBody(JSON.stringify({ confirmation: { acknowledged: [] } }))]) {
      const res = await DELETE(request, { params: Promise.resolve({ id: HH_UUID }) });
      expect(res.status).toBe(428);
      expect(await res.json()).toEqual({
        error: "Type the tenant's name, Block A, Unit 1, to delete it.",
        code: "tenant_delete_name_mismatch",
        field: "confirmation",
      });
    }
    expect(mockTenantsDeleteSingle).not.toHaveBeenCalled();
  });

  it("428: deletes nothing without a confirmation, whether the body is empty or {}", async () => {
    const { DELETE } = await import("../route");
    const bare = new NextRequest(`http://localhost/api/tenants/${HH_UUID}`, { method: "DELETE" });
    for (const request of [bare, withBody(""), withBody("{}")]) {
      const res = await DELETE(request, { params: Promise.resolve({ id: HH_UUID }) });
      expect(res.status).toBe(428);
      expect(await res.json()).toEqual({
        error: "Type the tenant's name, Block A, Unit 1, to delete it.",
        code: "tenant_delete_confirmation_required",
      });
    }
    expect(mockTenantsDeleteSingle).not.toHaveBeenCalled();
  });

  it("409: refuses a tenant with no name to type, with or without a confirmation", async () => {
    mockTenantsFetchSingle.mockResolvedValue({ data: { id: HH_UUID, display_name: "  ", microgrid_id: MG_UUID }, error: null });
    const { DELETE } = await import("../route");
    for (const request of [confirmed("  "), withBody("")]) {
      const res = await DELETE(request, { params: Promise.resolve({ id: HH_UUID }) });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Unnamed entity cannot be typed-to-confirm.", code: "tenant_unnamed" });
    }
    expect(mockTenantsDeleteSingle).not.toHaveBeenCalled();
  });

  it("403: still refuses a caller with no role before reading the confirmation", async () => {
    roleRows = [];
    const { DELETE } = await import("../route");
    const res = await DELETE(confirmed("Block A"), { params: Promise.resolve({ id: HH_UUID }) });
    expect(res.status).toBe(403);
    expect(mockTenantsDeleteSingle).not.toHaveBeenCalled();
  });

  it("400: a body that is not a confirmation deletes nothing", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(withBody(JSON.stringify({ typed: "Block A, Unit 1" })), { params: Promise.resolve({ id: HH_UUID }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_body");
    expect(mockTenantsDeleteSingle).not.toHaveBeenCalled();
  });
});
