/**
 * POST /api/users/invite against the local database, for an address whose
 * account holds only tenant rows (RFC mgm#197).
 *
 * Why this exists in addition to route.test.ts: the unit suite mocks both
 * clients, so it shows which RPC the route calls but not what the database
 * then holds. Here the route runs with the caller's real RLS-bound client
 * (minted JWTs, `rls.helpers.ts`) and a real service-role client, and the
 * rows are read back afterwards. Only the notice and the runtime it reads
 * its mail transports from are stubbed.
 *
 * Cases, in order (they share the target account):
 *   - org manager of the unit's organization invites the address → 409
 *     other_access; no row and no profile field changes.
 *   - super admin invites it as org manager → 201; the tenant rows keep
 *     their ids, an org manager row is added, the person is listed on the
 *     Users page (fn_list_visible_users) as org manager, still reads both
 *     units, and keeps their profile; fn_finalize_user_invitation is not
 *     called.
 *
 * Self-fixturing under its own ids and addresses. Opt-out: SKIP_RLS_TESTS=1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let currentCallerClient: SupabaseClient | null = null;
let svc: SupabaseClient | null = null;
const noticeSpy = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!currentCallerClient) throw new Error("[invite rls-route] no caller set");
    return currentCallerClient;
  },
}));
// The route's service client is the suite's own service-role client, minted
// from the JWT secret as the other database suites do, so it runs in CI,
// which exports no service-role key.
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    if (!svc) throw new Error("[invite rls-route] no service client");
    return svc;
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/notices", () => ({
  sendNotice: vi.fn(async (...args: unknown[]) => {
    noticeSpy(...args);
    return { ok: true, via: "deployment" };
  }),
}));
vi.mock("@/lib/runtime/root", () => ({
  getMgmRuntime: async () => ({ mailTransports: {} }),
}));
process.env.MGM_APP_URL ??= "https://mgm.example.org";

const F = {
  org: "7e4b0000-0000-4000-8000-000000000001",
  community: "7e4b0000-0000-4000-8001-000000000001",
  microgrid: "7e4b0000-0000-4000-8002-000000000001",
  unitA: "7e4b0000-0000-4000-8005-000000000001",
  unitB: "7e4b0000-0000-4000-8005-000000000002",
};
const EMAIL = {
  superAdmin: "invite-tenant-super-admin@test.local",
  manager: "invite-tenant-manager@test.local",
  tenant: "invite-tenant-target@test.local",
};

let superAdmin: TestUser;
let manager: TestUser;
let tenant: TestUser;

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

type RoleRow = { id: string; role: string; scope_type: string; scope_id: string | null };

async function rolesOf(userId: string): Promise<RoleRow[]> {
  const { data, error } = await svc!
    .from("user_roles")
    .select("id, role, scope_type, scope_id")
    .eq("user_id", userId)
    .order("id");
  if (error) throw new Error(`[invite rls-route] user_roles: ${error.message}`);
  return data as RoleRow[];
}

async function profileOf(userId: string) {
  const { data, error } = await svc!
    .from("user_profiles")
    .select("first_name, last_name, phone, updated_at")
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(`[invite rls-route] user_profiles: ${error.message}`);
  return data;
}

/** The route run as `caller`, with every RPC the caller's client makes recorded. */
async function invite(caller: TestUser) {
  currentCallerClient = caller.client;
  const rpc = vi.spyOn(caller.client, "rpc");
  try {
    const { POST } = await import("../route");
    const res = await POST(
      new NextRequest("http://localhost/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: EMAIL.tenant.toUpperCase(),
          first_name: "Typed",
          last_name: "Name",
          phone: "+256700000999",
          role: "org_manager",
          scope_id: F.org,
        }),
      })
    );
    return { status: res.status, body: await res.json(), rpcs: rpc.mock.calls.map((call) => call[0]) };
  } finally {
    rpc.mockRestore();
  }
}

