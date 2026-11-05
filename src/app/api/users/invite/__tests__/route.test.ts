/**
 * POST /api/users/invite — route handler tests (UX5b / #184).
 *
 * No prior test suite existed for the invite route. This file covers
 * the happy paths + the new AC2 contract (data payload forwarded to
 * inviteUserByEmail).
 *
 * Mocks: Supabase user-bound + service-role clients, including the
 * fn_finalize_user_invitation RPC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────

let mockCaller: { id: string; email?: string } | null = null;
let mockCallerRoles: Array<{
  role: "super_admin" | "org_manager";
  scope_type: "org" | null;
  scope_id: string | null;
}> = [];
let mockRpcResult: { error: { code?: string; message: string } | null } = {
  error: null,
};
let mockInviteResult: {
  data: { user: { id: string } | null };
  error: { code?: string; message: string } | null;
} = {
  data: { user: { id: "00000000-0000-4000-8000-000000000099" } },
  error: null,
};

const inviteUserByEmailSpy = vi.fn();
const rpcSpy = vi.fn();
const deleteUserSpy = vi.fn();

// Service-role view of existing accounts (step 2 of the route).
let mockListUsers: {
  data: { users: Array<{ id: string; email: string; email_confirmed_at: string | null }> } | null;
  error: { message: string } | null;
} = { data: { users: [] }, error: null };
let mockTargetRoles: Array<{
  role: "super_admin" | "org_manager";
  scope_type: "org";
  scope_id: string | null;
}> = [];
let mockTargetProfile: {
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
} | null = null;
let mockTargetProfileError: { message: string } | null = null;

function svcFromImpl(table: string) {
  if (table === "user_roles") {
    return {
      select: () => ({
        eq: async () => ({ data: mockTargetRoles, error: null }),
      }),
    };
  }
  if (table === "user_profiles") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            mockTargetProfileError
              ? { data: null, error: mockTargetProfileError }
              : { data: mockTargetProfile, error: null },
        }),
      }),
    };
  }
  throw new Error(`Unexpected table in service client: ${table}`);
}

function userClientFromImpl(table: string) {
  if (table === "user_profiles") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: vi.fn(async () => ({
            data: { first_name: "Inviter", last_name: "Name" },
            error: null,
          })),
        }),
      }),
    };
  }
  if (table === "organizations") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: vi.fn(async () => ({
            data: { name: "Test Org" },
            error: null,
          })),
        }),
      }),
    };
  }
  if (table === "user_roles") {
    return {
      select: () => ({
        eq: () => ({
          returns: () =>
            Promise.resolve({ data: mockCallerRoles, error: null }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table in userClient: ${table}`);
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: vi.fn(userClientFromImpl),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockCaller },
        error: null,
      })),
    },
    rpc: vi.fn(async (...args: unknown[]) => {
      rpcSpy(...args);
      return mockRpcResult;
    }),
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: vi.fn(async (...args: unknown[]) => {
          inviteUserByEmailSpy(...args);
          return mockInviteResult;
        }),
        listUsers: vi.fn(async () => mockListUsers),
        deleteUser: vi.fn(async (...args: unknown[]) => {
          deleteUserSpy(...args);
          return { error: null };
        }),
      },
    },
    from: vi.fn(svcFromImpl),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

const CALLER_UUID = "11111111-1111-4000-8000-000000000001";
const ORG_A = "aaaaaaaa-aaaa-4000-8000-000000000001";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/users/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  inviteUserByEmailSpy.mockReset();
  rpcSpy.mockReset();
  deleteUserSpy.mockReset();
  mockListUsers = { data: { users: [] }, error: null };
  mockTargetRoles = [];
  mockTargetProfile = null;
  mockTargetProfileError = null;
  mockCaller = { id: CALLER_UUID, email: "caller@example.com" };
  mockRpcResult = { error: null };
  mockInviteResult = {
    data: { user: { id: "00000000-0000-4000-8000-000000000099" } },
    error: null,
  };
});

// ── Tests ────────────────────────────────────────────────────────────

describe("POST /api/users/invite", () => {
  // ── Happy path: super_admin caller, org_manager invitee ──────────
  it("super_admin invites an org_manager → 201 + data payload forwarded", async () => {
    mockCallerRoles = [
      { role: "super_admin", scope_type: null, scope_id: null },
    ];

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "newuser@example.com",
        first_name: "New",
        last_name: "User",
        role: "org_manager",
        scope_id: ORG_A,
      })
    );

    expect(res.status).toBe(201);
    expect(inviteUserByEmailSpy).toHaveBeenCalledTimes(1);
    const [emailArg, optsArg] = inviteUserByEmailSpy.mock.calls[0]!;
    expect(emailArg).toBe("newuser@example.com");
    expect(optsArg).toMatchObject({
      data: {
        invited_by_name: "Inviter Name",
        org_name: "Test Org",
        role_label: "an organization manager",
        app_name: "Metering & Billing Engine",
      },
      // UX5c / #189 — per-call redirectTo lands invitees on the
      // /accept-invite page where verifyOtp + set-password runs.
      redirectTo: "http://localhost/accept-invite",
    });
  });

  // ── Happy path: super_admin caller, super_admin invitee ───────────
  it("super_admin invites a super_admin → 201 + data payload omits org_name", async () => {
    mockCallerRoles = [
      { role: "super_admin", scope_type: null, scope_id: null },
    ];

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "peer-admin@example.com",
        role: "super_admin",
      })
    );

    expect(res.status).toBe(201);
    expect(inviteUserByEmailSpy).toHaveBeenCalledTimes(1);
    const [, optsArg] = inviteUserByEmailSpy.mock.calls[0]!;
    const payload = (optsArg as { data: Record<string, unknown> }).data;
    expect(payload.role_label).toBe("a super administrator");
    expect(payload.app_name).toBe("Metering & Billing Engine");
    // org_name MUST be omitted for super_admin invites (Go template
    // `{{ if .Data.org_name }}` semantics).
    expect("org_name" in payload).toBe(false);
  });

  // ── Happy path: org_manager caller, org_manager invitee ───────────
  it("org_manager invites an org_manager into their own org → 201", async () => {
    mockCallerRoles = [
      { role: "org_manager", scope_type: "org", scope_id: ORG_A },
    ];

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "new-org-mgr@example.com",
        role: "org_manager",
        scope_id: ORG_A,
      })
    );

    expect(res.status).toBe(201);
    const [, optsArg] = inviteUserByEmailSpy.mock.calls[0]!;
    const payload = (optsArg as { data: Record<string, unknown> }).data;
    expect(payload.org_name).toBe("Test Org");
    expect(payload.role_label).toBe("an organization manager");
  });

  // ── 422: validation — invalid email ──────────────────────────────
  it("returns 422 on invalid email", async () => {
    mockCallerRoles = [
      { role: "super_admin", scope_type: null, scope_id: null },
    ];

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "not-an-email",
        role: "org_manager",
        scope_id: ORG_A,
      })
    );

    expect(res.status).toBe(422);
    expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
  });

  // ── 403: org_manager attempting super_admin invite ───────────────
  it("returns 403 when org_manager attempts super_admin invite", async () => {
    mockCallerRoles = [
      { role: "org_manager", scope_type: "org", scope_id: ORG_A },
    ];

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "would-be-admin@example.com",
        role: "super_admin",
      })
    );

    expect(res.status).toBe(403);
    expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
  });

  // ── Existing accounts (looked up before inviting) ────────────────
  describe("when the email already has an account", () => {
    const EXISTING_ID = "22222222-2222-4000-8000-000000000002";
    const ORG_B = "bbbbbbbb-bbbb-4000-8000-000000000002";

    function existingAccount(confirmed: boolean) {
      mockListUsers = {
        data: {
          users: [
            {
              id: EXISTING_ID,
              email: "Member@Example.com",
              email_confirmed_at: confirmed ? "2026-10-06T08:00:00Z" : null,
            },
          ],
        },
        error: null,
      };
    }

    beforeEach(() => {
      mockCallerRoles = [
        { role: "org_manager", scope_type: "org", scope_id: ORG_A },
      ];
    });

    it("says the person already has access when they hold the requested role in this org", async () => {
      existingAccount(true);
      mockTargetRoles = [
        { role: "org_manager", scope_type: "org", scope_id: ORG_B },
        { role: "org_manager", scope_type: "org", scope_id: ORG_A },
      ];

      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          email: "member@example.com",
          role: "org_manager",
          scope_id: ORG_A,
        })
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ code: "already_member", field: "email" });
      expect(body.error).toBe(
        "member@example.com already has access to this organization."
      );
      expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
      expect(rpcSpy).not.toHaveBeenCalled();
      expect(deleteUserSpy).not.toHaveBeenCalled();
    });

    it("refuses with a role-change hint when the account holds other access", async () => {
      existingAccount(true);
      mockTargetRoles = [
        { role: "super_admin", scope_type: "org", scope_id: null },
      ];

      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          email: "member@example.com",
          role: "org_manager",
          scope_id: ORG_A,
        })
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("other_access");
      expect(body.error).toContain("different role");
      expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
      expect(rpcSpy).not.toHaveBeenCalled();
    });

    it("restores access for a confirmed account with no roles, without an email, keeping its profile", async () => {
      existingAccount(true);
      mockTargetRoles = [];
      mockTargetProfile = { first_name: "Kept", last_name: "Name", phone: null };

      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          email: "member@example.com",
          first_name: "Typed",
          last_name: "",
          phone: "+256700000000",
          role: "org_manager",
          scope_id: ORG_A,
        })
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        user_id: EXISTING_ID,
        existing_account: true,
        email_sent: false,
      });
      expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
      expect(rpcSpy).toHaveBeenCalledWith("fn_finalize_user_invitation", {
        p_user_id: EXISTING_ID,
        p_first_name: "Kept",
        p_last_name: "Name",
        p_phone: "+256700000000",
        p_role: "org_manager",
        p_scope_id: ORG_A,
      });
    });

    it("re-sends the invitation to an unconfirmed account with no roles", async () => {
      existingAccount(false);
      mockTargetRoles = [];
      mockTargetProfile = { first_name: null, last_name: null, phone: null };

      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          email: "member@example.com",
          first_name: "New",
          last_name: "Person",
          role: "org_manager",
          scope_id: ORG_A,
        })
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        existing_account: true,
        email_sent: true,
      });
      expect(inviteUserByEmailSpy).toHaveBeenCalledTimes(1);
      expect(rpcSpy.mock.calls[0]![1]).toMatchObject({
        p_user_id: EXISTING_ID,
        p_first_name: "New",
        p_last_name: "Person",
      });
    });

    it("stops without changing the account when its profile cannot be read", async () => {
      existingAccount(true);
      mockTargetRoles = [];
      mockTargetProfileError = { message: "canceling statement due to statement timeout" };

      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          email: "member@example.com",
          first_name: "Typed",
          role: "org_manager",
          scope_id: ORG_A,
        })
      );

      expect(res.status).toBe(500);
      expect(rpcSpy).not.toHaveBeenCalled();
      expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
      expect(deleteUserSpy).not.toHaveBeenCalled();
    });

    it("leaves an account that existed before the request in place when finalizing fails", async () => {
      existingAccount(true);
      mockTargetRoles = [];
      mockRpcResult = { error: { code: "42501", message: "denied" } };

      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          email: "member@example.com",
          role: "org_manager",
          scope_id: ORG_A,
        })
      );

      expect(res.status).toBe(403);
      expect(deleteUserSpy).not.toHaveBeenCalled();
    });
  });

  it("removes the account it just created when finalizing fails", async () => {
    mockCallerRoles = [
      { role: "org_manager", scope_type: "org", scope_id: ORG_A },
    ];
    mockRpcResult = { error: { code: "42501", message: "denied" } };

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "brand-new@example.com",
        role: "org_manager",
        scope_id: ORG_A,
      })
    );

    expect(res.status).toBe(403);
    expect(deleteUserSpy).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099"
    );
  });

  it("returns 500 without inviting when the account lookup fails", async () => {
    mockCallerRoles = [
      { role: "org_manager", scope_type: "org", scope_id: ORG_A },
    ];
    mockListUsers = { data: null, error: { message: "boom" } };

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "someone@example.com",
        role: "org_manager",
        scope_id: ORG_A,
      })
    );

    expect(res.status).toBe(500);
    expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
  });

  it("reports a new account as invited with an email", async () => {
    mockCallerRoles = [
      { role: "org_manager", scope_type: "org", scope_id: ORG_A },
    ];

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        email: "brand-new@example.com",
        role: "org_manager",
        scope_id: ORG_A,
      })
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      user_id: "00000000-0000-4000-8000-000000000099",
      existing_account: false,
      email_sent: true,
    });
  });
});
