/**
 * POST /api/users/invite — route handler tests (UX5b / #184).
 *
 * Covers the happy paths, the account cases, and the invitation notice
 * (RFC #186 § 5): the account is created with no password and Supabase
 * sends nothing; MGM sends a token-free notice once the access is saved.
 *
 * Mocks: Supabase user-bound + service-role clients, including the
 * fn_finalize_user_invitation RPC, and sendNotice.
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
let mockCreateResult: {
  data: { user: { id: string } | null };
  error: { code?: string; message: string } | null;
} = {
  data: { user: { id: "00000000-0000-4000-8000-000000000099" } },
  error: null,
};

const createUserSpy = vi.fn();
const sendNoticeSpy = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/notices", () => ({
  sendNotice: (...args: unknown[]) => sendNoticeSpy(...args),
}));
vi.mock("@/lib/runtime/root", () => ({
  getMgmRuntime: async () => ({ mailTransports: { registry: true } }),
}));
const rpcSpy = vi.fn();
const deleteUserSpy = vi.fn();

// Service-role view of existing accounts (step 2 of the route).
let mockListUsers: {
  data: { users: Array<{ id: string; email: string; email_confirmed_at: string | null }> } | null;
  error: { message: string } | null;
} = { data: { users: [] }, error: null };
let mockTargetRoles: Array<{
  role: "super_admin" | "org_manager" | "tenant";
  scope_type: "org" | "tenant";
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

// The tables each request reads through the caller's own client, in order.
const userClientTablesSpy = vi.fn();

function userClientFromImpl(table: string) {
  userClientTablesSpy(table);
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
        createUser: vi.fn(async (...args: unknown[]) => {
          createUserSpy(...args);
          return mockCreateResult;
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
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.org");
  sendNoticeSpy.mockReset();
  sendNoticeSpy.mockResolvedValue({ ok: true, via: "organization" });
  createUserSpy.mockReset();
  rpcSpy.mockReset();
  deleteUserSpy.mockReset();
  mockListUsers = { data: { users: [] }, error: null };
  mockTargetRoles = [];
  mockTargetProfile = null;
  mockTargetProfileError = null;
  mockCaller = { id: CALLER_UUID, email: "caller@example.com" };
  mockRpcResult = { error: null };
  mockCreateResult = {
    data: { user: { id: "00000000-0000-4000-8000-000000000099" } },
    error: null,
  };
});

// ── Tests ────────────────────────────────────────────────────────────

describe("POST /api/users/invite", () => {
  // ── Happy path: super_admin caller, org_manager invitee ──────────
  it("super_admin invites an org_manager → 201, an account with no password, and a notice after the access is saved", async () => {
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
    expect(createUserSpy).toHaveBeenCalledTimes(1);
    expect(createUserSpy.mock.calls[0]![0]).toEqual({
      email: "newuser@example.com",
      email_confirm: false,
      user_metadata: {
        invited_by_name: "Inviter Name",
        org_name: "Test Org",
        role_label: "an organization manager",
        app_name: "Metering & Billing Engine",
      },
    });
    expect(createUserSpy.mock.calls[0]![0]).not.toHaveProperty("password");

    // The notice goes through the invited organization's sender, after
    // the access is saved, and carries no token.
    expect(sendNoticeSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy.mock.invocationCallOrder[0]).toBeLessThan(sendNoticeSpy.mock.invocationCallOrder[0]);
    const notice = sendNoticeSpy.mock.calls[0]![0] as { orgId: string | null; message: { to: string; subject: string; text: string } };
    expect(notice.orgId).toBe(ORG_A);
    expect(notice.message.to).toBe("newuser@example.com");
    expect(notice.message.subject).toBe("You have access to Test Org in MGM");
    expect(notice.message.text).toContain("Inviter Name gave you access to Test Org in MGM");
    expect(notice.message.text).toContain("https://mgm.example.org/login");
    expect(notice.message.text).not.toMatch(/token|confirm\?|accept-invite/i);
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
    expect(createUserSpy).toHaveBeenCalledTimes(1);
    const payload = (createUserSpy.mock.calls[0]![0] as { user_metadata: Record<string, unknown> }).user_metadata;
    expect(payload.role_label).toBe("a super administrator");
    expect(payload.app_name).toBe("Metering & Billing Engine");
    // org_name is omitted for super_admin invites.
    expect("org_name" in payload).toBe(false);
    // No organization: the notice goes through the deployment's sender.
    expect((sendNoticeSpy.mock.calls[0]![0] as { orgId: string | null }).orgId).toBeNull();
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
    const payload = (createUserSpy.mock.calls[0]![0] as { user_metadata: Record<string, unknown> }).user_metadata;
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
    expect(createUserSpy).not.toHaveBeenCalled();
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
    expect(createUserSpy).not.toHaveBeenCalled();
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
      expect(createUserSpy).not.toHaveBeenCalled();
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
      expect(createUserSpy).not.toHaveBeenCalled();
      expect(rpcSpy).not.toHaveBeenCalled();
    });

    it("restores access for a confirmed account with no roles, sends the notice, and keeps its profile", async () => {
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
        email_sent: true,
      });
      expect(createUserSpy).not.toHaveBeenCalled();
      expect(sendNoticeSpy).toHaveBeenCalledTimes(1);
      expect(rpcSpy).toHaveBeenCalledWith("fn_finalize_user_invitation", {
        p_user_id: EXISTING_ID,
        p_first_name: "Kept",
        p_last_name: "Name",
        p_phone: "+256700000000",
        p_role: "org_manager",
        p_scope_id: ORG_A,
      });
    });

    it("sends the notice again to an unconfirmed account with no roles, without creating one", async () => {
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
      expect(createUserSpy).not.toHaveBeenCalled();
      expect(sendNoticeSpy).toHaveBeenCalledTimes(1);
      expect(rpcSpy.mock.calls[0]![1]).toMatchObject({
        p_user_id: EXISTING_ID,
        p_first_name: "New",
        p_last_name: "Person",
      });
    });

    // RFC mgm#197: a tenant row is a person's access to the unit they rent,
    // not staff access. Making a tenant staff is a role change, which only a
    // super admin makes here, through fn_change_user_role; anyone else gets
    // the answer for an account that holds other access, and nothing is
    // written. fn_finalize_user_invitation is never called for an account
    // that holds any row.
    describe("that holds tenant rows", () => {
      const UNIT = "cccccccc-cccc-4000-8000-000000000003";
      const UNIT_2 = "cccccccc-cccc-4000-8000-000000000004";
      const tenantRow = { role: "tenant" as const, scope_type: "tenant" as const, scope_id: UNIT };
      const superAdminCaller = [{ role: "super_admin" as const, scope_type: "org" as const, scope_id: null }];

      async function invite(body: Record<string, unknown> = { role: "org_manager", scope_id: ORG_A }) {
        const { POST } = await import("../route");
        const res = await POST(makeRequest({ email: "member@example.com", first_name: "New", phone: "+256700000001", ...body }));
        return { status: res.status, body: await res.json() };
      }

      const rpcNames = () => rpcSpy.mock.calls.map((call) => call[0]);

      it("gives a super admin's requested role through fn_change_user_role, keeps the profile and sends the notice", async () => {
        existingAccount(true);
        mockCallerRoles = superAdminCaller;
        mockTargetRoles = [tenantRow, { ...tenantRow, scope_id: UNIT_2 }];
        mockTargetProfile = { first_name: null, last_name: null, phone: null };

        expect(await invite()).toEqual({
          status: 201,
          body: { user_id: EXISTING_ID, existing_account: true, email_sent: true },
        });
        // Called as PATCH /api/users/[id]/role calls it. The service client
        // this route holds reads user_roles and user_profiles only
        // (svcFromImpl), so the tenant rows and the profile stay as they are.
        expect(rpcSpy.mock.calls).toEqual([
          ["fn_change_user_role", { p_user_id: EXISTING_ID, p_role: "org_manager", p_scope_id: ORG_A }],
        ]);
        expect(rpcNames()).not.toContain("fn_finalize_user_invitation");
        expect(createUserSpy).not.toHaveBeenCalled();
        expect(deleteUserSpy).not.toHaveBeenCalled();
        // The notice an existing account gets, after the role is saved.
        expect(sendNoticeSpy).toHaveBeenCalledTimes(1);
        expect(rpcSpy.mock.invocationCallOrder[0]).toBeLessThan(sendNoticeSpy.mock.invocationCallOrder[0]);
        const notice = sendNoticeSpy.mock.calls[0]![0] as { orgId: string | null; message: { to: string; subject: string } };
        expect(notice.orgId).toBe(ORG_A);
        expect(notice.message.to).toBe("member@example.com");
        expect(notice.message.subject).toBe("You have access to Test Org in MGM");
      });

      it("makes a tenant a super admin with a null scope, through the deployment's sender", async () => {
        existingAccount(true);
        mockCallerRoles = superAdminCaller;
        mockTargetRoles = [tenantRow];

        expect(await invite({ role: "super_admin" })).toMatchObject({ status: 201, body: { existing_account: true } });
        expect(rpcSpy.mock.calls).toEqual([
          ["fn_change_user_role", { p_user_id: EXISTING_ID, p_role: "super_admin", p_scope_id: undefined }],
        ]);
        expect((sendNoticeSpy.mock.calls[0]![0] as { orgId: string | null }).orgId).toBeNull();
      });

      it.each([
        ["42501", 403],
        ["22023", 422],
        ["40000", 409],
        ["XX000", 500],
      ])("maps fn_change_user_role's %s to %i, as PATCH /api/users/[id]/role does, and sends nothing", async (code, status) => {
        existingAccount(true);
        mockCallerRoles = superAdminCaller;
        mockTargetRoles = [tenantRow];
        mockRpcResult = { error: { code, message: "refused" } };

        expect(await invite()).toEqual({ status, body: { error: "Invite failed: refused" } });
        expect(rpcNames()).toEqual(["fn_change_user_role"]);
        expect(sendNoticeSpy).not.toHaveBeenCalled();
        expect(deleteUserSpy).not.toHaveBeenCalled();
      });

      it("answers an org manager exactly as for an account that holds other access, and writes nothing", async () => {
        existingAccount(true);
        mockTargetRoles = [{ role: "super_admin", scope_type: "org", scope_id: null }];
        userClientTablesSpy.mockClear();
        const otherAccess = await invite();
        const otherAccessReads = userClientTablesSpy.mock.calls.map((call) => call[0]);

        mockTargetRoles = [tenantRow];
        userClientTablesSpy.mockClear();
        const tenantOnly = await invite();
        const tenantOnlyReads = userClientTablesSpy.mock.calls.map((call) => call[0]);

        expect(tenantOnly).toEqual(otherAccess);
        // The same reads on the caller's client, the caller's own roles
        // among them, whichever rows the address holds.
        expect(tenantOnlyReads).toEqual(otherAccessReads);
        expect(tenantOnlyReads).toContain("user_roles");
        expect(tenantOnly).toEqual({
          status: 409,
          body: {
            error:
              "member@example.com already has an MGM account with a different role. " +
              "A super admin can change it from the Users list.",
            field: "email",
            code: "other_access",
          },
        });
        expect(rpcSpy).not.toHaveBeenCalled();
        expect(sendNoticeSpy).not.toHaveBeenCalled();
        expect(createUserSpy).not.toHaveBeenCalled();
        expect(deleteUserSpy).not.toHaveBeenCalled();
      });

      it("finalizes an account with no rows as before, for either caller", async () => {
        existingAccount(true);
        mockTargetProfile = { first_name: null, last_name: null, phone: null };
        for (const caller of [superAdminCaller, [{ role: "org_manager" as const, scope_type: "org" as const, scope_id: ORG_A }]]) {
          mockCallerRoles = caller;
          rpcSpy.mockClear();
          mockTargetRoles = [];
          expect(await invite()).toMatchObject({ status: 201, body: { existing_account: true } });
          expect(rpcNames()).toEqual(["fn_finalize_user_invitation"]);
        }
      });

      it.each([
        { caller: "a super admin", roles: [{ role: "super_admin" as const, scope_type: "org" as const, scope_id: null }] },
        { caller: "an org manager", roles: [{ role: "org_manager" as const, scope_type: "org" as const, scope_id: ORG_A }] },
      ])("still refuses $caller with the role-change hint when the account also holds other staff access", async ({ roles }) => {
        existingAccount(true);
        mockCallerRoles = roles;
        mockTargetRoles = [tenantRow, { role: "org_manager", scope_type: "org", scope_id: ORG_B }];
        expect(await invite()).toMatchObject({ status: 409, body: { code: "other_access" } });
        expect(rpcSpy).not.toHaveBeenCalled();
      });

      it("still says the person already has access when they also hold the requested role", async () => {
        existingAccount(true);
        mockTargetRoles = [tenantRow, { role: "org_manager", scope_type: "org", scope_id: ORG_A }];
        expect(await invite()).toMatchObject({ status: 409, body: { code: "already_member" } });
        expect(rpcSpy).not.toHaveBeenCalled();
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
      expect(createUserSpy).not.toHaveBeenCalled();
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
      expect(sendNoticeSpy).not.toHaveBeenCalled();
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
    expect(sendNoticeSpy).not.toHaveBeenCalled();
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
    expect(createUserSpy).not.toHaveBeenCalled();
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

  it("keeps the access and reports email_sent: false when the notice cannot be sent", async () => {
    mockCallerRoles = [
      { role: "org_manager", scope_type: "org", scope_id: ORG_A },
    ];
    sendNoticeSpy.mockResolvedValue({ ok: false, reason: "not_configured" });

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({ email: "brand-new@example.com", role: "org_manager", scope_id: ORG_A })
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ existing_account: false, email_sent: false });
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });
});