beforeAll(async () => {
  if (skip) return;
  await assertEnvironmentReady();
  svc = await serviceClient();
  await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });

  const inserts: [string, Record<string, unknown>[]][] = [
    ["organizations", [{ id: F.org, name: "Invite tenant org" }]],
    ["communities", [{ id: F.community, org_id: F.org, name: "Invite tenant community" }]],
    ["microgrids", [{ id: F.microgrid, community_id: F.community, name: "Invite tenant grid", currency: "UGX", timezone: "Africa/Kampala" }]],
    [
      "tenants",
      [
        { id: F.unitA, microgrid_id: F.microgrid, display_name: "Renter", unit_label: "A1", primary_phone: "+256700000201" },
        { id: F.unitB, microgrid_id: F.microgrid, display_name: "Renter", unit_label: "B1", primary_phone: "+256700000201" },
      ],
    ],
  ];
  for (const [table, rows] of inserts) {
    const { error } = await svc.from(table).insert(rows);
    if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
  }

  [superAdmin, manager, tenant] = await Promise.all([
    createTestUser({ email: EMAIL.superAdmin, role: "super_admin" }),
    createTestUser({ email: EMAIL.manager, role: "org_manager", scopeId: F.org }),
    createTestUser({
      email: EMAIL.tenant,
      role: "tenant",
      scopeId: F.unitA,
      extraRoles: [{ role: "tenant", scopeType: "tenant", scopeId: F.unitB }],
    }),
  ]);
  // A first name only, so the form's fields would fill the others if the
  // route wrote the profile.
  const { error } = await svc.from("user_profiles").update({ first_name: "Renter", last_name: null, phone: null }).eq("user_id", tenant.userId);
  if (error) throw new Error(`[fixture] user_profiles: ${error.message}`);
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });
}, 30_000);

beforeEach(() => {
  noticeSpy.mockReset();
  currentCallerClient = null;
});

desc("POST /api/users/invite for an account with only tenant rows (RLS mode)", () => {
  it("answers an org manager as for any account with other access, and changes nothing", async () => {
    const rolesBefore = await rolesOf(tenant.userId);
    const profileBefore = await profileOf(tenant.userId);
    expect(rolesBefore.map((r) => r.role)).toEqual(["tenant", "tenant"]);

    const out = await invite(manager);

    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error:
        `${EMAIL.tenant.toUpperCase()} already has an MGM account with a different role. ` +
        "A super admin can change it from the Users list.",
      field: "email",
      code: "other_access",
    });
    expect(out.rpcs).toEqual([]);
    expect(noticeSpy).not.toHaveBeenCalled();
    expect(await rolesOf(tenant.userId)).toEqual(rolesBefore);
    expect(await profileOf(tenant.userId)).toEqual(profileBefore);
  });

  it("makes the tenant an org manager for a super admin, keeping their units and profile", async () => {
    const tenantRows = await rolesOf(tenant.userId);
    const profileBefore = await profileOf(tenant.userId);

    const out = await invite(superAdmin);

    expect(out.status).toBe(201);
    expect(out.body).toEqual({ user_id: tenant.userId, existing_account: true, email_sent: true });
    expect(out.rpcs).toEqual(["fn_change_user_role"]);
    expect(noticeSpy).toHaveBeenCalledTimes(1);

    // The tenant rows are the same rows, and one org manager row is added.
    const after = await rolesOf(tenant.userId);
    expect(after.filter((r) => r.role === "tenant")).toEqual(tenantRows);
    expect(after.filter((r) => r.role !== "tenant")).toEqual([
      { id: expect.any(String), role: "org_manager", scope_type: "org", scope_id: F.org },
    ]);
    // Nothing on the profile is written.
    expect(await profileOf(tenant.userId)).toEqual(profileBefore);

    // Listed on the Users page as an org manager of the organization.
    const listed = await superAdmin.client.rpc("fn_list_visible_users", { _target_user_ids: [tenant.userId] });
    expect(listed.error).toBeNull();
    expect(listed.data).toEqual([
      expect.objectContaining({ user_id: tenant.userId, role: "org_manager", scope_type: "org", scope_id: F.org }),
    ]);

    // And still reads both units with their own session.
    for (const unit of [F.unitA, F.unitB]) {
      const home = await tenant.client.rpc("fn_tenant_home", { _tenant_id: unit });
      expect(home.error).toBeNull();
      expect(home.data).toEqual([expect.objectContaining({ tenant_id: unit, organization_id: F.org })]);
    }
  });
});
