/**
 * POST /api/communities & PATCH /api/communities/[id] — route tests (#76).
 *
 * Released mutations route through the community-management Cordis
 * capability. These tests exercise the HTTP boundary with the composition
 * module's auth/role/plugin checks mocked, plus mocked Supabase chains for
 * parent resolution and persistence.
 *
 * Covers:
 *   - POST: 403 when the caller has no role for the org
 *   - POST: 400 on malformed org_id
 *   - POST: 422 on missing name
 *   - POST: 409 when the community plugin is disabled
 *   - PATCH: dirty-fields (address_city only → no name/geography_notes sent)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
  if (table !== "communities") throw new Error(`Unexpected table: ${table}`);
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
}));

vi.mock("@/lib/plugins/state", () => ({
  isCommunityManagementEnabled: async () => pluginEnabled,
}));

const VALID_ORG = "550e8400-e29b-41d4-a716-446655440000";
const VALID_COMMUNITY = "550e8400-e29b-41d4-a716-446655440010";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/communities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePatch(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/communities/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── POST tests ──────────────────────────────────────────────────────────

describe("POST /api/communities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: "user-1" };
    roleRows = [
      {
        user_id: "user-1",
        role: "org_manager",
        scope_type: "org",
        scope_id: VALID_ORG,
      },
    ];
    pluginEnabled = true;
    mockSingleAfterInsertSelect.mockReset();
    mockParentMaybeSingle.mockReset();
  });

  it("returns 400 when org_id is not a UUID", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ org_id: "not-a-uuid", name: "C1" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.field).toBe("org_id");
  });

  it("returns 422 on missing name", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePost({ org_id: VALID_ORG }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("name");
  });

  it("returns 403 when the caller has no role for the org (cross-org)", async () => {
    roleRows = [];
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ org_id: VALID_ORG, name: "Unauthorized C" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when community management is disabled for the org", async () => {
    pluginEnabled = false;
    const { POST } = await import("../route");
    const res = await POST(makePost({ org_id: VALID_ORG, name: "C1" }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("community_management_disabled");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 201 with the inserted row on happy path", async () => {
    mockSingleAfterInsertSelect.mockResolvedValueOnce({
      data: { id: "c1", name: "C1", org_id: VALID_ORG },
      error: null,
    });

    const { POST } = await import("../route");
    const res = await POST(makePost({ org_id: VALID_ORG, name: "C1" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.community.id).toBe("c1");

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: VALID_ORG, name: "C1" })
    );

    expect(mockRevalidatePath).toHaveBeenCalledWith("/communities", "layout");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/microgrids", "layout");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/organizations/${VALID_ORG}`,
      "layout"
    );
  });
});

// ── PATCH tests ─────────────────────────────────────────────────────────

describe("PATCH /api/communities/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: "user-1" };
    roleRows = [
      {
        user_id: "user-1",
        role: "org_manager",
        scope_type: "org",
        scope_id: VALID_ORG,
      },
    ];
    pluginEnabled = true;
    mockMaybeSingleAfterUpdateSelect.mockReset();
    mockParentMaybeSingle.mockReset().mockResolvedValue({
      data: { org_id: VALID_ORG },
      error: null,
    });
  });

  it("dirty-fields: only {address_city} sent when only city changed", async () => {
    mockMaybeSingleAfterUpdateSelect.mockResolvedValueOnce({
      data: {
        id: VALID_COMMUNITY,
        name: "Kisakye",
        address_city: "Entebbe",
        geography_notes: null,
      },
      error: null,
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_COMMUNITY, { address_city: "Entebbe" }),
      { params: Promise.resolve({ id: VALID_COMMUNITY }) }
    );

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ address_city: "Entebbe" });
  });

  it("returns 403 when the caller cannot access the community", async () => {
    roleRows = [];
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_COMMUNITY, { name: "X" }),
      { params: Promise.resolve({ id: VALID_COMMUNITY }) }
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when no fields to update", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_COMMUNITY, {}),
      { params: Promise.resolve({ id: VALID_COMMUNITY }) }
    );
    expect(res.status).toBe(400);
  });
});
