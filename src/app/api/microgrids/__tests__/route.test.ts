/**
 * POST /api/microgrids & PATCH /api/microgrids/[id] — route tests (#76).
 *
 * Released mutations route through the community-management Cordis
 * capability. Auth/role/plugin checks are mocked; Supabase chains cover
 * parent resolution and persistence.
 *
 * Covers:
 *   - POST: 422 invalid currency (Intl.NumberFormat RangeError)
 *   - POST: 409 duplicate microgrid name in same community (Postgres 23505)
 *   - POST: 403 when the caller has no role for the parent org
 *   - POST: 409 when community management is disabled
 *   - PATCH: dirty-fields — sending {address_city} does NOT clobber name/currency
 *   - PATCH: 422 invalid currency on update
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

let roleRows: unknown[] = [];
let pluginEnabled = true;
let currentUser: { id: string } | null = { id: "user-1" };

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockSingleAfterInsertSelect = vi.fn();
const mockMaybeSingleAfterUpdateSelect = vi.fn();
const mockParentMaybeSingle = vi.fn();

const mockFrom = vi.fn((table: string) => {
  if (table === "communities") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => mockParentMaybeSingle(),
        }),
      }),
    };
  }
  if (table === "microgrids") {
    return {
      insert: (row: unknown) => {
        mockInsert(row);
        return {
          select: () => ({
            single: () => mockSingleAfterInsertSelect(),
          }),
        };
      },
      update: (patch: unknown) => {
        mockUpdate(patch);
        return {
          eq: () => ({
            select: () => ({
              maybeSingle: () => mockMaybeSingleAfterUpdateSelect(),
            }),
          }),
        };
      },
      select: () => ({
        eq: () => ({
          maybeSingle: () => mockParentMaybeSingle(),
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
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => roleRows,
  currentUserCanAccessOrg: async () => roleRows.length > 0,
  currentUserCanAccessCommunity: async () => roleRows.length > 0,
  currentUserCanAccessMicrogrid: async () => roleRows.length > 0,
}));

vi.mock("@/lib/plugins/state", () => ({
  isCommunityManagementEnabled: async () => pluginEnabled,
}));

const VALID_ORG = "550e8400-e29b-41d4-a716-446655440000";
const VALID_COMMUNITY = "550e8400-e29b-41d4-a716-446655440000";
const VALID_MICROGRID = "550e8400-e29b-41d4-a716-446655440001";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/microgrids", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePatch(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/microgrids/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedRole() {
  roleRows = [
    {
      user_id: "user-1",
      role: "org_manager",
      scope_type: "org",
      scope_id: VALID_ORG,
    },
  ];
}

// ── POST tests ──────────────────────────────────────────────────────────

describe("POST /api/microgrids", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: "user-1" };
    seedRole();
    pluginEnabled = true;
    mockSingleAfterInsertSelect.mockReset();
    mockParentMaybeSingle.mockReset().mockResolvedValue({
      data: { org_id: VALID_ORG },
      error: null,
    });
  });

  it("returns 422 with field='currency' when currency is invalid", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "XXX_NOT_A_CODE",
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("currency");
  });

  it("returns 422 when currency is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("currency");
  });

  it("returns 403 when the caller has no role for the parent org", async () => {
    roleRows = [];
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "UGX",
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when community management is disabled", async () => {
    pluginEnabled = false;
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "UGX",
      })
    );
    expect(res.status).toBe(409);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 409 with the exact duplicate-name message on Postgres 23505", async () => {
    mockSingleAfterInsertSelect.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "microgrids_community_name_unique"',
      },
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "Kisakye MG-1",
        currency: "UGX",
      })
    );

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe(
      "A microgrid named 'Kisakye MG-1' already exists in this community."
    );
    expect(json.field).toBe("name");
  });

  it("returns 201 with the inserted row on happy path", async () => {
    mockSingleAfterInsertSelect.mockResolvedValueOnce({
      data: { id: "m1", name: "New MG", currency: "USD" },
      error: null,
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "USD",
      })
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.microgrid.id).toBe("m1");

    // Verify currency was sent as uppercase ISO code
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "USD",
      })
    );

    expect(mockRevalidatePath).toHaveBeenCalledWith("/microgrids", "layout");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/communities/${VALID_COMMUNITY}`,
      "layout"
    );
  });
});

// ── PATCH tests ─────────────────────────────────────────────────────────

describe("PATCH /api/microgrids/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: "user-1" };
    seedRole();
    pluginEnabled = true;
    mockMaybeSingleAfterUpdateSelect.mockReset();
    // Route prefetch and operation resolution share this mock. Calls in
    // order: route parent prefetch, operation microgrid fetch, operation
    // community-org fetch.
    mockParentMaybeSingle.mockReset();
    mockParentMaybeSingle
      .mockResolvedValueOnce({
        data: {
          id: VALID_MICROGRID,
          community_id: VALID_COMMUNITY,
          communities: { org_id: VALID_ORG },
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: VALID_MICROGRID, community_id: VALID_COMMUNITY },
        error: null,
      })
      .mockResolvedValue({
        data: { org_id: VALID_ORG },
        error: null,
      });
  });

  it("dirty-fields: sending {address_city} does NOT clobber name/currency", async () => {
    mockMaybeSingleAfterUpdateSelect.mockResolvedValueOnce({
      data: {
        id: "m1",
        name: "Kisakye MG-1",
        currency: "UGX",
        address_city: "Entebbe",
      },
      error: null,
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatch(VALID_MICROGRID, { address_city: "Entebbe" }), {
      params: Promise.resolve({ id: VALID_MICROGRID }),
    });

    expect(res.status).toBe(200);
    // Supabase update() called with ONLY { address_city: 'Entebbe' } — NOT name, NOT currency
    expect(mockUpdate).toHaveBeenCalledWith({ address_city: "Entebbe" });
  });

  it("returns 422 when PATCH body has invalid currency", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_MICROGRID, { currency: "BOGUS" }),
      { params: Promise.resolve({ id: VALID_MICROGRID }) }
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("currency");
  });

  it("returns 403 when the caller has no role for the parent org", async () => {
    roleRows = [];
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatch(VALID_MICROGRID, { name: "X" }), {
      params: Promise.resolve({ id: VALID_MICROGRID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 409 on rename collision with 23505 constraint", async () => {
    mockMaybeSingleAfterUpdateSelect.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "microgrids_community_name_unique"',
      },
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_MICROGRID, { name: "Kisakye MG-1" }),
      { params: Promise.resolve({ id: VALID_MICROGRID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe(
      "A microgrid named 'Kisakye MG-1' already exists in this community."
    );
  });
});
