/**
 * POST /api/tenants/[id]/access — route tests (RFC mgm#197 § 6).
 *
 * The caller's client, the service client, the role rows, the plugin state
 * and sendNotice are mocked; composeCommunityManagement runs for real on
 * them, as in ../../__tests__/route.test.ts. Every call the route makes on
 * either client is recorded in order, so a test can say what ran before
 * what, and that nothing privileged ran at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { NextRequest } from "next/server";

// ── State ─────────────────────────────────────────────────────────────────

const TENANT_ID = "7e550000-0000-4000-8005-000000000001";
const MG_ID = "7e550000-0000-4000-8002-000000000001";
const ORG_ID = "7e550000-0000-4000-8000-000000000001";
const MANAGER_ID = "7e550000-0000-4000-8009-000000000001";
const OTHER_MANAGER_ID = "7e550000-0000-4000-8009-000000000002";
const EXISTING_ID = "7e550000-0000-4000-8009-000000000010";
const NEW_ID = "7e550000-0000-4000-8009-000000000011";
const ACCESS_ID = "7e550000-0000-4000-8008-000000000001";

type Role = { role: string; scope_type: string; scope_id: string | null };
type PgError = { code?: string; message: string };

let currentUser: { id: string } | null;
let roleRows: Role[];
let plugins: Record<string, boolean | "throw">;
let tenantRow: { id: string; microgrid_id: string } | null;
let microgridRow: { id: string; communities: { org_id: string } } | null;
let listResult: { data: { access_id: string; email: string; created_at: string }[] | null; error: PgError | null };
let authUsers: { id: string; email: string }[];
let listUsersError: { message: string } | null;
let createResult: { data: { user: { id: string } | null }; error: PgError | null };
/** Accounts that appear in the Auth list once createUser has run (the email_exists race). */
let appearAfterCreate: { id: string; email: string }[];
let grantResult: { data: string | null; error: PgError | null };
let noticeResult: { ok: true; via: string } | { ok: false; reason: string } | "throw";

const events: string[] = [];
const createServiceSpy = vi.fn();
const listUsersSpy = vi.fn();
const createUserSpy = vi.fn();
const deleteUserSpy = vi.fn();
const userRpcSpy = vi.fn();
const svcRpcSpy = vi.fn();
const sendNoticeSpy = vi.fn();
const sharedLimiterSpy = vi.fn();

// ── Mocks ─────────────────────────────────────────────────────────────────

function maybeSingleOf<T>(read: () => T) {
  return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: read(), error: null }) }) }) };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      events.push(`user:${table}`);
      if (table === "tenants") return maybeSingleOf(() => tenantRow);
      if (table === "microgrids") return maybeSingleOf(() => microgridRow);
      if (table === "organizations") return maybeSingleOf(() => ({ name: "Lakeside Power" }));
      throw new Error(`Unexpected table on the caller's client: ${table}`);
    },
    rpc: async (fn: string, args: unknown) => {
      events.push(`user:rpc:${fn}`);
      userRpcSpy(fn, args);
      if (fn === "fn_tenant_access_list") return listResult;
      throw new Error(`Unexpected RPC on the caller's client: ${fn}`);
    },
    auth: { getUser: async () => ({ data: { user: currentUser }, error: null }) },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    events.push("service:create");
    createServiceSpy();
    let created = false;
    return {
      auth: {
        admin: {
          listUsers: async (args: unknown) => {
            events.push("service:listUsers");
            listUsersSpy(args);
            if (listUsersError) return { data: null, error: listUsersError };
            return { data: { users: created ? [...authUsers, ...appearAfterCreate] : authUsers }, error: null };
          },
          createUser: async (args: unknown) => {
            events.push("service:createUser");
            createUserSpy(args);
            created = true;
            return createResult;
          },
          deleteUser: async (id: string) => {
            events.push("service:deleteUser");
            deleteUserSpy(id);
            return { data: {}, error: null };
          },
        },
      },
      rpc: async (fn: string, args: unknown) => {
        events.push(`service:rpc:${fn}`);
        svcRpcSpy(fn, args);
        if (fn === "fn_tenant_access_grant") return grantResult;
        throw new Error(`Unexpected RPC on the service client: ${fn}`);
      },
      from: (table: string) => {
        throw new Error(`Unexpected table on the service client: ${table}`);
      },
    };
  },
}));

