/**
 * POST /api/users/[id]/resend-invite — route handler unit tests
 * (UX5b / #184).
 *
 * Mocks Supabase user-bound + service clients. Covers (mirroring AC1
 * Steps A→G):
 *   - 200: happy path (super_admin → org_manager target).
 *   - 401: no caller session.
 *   - 403: org_manager → super_admin target.
 *   - 403: org_manager → cross-org org_manager target.
 *   - 403: org_manager → orphan target (no role row).
 *   - 404: target not found in auth.users (lookup AFTER permission has passed).
 *   - 404 with no notice: super_admin → an account the RPC lists for no
 *     one, such as a tenant's (RFC mgm#197); 403 for anyone else.
 *   - 500: the visibility RPC failed; never read as no row (so never the
 *     super admin's 404), for any caller.
 *   - 409: pre-check email_confirmed_at IS NOT NULL.
 *   - 429: more than 3 resends for one person in 10 minutes.
 *   - 429: the caller's invitations and resends together passed the
 *     per-inviter limit (invite-limit.ts), before the target is looked up;
 *     a refused caller is not counted.
 *   - 502: the notice could not be sent.
 *   - 200: the token-free invitation notice (RFC #186 § 5), through the
 *     target's organization's sender, or the deployment's.
 *   - Ordering: when permission would 403 AND target also doesn't
 *     exist, the route MUST 403 (permission-before-lookup).
 *   - 400: invalid UUID in path.
 *
 * The two-client pattern is mocked via vi.mock() with mutable handles
 * the tests reset in beforeEach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────

// Caller user (auth.getUser result).
let mockCaller: { id: string; email?: string } | null = null;

// Mock for the user-bound client `.rpc("fn_list_visible_users", {...})`
// (#269 replaced the prior `.from("user_directory").…maybeSingle()` call).
// Returns the target's CURRENT row (or null when invisible/absent). The
// route was migrated from `user_roles` → `user_directory` → `fn_list_visible_users`
// because `user_roles` RLS blocks org_manager → org_manager-in-same-org reads;
// the RPC's body filter (`user_can_see_user_profile(user_id)`) is the
// canonical visibility gate. A visible orphan surfaces as a row with
// NULL role/scope columns (LEFT JOIN miss on user_roles).
let mockTargetRoleRow: {
  role: "super_admin" | "org_manager" | "tenant" | null;
  scope_type: "org" | "tenant" | null;
  scope_id: string | null;
} | null = null;

// When set, the RPC fails: supabase-js answers `{ data: null, error }`.
let mockRpcError: { code?: string; message: string } | null = null;

// Roles for the caller (used by access.ts helpers via the same mock from()).
let mockCallerRoles: Array<{
  role: "super_admin" | "org_manager";
  scope_type: "org" | null;
  scope_id: string | null;
}> = [];

// Mock for service-client svc.auth.admin.getUserById
let mockGetUserByIdResult: {
  data: { user: { id: string; email: string; email_confirmed_at: string | null } | null };
  error: { code?: string; message: string } | null;
} = { data: { user: null }, error: { code: "user_not_found", message: "not found" } };

// Mock for service-client svc.auth.admin.inviteUserByEmail
let mockInviteResult: {
  data: { user: { id: string } | null };
  error: { code?: string; message: string } | null;
} = { data: { user: null }, error: null };

// Spy capturing the inviteUserByEmail args for shape assertions.
const inviteUserByEmailSpy = vi.fn();
// Spy recording whether the route looked the target up (Step D).
const getUserByIdSpy = vi.fn();

// User-bound client `.from('user_profiles')` and `.from('organizations')`
// chains used by buildInviteDataPayload — return permissive defaults.
function userClientFromImpl(table: string) {
  if (table === "user_profiles") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: vi.fn(async () => ({
            data: { first_name: "Test", last_name: "Caller" },
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
    // After the route migration, only access.ts's `getCurrentUserRoles`
    // (caller-roles fetch) reads user_roles via the user-bound client.
    // The chain is `select("*").eq("user_id", caller.id).returns()`.
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
    // `.rpc("fn_list_visible_users", { _target_user_ids: [targetId] })`
    // (#269: target lookup replaced .from("user_directory")…maybeSingle()).
    // The mock returns an array shaped like the RPC return type; the route
    // takes `data?.[0]`. A null `mockTargetRoleRow` → empty array → no row.
    rpc: vi.fn(async (name: string) => {
      if (name === "fn_list_visible_users") {
        if (mockRpcError) return { data: null, error: mockRpcError };
        return {
          data: mockTargetRoleRow
            ? [
                {
                  user_id: TARGET_UUID,
                  email: null,
                  email_confirmed_at: null,
                  last_sign_in_at: null,
                  first_name: null,
                  last_name: null,
                  phone: null,
                  role: mockTargetRoleRow.role,
                  scope_type: mockTargetRoleRow.scope_type,
                  scope_id: mockTargetRoleRow.scope_id,
                },
              ]
            : [],
          error: null,
        };
      }
      throw new Error(`Unexpected rpc: ${name}`);
    }),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockCaller },
        error: null,
      })),
    },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        getUserById: vi.fn(async (...args: unknown[]) => {
          getUserByIdSpy(...args);
          return mockGetUserByIdResult;
        }),
        inviteUserByEmail: vi.fn(async (...args: unknown[]) => {
          inviteUserByEmailSpy(...args);
          return mockInviteResult;
        }),
      },
    },
  }),
}));

const sendNoticeSpy = vi.fn();
const rateLimitSpy = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/notices", () => ({
  sendNotice: (...args: unknown[]) => sendNoticeSpy(...args),
}));
vi.mock("@/lib/runtime/root", () => ({
  getMgmRuntime: async () => ({ mailTransports: { registry: true } }),
}));
vi.mock("@/lib/rate-limit/in-memory", () => ({
  checkRateLimit: (...args: unknown[]) => rateLimitSpy(...args),
}));
// The per-inviter limit shared with POST /api/users/invite; its counting is
// tested in invite-limit.test.ts, so here only the call and its answer.
const invitationLimitSpy = vi.fn();
vi.mock("@/lib/organization-directory/invite-limit", () => ({
  checkInvitation: (...args: unknown[]) => invitationLimitSpy(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────

const CALLER_UUID = "11111111-1111-4000-8000-000000000001";
const TARGET_UUID = "22222222-2222-4000-8000-000000000002";
const ORG_A = "aaaaaaaa-aaaa-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-bbbb-4000-8000-000000000002";

function makeRequest(id: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/users/${id}/resend-invite`,
    { method: "POST" }
  );
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.org");
  sendNoticeSpy.mockReset();
  sendNoticeSpy.mockResolvedValue({ ok: true, via: "organization" });
  rateLimitSpy.mockReset();
  rateLimitSpy.mockReturnValue({ ok: true });
  invitationLimitSpy.mockReset();
  invitationLimitSpy.mockReturnValue({ ok: true });
  inviteUserByEmailSpy.mockReset();
  getUserByIdSpy.mockReset();
  mockCaller = { id: CALLER_UUID, email: "caller@example.com" };
  mockCallerRoles = [];
  mockTargetRoleRow = null;
  mockRpcError = null;
  mockGetUserByIdResult = {
    data: { user: null },
    error: { code: "user_not_found", message: "not found" },
  };
  mockInviteResult = { data: { user: { id: TARGET_UUID } }, error: null };
});

// ── Tests ────────────────────────────────────────────────────────────

describe("POST /api/users/[id]/resend-invite", () => {
  // ── 400: invalid UUID ─────────────────────────────────────────────
  it("returns 400 for a malformed UUID in the path", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest("not-a-uuid"), makeContext("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  // ── 400: a body that is not ResendInviteBody (org.resend-invite's input) ──
  it("takes no body or the GUI host's empty object, and refuses any field before the session is read", async () => {
    mockCaller = null;
    const { POST } = await import("../route");
    const withBody = (body: string) =>
      new NextRequest(`http://localhost/api/users/${TARGET_UUID}/resend-invite`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      });
    const refused = await POST(withBody(JSON.stringify({ email: "x@example.test" })), makeContext(TARGET_UUID));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Unknown field: email", code: "invalid_body" });
    expect((await POST(withBody("{"), makeContext(TARGET_UUID))).status).toBe(400);
    // `{}` passes the body check and reaches Step A, which finds no session here.
    expect((await POST(withBody("{}"), makeContext(TARGET_UUID))).status).toBe(401);
  });

  // ── 401: no session ──────────────────────────────────────────────
  it("returns 401 when no caller session is present", async () => {
    mockCaller = null;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/auth/i);
  });

  // ── 403: org_manager → super_admin target ───────────────────────
  it("returns 403 when org_manager attempts to resend a super_admin", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = { role: "super_admin", scope_type: null, scope_id: null };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── 403: org_manager → cross-org org_manager ────────────────────
  it("returns 403 when org_manager attempts to resend an org_manager scoped to a different org", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_B };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── 403: org_manager → orphan (no role row) ─────────────────────
  // Either the target genuinely has no role row, OR RLS hid it. Uniform 403.
  it("returns 403 when org_manager hits an orphan target (null role row)", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = null;

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── Permission-before-lookup ordering ──────────────────────────
  // A non-existent target combined with insufficient permission MUST 403,
  // not 404. This prevents an attacker from probing UUIDs via 404s.
  it("returns 403 (NOT 404) when target doesn't exist AND caller lacks permission", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = null; // target has no role row OR RLS-hidden
    // getUserById would return user_not_found if reached, but the route
    // MUST short-circuit on the permission failure before calling it.
    mockGetUserByIdResult = {
      data: { user: null },
      error: { code: "user_not_found", message: "not found" },
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── 404: missing auth user (only after permission has passed) ──
  // A row with no role (an orphan) takes a super_admin to the lookup; no row
  // at all is answered 404 before it (the tenant-only cases below).
  it("returns 404 when the target user does not exist in auth.users (super_admin caller)", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: null, scope_type: null, scope_id: null }; // orphan path, super_admin allowed
    mockGetUserByIdResult = {
      data: { user: null },
      error: { code: "user_not_found", message: "not found" },
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(404);
  });

  it("returns 404 when getUserById returns null user with no error code", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: null, scope_type: null, scope_id: null };
    mockGetUserByIdResult = { data: { user: null }, error: null };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(404);
  });

  // ── 500: the visibility RPC failed ─────────────────────────────
  // A failed call is not an empty result: a super admin must not be told
  // that a listed invitee does not exist, and nobody is told "no permission".
  it.each([
    ["a super admin", [{ role: "super_admin", scope_type: null, scope_id: null }]],
    ["an org manager", [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }]],
  ] as const)("returns 500, not 404 or 403, to %s when fn_list_visible_users fails", async (_who, roles) => {
    mockCallerRoles = roles.map((r) => ({ ...r }));
    mockRpcError = { code: "57014", message: "canceling statement due to statement timeout" };
    // Were the route to reach the lookup, the target would be a pending invitee.
    mockGetUserByIdResult = {
      data: { user: { id: TARGET_UUID, email: "target@example.com", email_confirmed_at: null } },
      error: null,
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { POST } = await import("../route");
      const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json).toEqual({ error: "Could not check the user's access. Please retry." });
      expect(json.error).not.toBe("User not found.");
      expect(getUserByIdSpy).not.toHaveBeenCalled();
      expect(sendNoticeSpy).not.toHaveBeenCalled();
      expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("resend_invite.visibility_error")
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  // ── 409: already accepted (pre-check) ──────────────────────────
  it("returns 409 when the target has already accepted (email_confirmed_at not null)", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: "2026-04-24T00:00:00Z",
        },
      },
      error: null,
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already accepted/i);
    expect(sendNoticeSpy).not.toHaveBeenCalled();
  });

  // ── 429: resend limit ───────────────────────────────────────────
  it("returns 429 with code: rate_limited past 3 resends for one person in 10 minutes", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    rateLimitSpy.mockReturnValue({ ok: false, retryAfter: 60 });

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("rate_limited");
    expect(json.error).toMatch(/try again/i);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(rateLimitSpy).toHaveBeenCalledWith(`resend-invite:${TARGET_UUID}`, 3, 600_000);
    expect(sendNoticeSpy).not.toHaveBeenCalled();
  });

  // ── 429: the per-inviter limit (invite-limit.ts) ─────────────────
  it("counts an authorized resend against the caller's invitation limit", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: { user: { id: TARGET_UUID, email: "target@example.com", email_confirmed_at: null } },
      error: null,
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(200);
    expect(invitationLimitSpy).toHaveBeenCalledTimes(1);
    expect(invitationLimitSpy).toHaveBeenCalledWith(CALLER_UUID);
  });

  it("returns 429 rate_limited with Retry-After past the per-inviter limit, before the target is looked up", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    invitationLimitSpy.mockReturnValue({ ok: false, retryAfter: 1800 });

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("rate_limited");
    expect(json.error).toMatch(/try again/i);
    expect(res.headers.get("Retry-After")).toBe("1800");
    expect(getUserByIdSpy).not.toHaveBeenCalled();
    expect(rateLimitSpy).not.toHaveBeenCalled();
    expect(sendNoticeSpy).not.toHaveBeenCalled();
  });

  it("does not count a caller the route refuses", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_B };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
    expect(invitationLimitSpy).not.toHaveBeenCalled();
  });

  // ── 502: the notice could not be sent ─────────────────────────────
  it("returns 502 when the notice cannot be sent", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    sendNoticeSpy.mockResolvedValue({ ok: false, reason: "not_configured" });

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not be sent/i);
  });

  // ── 200: happy path (super_admin → org_manager target) ────────
  it("returns 200 { resent: true } and sends the token-free notice through the target's organization", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(200);
    expect((await res.json()).resent).toBe(true);

    // Supabase sends nothing; MGM's notice names the organization and role.
    expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
    expect(sendNoticeSpy).toHaveBeenCalledTimes(1);
    const notice = sendNoticeSpy.mock.calls[0]![0] as { orgId: string | null; message: { to: string; subject: string; text: string } };
    expect(notice.orgId).toBe(ORG_A);
    expect(notice.message.to).toBe("target@example.com");
    expect(notice.message.subject).toBe("You have access to Test Org in MGM");
    expect(notice.message.text).toContain("as an organization manager");
    expect(notice.message.text).toContain("https://mgm.example.org/login");
  });

  // ── 200: org_manager resending an org_manager in their org ──────
  it("allows org_manager to resend an org_manager in their org", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "peer@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    mockInviteResult = {
      data: { user: { id: TARGET_UUID } },
      error: null,
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(200);
  });

  // ── Tenant access is not staff access (RFC mgm#197) ──────────────
  // The RPC leaves out, for any caller (no row), anyone who holds tenant
  // rows and no staff row now, whatever they held before (a tenant once made
  // org manager and then removed included), and a former tenant with no rows
  // who was never staff. Its role columns never hold a tenant role; were
  // they to, the route reads that as no row.
  // Either way the account is answered as one that does not exist, with no
  // notice, so nothing tells the caller it is a tenant's and no tenant is
  // sent a staff invitation.
  describe("a tenant-only account", () => {
    const UNIT = "cccccccc-cccc-4000-8000-000000000003";
    const TENANT_ROWS = [
      ["the RPC leaves it out", null],
      ["a tenant role in the RPC's role columns", { role: "tenant", scope_type: "tenant", scope_id: UNIT }],
    ] as const;

    async function answer() {
      const { POST } = await import("../route");
      const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
      return { status: res.status, body: await res.json() };
    }

    // An account that does not exist: no row, and no auth user.
    async function unknown() {
      mockTargetRoleRow = null;
      mockGetUserByIdResult = { data: { user: null }, error: { code: "user_not_found", message: "not found" } };
      return answer();
    }

    // The tenant's account exists and has not signed in yet, as tenant
    // accounts the access route creates are until their first sign-in.
    function tenantAccount(row: (typeof TENANT_ROWS)[number][1]) {
      mockTargetRoleRow = row === null ? null : { ...row };
      mockGetUserByIdResult = {
        data: { user: { id: TARGET_UUID, email: "tenant@example.com", email_confirmed_at: null } },
        error: null,
      };
    }

    it.each(TENANT_ROWS)("refuses an org manager as for an unknown account (%s)", async (_, row) => {
      mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
      const none = await unknown();
      tenantAccount(row);
      expect(await answer()).toEqual(none);
      expect(none.status).toBe(403);
      expect(sendNoticeSpy).not.toHaveBeenCalled();
    });

    it.each(TENANT_ROWS)("answers a super admin as for an unknown account and sends no notice (%s)", async (_, row) => {
      mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
      const none = await unknown();
      expect(none).toEqual({ status: 404, body: { error: "User not found." } });
      tenantAccount(row);
      expect(await answer()).toEqual(none);
      expect(sendNoticeSpy).not.toHaveBeenCalled();
      expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
    });

    it("still resends to a staff orphan a super admin can see (a row with no role)", async () => {
      mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
      mockTargetRoleRow = { role: null, scope_type: null, scope_id: null };
      mockGetUserByIdResult = {
        data: { user: { id: TARGET_UUID, email: "orphan@example.com", email_confirmed_at: null } },
        error: null,
      };
      expect(await answer()).toEqual({ status: 200, body: { resent: true } });
      expect(sendNoticeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
