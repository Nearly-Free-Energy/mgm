/**
 * DELETE /api/communities/[id] + GET delete-preview route tests (#89).
 *
 * Covers: 400 invalid UUID, 403 unauthorized, 404 not found, 204 happy,
 * and the typed name every delete must carry: 428 with no confirmation (no
 * body, `{}`, or a confirmation with nothing typed) or the wrong name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let canAccessReturn = true;
let pluginEnabled = true;
let getUserReturn: { user: { id: string } | null } = {
  user: { id: "user-1" },
};

const mockFromImpl = vi.fn();
const mockRpcImpl = vi.fn();
const mockSupabaseClient = {
  from: (...args: unknown[]) => mockFromImpl(...args),
  rpc: (...args: unknown[]) => mockRpcImpl(...args),
  auth: { getUser: async () => ({ data: getUserReturn }) },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockSupabaseClient,
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessCommunity: async () => canAccessReturn,
  currentUserCanAccessMicrogrid: async () => canAccessReturn,
  currentUserIsSuperAdmin: async () => canAccessReturn,
  getCurrentUserRoles: async () =>
    canAccessReturn
      ? [{ role: "org_manager", scope_type: "org", scope_id: "org-1" }]
      : [],
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/plugins/state", () => ({
  isCommunityManagementEnabled: async () => pluginEnabled,
  // Read by the MGM runtime gate (src/lib/runtime/gate.ts).
  isPluginEnabledForOrg: async () => pluginEnabled,
}));

function chainable(result: { data: unknown; error: unknown; count?: number }) {
  const stub: {
    eq: (...args: unknown[]) => typeof stub;
    in: (...args: unknown[]) => typeof stub;
    or: (...args: unknown[]) => typeof stub;
    maybeSingle: () => Promise<unknown>;
    then: (onFulfilled: (v: unknown) => unknown) => Promise<unknown>;
  } = {
    eq: () => stub,
    in: () => stub,
    or: () => stub,
    maybeSingle: () => Promise.resolve(result),
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return stub;
}

// `rows` gives the descendant counters' non-count reads per table; every
// other read returns no rows.
function configureEntityLookup(
  result: {
    data: { id: string; name: string; org_id: string } | null;
    error: { code?: string; message: string } | null;
  },
  rows: Record<string, unknown[]> = {}
) {
  mockFromImpl.mockImplementation((table: string) => {
    if (table === "communities") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => result }),
        }),
      };
    }
    return {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) =>
        opts?.head
          ? chainable({ data: null, error: null, count: 0 })
          : chainable({ data: rows[table] ?? [], error: null }),
    };
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

/** A DELETE with the community's name typed, as its page and the GUI host send it. */
function makeDelete(id: string, typed = "Kisakye"): NextRequest {
  return new NextRequest(`http://localhost/api/communities/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: { acknowledged: [], typed } }),
  });
}

describe("DELETE /api/communities/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
    pluginEnabled = true;
    getUserReturn = { user: { id: "user-1" } };
  });

  it("400 on malformed UUID", async () => {
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete("bogus"), {
      params: Promise.resolve({ id: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("403 when caller cannot access community", async () => {
    canAccessReturn = false;
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(403);
  });

  it("404 when community does not exist", async () => {
    configureEntityLookup({ data: null, error: null });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("204 happy path + rpc dispatched to fn_entity_delete_community", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "Kisakye", org_id: "org-1" },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(204);
    expect(mockRpcImpl).toHaveBeenCalledWith("fn_entity_delete_community", {
      p_id: VALID_UUID,
    });
    infoSpy.mockRestore();
  });

  it("409 that says why when the database keeps the community's billing", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "Kisakye", org_id: "org-1" },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23514",
        message: "billing_period_kept: a community with closed billing periods cannot be deleted",
        details: "closed",
      },
    });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "This community has closed billing periods, which are kept as the billing record, so it cannot be deleted."
    );
  });

  it("409 when community management is disabled — records are preserved", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "Kisakye", org_id: "org-1" },
      error: null,
    });
    pluginEnabled = false;
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(409);
    expect(mockRpcImpl).not.toHaveBeenCalled();
  });
});

describe("GET /api/communities/[id]/delete-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
  });

  it("200 happy path returns { entity, descendant_counts, as_of, parent }", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "Kisakye", org_id: "org-1" },
      error: null,
    });

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/communities/${VALID_UUID}/delete-preview`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity.id).toBe(VALID_UUID);
    expect(json.descendant_counts.kind).toBe("community");
    expect(typeof json.as_of).toBe("string");
    // Parent resolves to organization for a community.
    expect(json.parent).toEqual({ kind: "organization", id: "org-1" });
  });

  it("409 with the reason when one of its microgrids has closed or paid billing", async () => {
    configureEntityLookup(
      { data: { id: VALID_UUID, name: "Kisakye", org_id: "org-1" }, error: null },
      {
        microgrids: [{ id: "mg-1" }, { id: "mg-2" }],
        billing_periods: [
          { id: "period-1", status: "closed" },
          { id: "period-2", status: "draft" },
        ],
        payment_attempts: [{ billing_line_items: { billing_period_id: "period-2" } }],
      }
    );

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/communities/${VALID_UUID}/delete-preview`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "This community has 1 closed billing period and 1 billing period with recorded payments. Closed billing and billing with recorded payments are kept, so this community cannot be deleted."
    );
  });
});

describe("DELETE /api/communities/[id] with the GUI host's typed confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
    pluginEnabled = true;
    getUserReturn = { user: { id: "user-1" } };
    configureEntityLookup({ data: { id: VALID_UUID, name: "Kisakye East", org_id: "org-1" }, error: null });
  });

  const withBody = (body: string) =>
    new NextRequest(`http://localhost/api/communities/${VALID_UUID}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body,
    });
  const confirmed = (typed: string) => withBody(JSON.stringify({ confirmation: { acknowledged: [], typed } }));

  it("deletes when the name typed is the community's, ignoring case and spacing", async () => {
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(confirmed("  kisakye   EAST "), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(204);
    expect(mockRpcImpl).toHaveBeenCalledWith("fn_entity_delete_community", { p_id: VALID_UUID });
    infoSpy.mockRestore();
  });

  it("answers 428 and deletes nothing when the name typed is another, or none was typed", async () => {
    const { DELETE } = await import("../[id]/route");
    for (const request of [confirmed("Kisakye"), withBody(JSON.stringify({ confirmation: { acknowledged: [] } }))]) {
      const res = await DELETE(request, { params: Promise.resolve({ id: VALID_UUID }) });
      expect(res.status).toBe(428);
      expect(await res.json()).toEqual({
        error: "Type the community's name, Kisakye East, to delete it.",
        code: "community_delete_name_mismatch",
        field: "confirmation",
      });
    }
    expect(mockRpcImpl).not.toHaveBeenCalled();
  });

  it("deletes a community whose name is longer than 200 characters, typed in full", async () => {
    const name = `Kisakye ${"East ".repeat(60)}`.trim();
    configureEntityLookup({ data: { id: VALID_UUID, name, org_id: "org-1" }, error: null });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(confirmed(name), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(name.length).toBeGreaterThan(200);
    expect(res.status).toBe(204);
    infoSpy.mockRestore();
  });

  it("answers 428 and deletes nothing without a confirmation, whether the body is empty or {}", async () => {
    const { DELETE } = await import("../[id]/route");
    const bare = new NextRequest(`http://localhost/api/communities/${VALID_UUID}`, { method: "DELETE" });
    for (const request of [bare, withBody(""), withBody("{}")]) {
      const res = await DELETE(request, { params: Promise.resolve({ id: VALID_UUID }) });
      expect(res.status).toBe(428);
      expect(await res.json()).toEqual({
        error: "Type the community's name, Kisakye East, to delete it.",
        code: "community_delete_confirmation_required",
      });
    }
    expect(mockRpcImpl).not.toHaveBeenCalled();
  });

  it("answers 400 invalid_body for a body that is not a confirmation, and deletes nothing", async () => {
    const { DELETE } = await import("../[id]/route");
    for (const body of ["{not json", JSON.stringify({ name: "Kisakye East" })]) {
      const res = await DELETE(withBody(body), { params: Promise.resolve({ id: VALID_UUID }) });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_body");
    }
    expect(mockRpcImpl).not.toHaveBeenCalled();
  });
});