vi.mock("@/lib/auth/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/access")>()),
  getCurrentUserRoles: async () => roleRows,
}));

vi.mock("@/lib/plugins/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugins/state")>()),
  isPluginEnabledForOrg: async (_client: unknown, _org: string, name: string) => {
    const state = plugins[name] ?? true;
    if (state === "throw") throw new Error("plugin state unavailable");
    return state;
  },
}));

vi.mock("@/lib/email/notices", () => ({
  sendNotice: async (input: unknown) => {
    events.push("notice");
    sendNoticeSpy(input);
    if (noticeResult === "throw") throw new Error("smtp down");
    return noticeResult;
  },
}));

vi.mock("@/lib/rate-limit/in-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/in-memory")>()),
  checkRateLimit: (...args: unknown[]) => {
    sharedLimiterSpy(...args);
    return { ok: true };
  },
}));

import { POST } from "../route";
import { _resetTenantAccessLimiterForTests } from "@/lib/community-management/tenant-access-limit";

// ── Helpers ───────────────────────────────────────────────────────────────

function post(body: unknown, id = TENANT_ID) {
  return POST(
    new NextRequest(`http://localhost/api/tenants/${id}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function call(body: unknown = { email: "renter@example.test" }, id = TENANT_ID) {
  const res = await post(body, id);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const managerOf = (orgId: string): Role => ({ role: "org_manager", scope_type: "org", scope_id: orgId });

beforeEach(() => {
  events.length = 0;
  vi.clearAllMocks();
  _resetTenantAccessLimiterForTests();
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.test");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  currentUser = { id: MANAGER_ID };
  roleRows = [managerOf(ORG_ID)];
  plugins = { "community-management": true, "tenant-app": true };
  tenantRow = { id: TENANT_ID, microgrid_id: MG_ID };
  microgridRow = { id: MG_ID, communities: { org_id: ORG_ID } };
  listResult = { data: [], error: null };
  authUsers = [];
  listUsersError = null;
  createResult = { data: { user: { id: NEW_ID } }, error: null };
  appearAfterCreate = [];
  grantResult = { data: ACCESS_ID, error: null };
  noticeResult = { ok: true, via: "organization" };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PRIVILEGED = /^(?:service:|notice$)/;

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/tenants/[id]/access: input", () => {
  it("refuses a tenant id that is not a UUID", async () => {
    const out = await call(undefined, "not-a-uuid");
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "Invalid tenant ID — expected UUID" });
    expect(events).toEqual([]);
  });

  it.each([
    ["no body", "not json", "Invalid JSON body", undefined],
    ["no address", {}, "Enter a valid email address.", "email"],
    ["an address that is not one", { email: "renter" }, "Enter a valid email address.", "email"],
    ["an over-long address", { email: `${"a".repeat(250)}@example.test` }, "Enter a valid email address.", "email"],
    ["an account id", { email: "renter@example.test", user_id: EXISTING_ID }, "Unknown field: user_id", undefined],
  ])("refuses %s with 400 before any read", async (_name, body, error, field) => {
    const out = await call(body);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error, code: "invalid_body", ...(field ? { field } : {}) });
    expect(events).toEqual([]);
  });

  it("trims and lowercases the address before using it", async () => {
    const out = await call({ email: "  Renter@Example.TEST " });
    expect(out.status).toBe(201);
    expect(out.body.email).toBe("renter@example.test");
    expect(createUserSpy).toHaveBeenCalledWith({ email: "renter@example.test", email_confirm: false });
  });
});

describe("POST /api/tenants/[id]/access: who may give access", () => {
  it("answers 404 for a unit the caller cannot read, with nothing privileged", async () => {
    tenantRow = null;
    const out = await call();
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "Tenant not found", code: "tenant_not_found" });
    expect(createServiceSpy).not.toHaveBeenCalled();
  });

  it("refuses a tenant-only caller, who reads their unit but not its microgrid, with nothing privileged", async () => {
    currentUser = { id: "7e550000-0000-4000-8009-000000000099" };
    roleRows = [{ role: "tenant", scope_type: "tenant", scope_id: TENANT_ID }];
    microgridRow = null;
    const out = await call();
    expect(out.status).toBe(403);
    expect(out.body).toEqual({
      error: "You do not have permission to manage access to this unit.",
      code: "forbidden",
      reason: "forbidden",
    });
    expect(events.filter((e) => PRIVILEGED.test(e))).toEqual([]);
  });

  it("refuses a tenant-only caller even where the microgrid read answers, through the composer", async () => {
    roleRows = [{ role: "tenant", scope_type: "tenant", scope_id: TENANT_ID }];
    const out = await call();
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("community_forbidden");
    expect(events.filter((e) => PRIVILEGED.test(e))).toEqual([]);
  });

  it("refuses another organization's manager through the composer", async () => {
    roleRows = [managerOf("7e550000-0000-4000-8000-000000000002")];
    const out = await call();
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("community_forbidden");
    expect(createServiceSpy).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    currentUser = null;
    const out = await call();
    expect(out.status).toBe(401);
    expect(createServiceSpy).not.toHaveBeenCalled();
  });

  it("answers 409 while community management is off for the organization", async () => {
    plugins["community-management"] = false;
    const out = await call();
    expect(out.status).toBe(409);
    expect(out.body.code).toBe("community_management_disabled");
    expect(createServiceSpy).not.toHaveBeenCalled();
  });

  it("lets a super admin give access, with their own id as the actor", async () => {
    currentUser = { id: OTHER_MANAGER_ID };
    roleRows = [{ role: "super_admin", scope_type: "org", scope_id: null }];
    const out = await call();
    expect(out.status).toBe(201);
    expect(svcRpcSpy).toHaveBeenCalledWith("fn_tenant_access_grant", {
      _tenant_id: TENANT_ID,
      _user_id: NEW_ID,
      _actor: OTHER_MANAGER_ID,
    });
  });
});

describe("POST /api/tenants/[id]/access: the tenant app and the list", () => {
  it("answers 409 tenant_app_disabled while the tenant app is off, with nothing privileged", async () => {
    plugins["tenant-app"] = false;
    const out = await call();
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: "The tenant app is not on for this organization yet. You can give access once it is on.",
      code: "tenant_app_disabled",
    });
    expect(out.body.error).not.toMatch(/settings|plugins/i);
    expect(events.filter((e) => PRIVILEGED.test(e))).toEqual([]);
  });

  it("answers 503 when the tenant app's state cannot be read", async () => {
    plugins["tenant-app"] = "throw";
    const out = await call();
    expect(out.status).toBe(503);
    expect(out.body.code).toBe("tenant_access_unavailable");
    expect(createServiceSpy).not.toHaveBeenCalled();
  });

  it("answers 409 already_has_access for an address on the list, whatever its case, with no service client and no notice", async () => {
    listResult = {
      data: [{ access_id: ACCESS_ID, email: "Renter@Example.test", created_at: "2026-11-18T10:00:00Z" }],
      error: null,
    };
    const out = await call({ email: "RENTER@example.test" });
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: "renter@example.test can already sign in to this unit.",
      field: "email",
      code: "already_has_access",
    });
    expect(userRpcSpy).toHaveBeenCalledWith("fn_tenant_access_list", { _tenant_id: TENANT_ID });
    expect(events.filter((e) => PRIVILEGED.test(e))).toEqual([]);
  });

  it("answers 201 with the existing access when a request for the same address got there first after the list was read", async () => {
    // The list check is not atomic with the grant; fn_tenant_access_grant's
    // ON CONFLICT returns the row the other request saved (route.ts step 4).
    authUsers = [{ id: EXISTING_ID, email: "renter@example.test" }];
    listResult = { data: [], error: null };
    grantResult = { data: ACCESS_ID, error: null };
    const first = await call();
    const second = await call();
    expect(first).toEqual(second);
    expect(second).toEqual({
      status: 201,
      body: { access_id: ACCESS_ID, email: "renter@example.test", email_sent: true },
    });
    expect(createUserSpy).not.toHaveBeenCalled();
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it("answers 503 when the list cannot be read, and 403 when the list refuses the caller", async () => {
    listResult = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await call()).status).toBe(503);
    listResult = { data: null, error: { code: "42501", message: "no" } };
    const refused = await call();
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("forbidden");
    expect(createServiceSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/tenants/[id]/access: the account", () => {
  it("uses an existing account without creating one, and grants with the session's id as the actor", async () => {
    authUsers = [{ id: EXISTING_ID, email: "Renter@example.test" }];
    const out = await call({ email: "renter@example.test" });
    expect(out.status).toBe(201);
    expect(createUserSpy).not.toHaveBeenCalled();
    expect(svcRpcSpy).toHaveBeenCalledWith("fn_tenant_access_grant", {
      _tenant_id: TENANT_ID,
      _user_id: EXISTING_ID,
      _actor: MANAGER_ID,
    });
  });

  it("creates a new account with no password and an unconfirmed address", async () => {
    const out = await call();
    expect(out.status).toBe(201);
    expect(createUserSpy).toHaveBeenCalledTimes(1);
    const [args] = createUserSpy.mock.calls[0];
    expect(args).toEqual({ email: "renter@example.test", email_confirm: false });
    expect(args).not.toHaveProperty("password");
  });

  it("runs every privileged step after the composer and the list, in order", async () => {
    await call();
    expect(events).toEqual([
      "user:tenants",
      "user:microgrids",
      "user:rpc:fn_tenant_access_list",
      "service:create",
      "service:listUsers",
      "service:createUser",
      "service:rpc:fn_tenant_access_grant",
      "user:organizations",
      "notice",
    ]);
  });

  it("answers the same body for a new and an existing account", async () => {
    const created = await call();
    authUsers = [{ id: EXISTING_ID, email: "other@example.test" }];
    const existing = await call({ email: "other@example.test" });
    expect(created).toEqual({
      status: 201,
      body: { access_id: ACCESS_ID, email: "renter@example.test", email_sent: true },
    });
    expect(existing).toEqual({
      status: 201,
      body: { access_id: ACCESS_ID, email: "other@example.test", email_sent: true },
    });
    expect(Object.keys(created.body)).toEqual(Object.keys(existing.body));
  });

  it("uses the account another request created meanwhile (email_exists), and never removes it", async () => {
    createResult = { data: { user: null }, error: { code: "email_exists", message: "already registered" } };
    appearAfterCreate = [{ id: EXISTING_ID, email: "renter@example.test" }];
    const out = await call();
    expect(out.status).toBe(201);
    expect(svcRpcSpy).toHaveBeenCalledWith("fn_tenant_access_grant", expect.objectContaining({ _user_id: EXISTING_ID }));
    grantResult = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await call()).status).toBe(500);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it("answers 503 when the account created meanwhile cannot be found", async () => {
    createResult = { data: { user: null }, error: { code: "email_exists", message: "already registered" } };
    const out = await call();
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "Could not give access. Retry the request.", code: "tenant_access_unavailable" });
    expect(svcRpcSpy).not.toHaveBeenCalled();
  });

  it("answers 500 with fixed copy when the account cannot be created", async () => {
    createResult = { data: { user: null }, error: { code: "unexpected_failure", message: "GoTrue says something internal" } };
    const out = await call();
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "Could not give access. Retry the request.", code: "tenant_access_failed" });
  });

  it("answers 503 when the account list cannot be read", async () => {
    listUsersError = { message: "down" };
    const out = await call();
    expect(out.status).toBe(503);
    expect(createUserSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/tenants/[id]/access: a grant that fails", () => {
  it.each([
    [{ code: "42501", message: "You do not have permission to manage access to this tenant." }, 403, "forbidden"],
    [{ code: "P0002", message: "Tenant not found." }, 404, "tenant_not_found"],
    [{ code: "P0002", message: "User not found." }, 503, "tenant_access_unavailable"],
    [{ code: "XX000", message: "boom" }, 500, "tenant_access_failed"],
  ])("keeps the account it created, which can sign in to nothing, and maps %j", async (error, status, code) => {
    grantResult = { data: null, error };
    const out = await call();
    expect(out.status).toBe(status);
    expect(out.body.code).toBe(code);
    expect(JSON.stringify(out.body)).not.toContain("boom");
    // Deleting it could take a grant another request made meanwhile.
    expect(deleteUserSpy).not.toHaveBeenCalled();
    expect(sendNoticeSpy).not.toHaveBeenCalled();
  });

  it("never removes an account that existed before the request", async () => {
    authUsers = [{ id: EXISTING_ID, email: "renter@example.test" }];
    grantResult = { data: null, error: { code: "XX000", message: "boom" } };
    const out = await call();
    expect(out.status).toBe(500);
    expect(deleteUserSpy).not.toHaveBeenCalled();
    expect(events).not.toContain("service:user_roles");
  });
});

describe("POST /api/tenants/[id]/access: the notice", () => {
  it("sends the notice once, after the grant, to the address through the unit's organization", async () => {
    const out = await call({ email: " Renter@Example.TEST" });
    expect(out.body.email_sent).toBe(true);
    expect(sendNoticeSpy).toHaveBeenCalledTimes(1);
    const [input] = sendNoticeSpy.mock.calls[0];
    expect(input.orgId).toBe(ORG_ID);
    expect(input.message.to).toBe("renter@example.test");
    expect(input.message.subject).toBe("Lakeside Power gave you access to your electricity use in MGM");
    expect(input.message.text).toContain("https://mgm.example.test/login");
    expect(events.indexOf("notice")).toBeGreaterThan(events.indexOf("service:rpc:fn_tenant_access_grant"));
  });

  it.each([
    ["is not configured", { ok: false as const, reason: "not_configured" }],
    ["throws", "throw" as const],
  ])("keeps the access and answers email_sent: false when the notice %s", async (_name, result) => {
    noticeResult = result;
    const out = await call();
    expect(out).toEqual({
      status: 201,
      body: { access_id: ACCESS_ID, email: "renter@example.test", email_sent: false },
    });
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it("answers email_sent: false when the application URL is not set", async () => {
    vi.stubEnv("MGM_APP_URL", "");
    const out = await call();
    expect(out.status).toBe(201);
    expect(out.body.email_sent).toBe(false);
    expect(sendNoticeSpy).not.toHaveBeenCalled();
  });

  it("logs the grant with ids and never the address", async () => {
    await call();
    const logged = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => String(args[0]))
      .filter((line) => line.includes("tenant_access.granted"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toEqual({
      event: "tenant_access.granted",
      tenant_id: TENANT_ID,
      access_id: ACCESS_ID,
      actor_id: MANAGER_ID,
      new_account: true,
      email_sent: true,
      at: expect.any(String),
    });
    expect(logged[0]).not.toContain("renter");
  });

  it("never reaches the sign-in link module or generateLink", () => {
    const source = readFileSync(path.join(__dirname, "..", "route.ts"), "utf8");
    expect(source).not.toMatch(/@\/lib\/auth\/sign-in-link|generateLink|issueSignInLink/);
  });
});

describe("POST /api/tenants/[id]/access: the limit", () => {
  it("answers 429 to a manager's 31st grant in the window, from its own limiter, and not to another manager", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await call({ email: `renter-${i}@example.test` })).status).toBe(201);
    }
    const limited = await call({ email: "one-more@example.test" });
    expect(limited).toEqual({
      status: 429,
      body: { error: "Too many access changes. Wait a few minutes and try again.", code: "rate_limited" },
    });

    currentUser = { id: OTHER_MANAGER_ID };
    expect((await call({ email: "one-more@example.test" })).status).toBe(201);
    expect(sharedLimiterSpy).not.toHaveBeenCalled();
  });

  it("counts only callers the composer has authorized", async () => {
    roleRows = [];
    for (let i = 0; i < 31; i++) expect((await call()).status).toBe(403);
    roleRows = [managerOf(ORG_ID)];
    expect((await call()).status).toBe(201);
  });
});
