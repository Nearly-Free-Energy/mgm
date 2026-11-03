/**
 * DELETE /api/microgrids/[id] + GET delete-preview route tests (#89).
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
  currentUserCanAccessMicrogrid: async () => canAccessReturn,
  currentUserCanAccessCommunity: async () => canAccessReturn,
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
    data: { id: string; name: string; community_id: string } | null;
    error: { code?: string; message: string } | null;
  },
  rows: Record<string, unknown[]> = {}
) {
  mockFromImpl.mockImplementation((table: string) => {
    if (table === "microgrids") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => result }),
        }),
      };
    }
    if (table === "communities") {
      // Parent lookup: the organization the runtime gate checks.
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { org_id: "550e8400-e29b-41d4-a716-4466554400f0" },
              error: null,
            }),
          }),
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

function makeDelete(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/microgrids/${id}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/microgrids/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
    pluginEnabled = true;
    getUserReturn = { user: { id: "user-1" } };
  });

  it("400 malformed UUID", async () => {
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete("bad"), {
      params: Promise.resolve({ id: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("403 when caller cannot access microgrid", async () => {
    canAccessReturn = false;
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(403);
  });

  it("404 when microgrid not found", async () => {
    configureEntityLookup({ data: null, error: null });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("204 happy path + fn_entity_delete_microgrid dispatch", async () => {
    configureEntityLookup({
      data: {
        id: VALID_UUID,
        name: "Kisakye Main",
        community_id: "comm-1",
      },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(204);
    expect(mockRpcImpl).toHaveBeenCalledWith("fn_entity_delete_microgrid", {
      p_id: VALID_UUID,
    });
    infoSpy.mockRestore();
  });

  it("409 that says why when the database keeps the microgrid's billing", async () => {
    const kisakye = { id: VALID_UUID, name: "Kisakye Main", community_id: "comm-1" };
    const cases = [
      {
        details: "closed",
        message: "billing_period_kept: a microgrid with closed billing periods cannot be deleted",
        expected:
          "This microgrid has closed billing periods, which are kept as the billing record, so it cannot be deleted.",
      },
      {
        details: "payment_activity",
        message: "billing_period_kept: a microgrid with recorded payments cannot be deleted",
        expected:
          "This microgrid has billing with recorded payments, which is kept with its payment records, so it cannot be deleted.",
      },
    ];
    const { DELETE } = await import("../[id]/route");
    for (const refusal of cases) {
      configureEntityLookup({ data: kisakye, error: null });
      mockRpcImpl.mockResolvedValueOnce({
        data: null,
        error: { code: "23514", message: refusal.message, details: refusal.details },
      });
      const res = await DELETE(makeDelete(VALID_UUID), {
        params: Promise.resolve({ id: VALID_UUID }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(refusal.expected);
    }
  });

  it("409 when community management is disabled — records are preserved", async () => {
    configureEntityLookup({
      data: {
        id: VALID_UUID,
        name: "Kisakye Main",
        community_id: "comm-1",
      },
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

describe("GET /api/microgrids/[id]/delete-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
  });

  it("200 happy path — parent = { kind:'community', id:<community_id> }", async () => {
    configureEntityLookup({
      data: {
        id: VALID_UUID,
        name: "Kisakye Main",
        community_id: "comm-1",
      },
      error: null,
    });

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/microgrids/${VALID_UUID}/delete-preview`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.descendant_counts.kind).toBe("microgrid");
    expect(json.parent).toEqual({ kind: "community", id: "comm-1" });
  });

  it("409 with the reason, and no counts, when the microgrid has a closed billing period", async () => {
    configureEntityLookup(
      { data: { id: VALID_UUID, name: "Kisakye Main", community_id: "comm-1" }, error: null },
      {
        billing_periods: [
          { id: "period-1", status: "closed" },
          { id: "period-2", status: "closed" },
          { id: "period-3", status: "draft" },
        ],
      }
    );

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/microgrids/${VALID_UUID}/delete-preview`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This microgrid has 2 closed billing periods. Closed billing and billing with recorded payments are kept, so this microgrid cannot be deleted.",
    });
  });

  it("409 when a draft period has recorded payments", async () => {
    configureEntityLookup(
      { data: { id: VALID_UUID, name: "Kisakye Main", community_id: "comm-1" }, error: null },
      {
        billing_periods: [{ id: "period-3", status: "draft" }],
        // The paid bill of the draft period, and a payment event on it.
        billing_line_items: [{ billing_period_id: "period-3" }],
        payment_events: [{ billing_line_items: { billing_period_id: "period-3" } }],
      }
    );

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/microgrids/${VALID_UUID}/delete-preview`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "This microgrid has 1 billing period with recorded payments. Closed billing and billing with recorded payments are kept, so this microgrid cannot be deleted."
    );
  });

  it("200 with the counts when its only billing is an unpaid draft", async () => {
    configureEntityLookup(
      { data: { id: VALID_UUID, name: "Kisakye Main", community_id: "comm-1" }, error: null },
      { billing_periods: [{ id: "period-3", status: "draft" }] }
    );

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/microgrids/${VALID_UUID}/delete-preview`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.descendant_counts.billing_periods_draft).toBe(1);
    expect(json.descendant_counts.billing_periods_with_payments).toBe(0);
  });
});
