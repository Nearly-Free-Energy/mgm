/**
 * POST /api/tenants/[id]/access and DELETE /api/tenants/[id]/access/[accessId]
 * against the local database (RFC mgm#197 § 6).
 *
 * Why this exists in addition to the route tests: those mock both clients,
 * so they show which calls the routes make but not what the database then
 * holds. Here the routes run with the caller's real RLS-bound client (minted
 * JWTs, `rls.helpers.ts`), a real service-role client and the real runtime,
 * and the rows are read back afterwards. Only the notice is stubbed, so no
 * mail leaves the test.
 *
 * Cases, in order (later ones use the accounts earlier ones gave access):
 *   - an org manager gives a new address access: 201, the list shows it, it
 *     can be sent a sign-in link, and it is not recorded as staff;
 *   - an address that is another organization's manager is given a unit like
 *     any other, keeps its organization row and stays on the Users page;
 *   - a tenant of another organization is given a second unit;
 *   - the same address again: 409, no second notice;
 *   - a super admin gives access;
 *   - refused, with nothing written: the unit's own tenant, another
 *     organization's manager, and an organization whose tenant app is off;
 *   - DELETE: a person with no other row loses their sessions, a person
 *     with another row keeps theirs, both answer 204 with no body; another
 *     unit's access id is 404; a tenant is refused. The person who keeps
 *     their session is refused the unit's tenant pages at once, with the
 *     same still-valid token (what the Remove confirmation promises).
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
  runAsDatabaseOwner,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { composeTenantApp } from "@/lib/tenant-app/compose";

let currentCallerClient: SupabaseClient | null = null;
let svc: SupabaseClient | null = null;
const noticeSpy = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!currentCallerClient) throw new Error("[access rls-route] no caller set");
    return currentCallerClient;
  },
}));
// The route's service client is the suite's own service-role client, minted
// from the JWT secret as the other database suites do, so it runs in CI,
// which exports no service-role key.
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    if (!svc) throw new Error("[access rls-route] no service client");
    return svc;
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/notices", () => ({
  sendNotice: vi.fn(async (input: unknown) => {
    noticeSpy(input);
    return { ok: true, via: "deployment" };
  }),
}));
process.env.MGM_APP_URL ??= "https://mgm.example.org";

const F = {
  orgA: "e7900000-0000-4000-8000-000000000001",
  orgB: "e7900000-0000-4000-8000-000000000002",
  communityA: "e7900000-0000-4000-8001-000000000001",
  communityB: "e7900000-0000-4000-8001-000000000002",
  microgridA: "e7900000-0000-4000-8002-000000000001",
  microgridB: "e7900000-0000-4000-8002-000000000002",
  unitA1: "e7900000-0000-4000-8005-000000000001",
  unitA2: "e7900000-0000-4000-8005-000000000002",
  unitB1: "e7900000-0000-4000-8005-000000000003",
};
const EMAIL = {
  superAdmin: "access-route-super-admin@test.local",
  managerA: "access-route-manager-a@test.local",
  managerB: "access-route-manager-b@test.local",
  tenantA1: "access-route-tenant-a1@test.local",
  tenantB1: "access-route-tenant-b1@test.local",
  // Created by the route.
  fresh: "access-route-fresh@test.local",
  bySuperAdmin: "access-route-by-super-admin@test.local",
  refused: "access-route-refused@test.local",
};

let superAdmin: TestUser;
let managerA: TestUser;
let managerB: TestUser;
let tenantA1: TestUser;
let tenantB1: TestUser;

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

async function post(caller: TestUser, tenantId: string, email: string) {
  currentCallerClient = caller.client;
  const { POST } = await import("../route");
  const res = await POST(
    new NextRequest(`http://localhost/api/tenants/${tenantId}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    { params: Promise.resolve({ id: tenantId }) }
  );
  return { status: res.status, body: await res.json() };
}

async function remove(caller: TestUser, tenantId: string, accessId: string) {
  currentCallerClient = caller.client;
  const { DELETE } = await import("../[accessId]/route");
  const res = await DELETE(
    new NextRequest(`http://localhost/api/tenants/${tenantId}/access/${accessId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: tenantId, accessId }) }
  );
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

async function listed(tenantId: string, caller: TestUser = managerA): Promise<string[]> {
  const { data, error } = await caller.client.rpc("fn_tenant_access_list", { _tenant_id: tenantId });
  if (error) throw new Error(`[access rls-route] list: ${error.message}`);
  return (data as { email: string }[]).map((r) => r.email).sort();
}

async function accountId(email: string): Promise<string | null> {
  const { data, error } = await svc!.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`[access rls-route] listUsers: ${error.message}`);
  return data.users.find((u) => u.email === email)?.id ?? null;
}

type RoleRow = { role: string; scope_type: string; scope_id: string | null };

async function rolesOf(userId: string): Promise<RoleRow[]> {
  const { data, error } = await svc!
    .from("user_roles")
    .select("role, scope_type, scope_id")
    .eq("user_id", userId)
    .order("scope_id");
  if (error) throw new Error(`[access rls-route] user_roles: ${error.message}`);
  return data as RoleRow[];
}

/** Every tenant row of the fixture units, to show a refused request wrote nothing. */
async function fixtureTenantRows(): Promise<unknown[]> {
  const { data, error } = await svc!
    .from("user_roles")
    .select("id, user_id, scope_id")
    .eq("role", "tenant")
    .in("scope_id", [F.unitA1, F.unitA2, F.unitB1])
    .order("id");
  if (error) throw new Error(`[access rls-route] tenant rows: ${error.message}`);
  return data;
}

function sessionCount(userId: string): number {
  const result = runAsDatabaseOwner(
    `SELECT count(*)::int AS sessions FROM auth.sessions WHERE user_id = '${userId}'`
  );
  if (!result.ok) throw new Error(`[owner query] ${result.output}`);
  return (JSON.parse(result.stdout) as { sessions: number }[])[0].sessions;
}

/** One session with one refresh token, as a sign-in leaves behind. */
function addSession(userId: string): void {
  const result = runAsDatabaseOwner(
    `DO $$ DECLARE s uuid := gen_random_uuid(); BEGIN
       INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
       VALUES (s, '${userId}', now(), now(), 'aal1');
       INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)
       VALUES ('access-route-' || s, '${userId}', false, now(), now(), s);
     END $$`
  );
  if (!result.ok) throw new Error(`[session fixture] ${result.output}`);
}

beforeAll(async () => {
  if (skip) return;
  await assertEnvironmentReady();
  svc = await serviceClient();
  await cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: Object.values(EMAIL) });

  const inserts: [string, Record<string, unknown>[]][] = [
    [
      "organizations",
      [
        { id: F.orgA, name: "Access route org A" },
        { id: F.orgB, name: "Access route org B" },
      ],
    ],
    [
      "communities",
      [
        { id: F.communityA, org_id: F.orgA, name: "Access route community A" },
        { id: F.communityB, org_id: F.orgB, name: "Access route community B" },
      ],
    ],
    [
      "microgrids",
      [
        { id: F.microgridA, community_id: F.communityA, name: "Access route grid A", currency: "UGX", timezone: "Africa/Kampala" },
        { id: F.microgridB, community_id: F.communityB, name: "Access route grid B", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "tenants",
      [
        { id: F.unitA1, microgrid_id: F.microgridA, display_name: "Renter A1", unit_label: "A1", primary_phone: "+256700000301" },
        { id: F.unitA2, microgrid_id: F.microgridA, display_name: "Renter A2", unit_label: "A2", primary_phone: "+256700000302" },
        { id: F.unitB1, microgrid_id: F.microgridB, display_name: "Renter B1", unit_label: "B1", primary_phone: "+256700000303" },
      ],
    ],
    // The tenant app is on for organization A only; it is off without a row.
    [
      "mgm_plugins",
      [{ org_id: F.orgA, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled: true }],
    ],
  ];
  for (const [table, rows] of inserts) {
    const { error } = await svc.from(table).insert(rows);
    if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
  }

  [superAdmin, managerA, managerB, tenantA1, tenantB1] = await Promise.all([
    createTestUser({ email: EMAIL.superAdmin, role: "super_admin" }),
    createTestUser({ email: EMAIL.managerA, role: "org_manager", scopeId: F.orgA }),
    createTestUser({ email: EMAIL.managerB, role: "org_manager", scopeId: F.orgB }),
    createTestUser({ email: EMAIL.tenantA1, role: "tenant", scopeId: F.unitA1 }),
    createTestUser({ email: EMAIL.tenantB1, role: "tenant", scopeId: F.unitB1 }),
  ]);
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: Object.values(EMAIL) });
}, 30_000);

beforeEach(() => {
  noticeSpy.mockReset();
  currentCallerClient = null;
});

const accessIds: Record<string, string> = {};

desc("POST /api/tenants/[id]/access (RLS mode)", () => {
  it("gives a new address access: the account can be sent a sign-in link and is not recorded as staff", async () => {
    expect(await accountId(EMAIL.fresh)).toBeNull();

    const out = await post(managerA, F.unitA1, EMAIL.fresh.toUpperCase());

    expect(out.status).toBe(201);
    expect(out.body).toEqual({ access_id: expect.any(String), email: EMAIL.fresh, email_sent: true });
    accessIds.fresh = out.body.access_id;
    expect(await listed(F.unitA1)).toEqual([EMAIL.fresh, EMAIL.tenantA1].sort());

    const id = await accountId(EMAIL.fresh);
    expect(id).not.toBeNull();
    expect(await rolesOf(id!)).toEqual([{ role: "tenant", scope_type: "tenant", scope_id: F.unitA1 }]);
    const target = await svc!.rpc("fn_auth_sign_in_target", { _email: EMAIL.fresh });
    expect(target.data).toBe(id);
    const staff = await svc!.from("staff_access_accounts").select("user_id").eq("user_id", id!);
    expect(staff.error).toBeNull();
    expect(staff.data).toEqual([]);

    expect(noticeSpy).toHaveBeenCalledTimes(1);
    const [notice] = noticeSpy.mock.calls[0] as [{ orgId: string; message: { to: string; text: string } }];
    expect(notice.orgId).toBe(F.orgA);
    expect(notice.message.to).toBe(EMAIL.fresh);
    expect(notice.message.text).toContain("Access route org A");
  });

  it("gives a unit to another organization's manager like any address, and they stay staff", async () => {
    const out = await post(managerA, F.unitA1, EMAIL.managerB);

    expect(out.status).toBe(201);
    expect(Object.keys(out.body).sort()).toEqual(["access_id", "email", "email_sent"]);
    accessIds.managerB = out.body.access_id;
    expect(await rolesOf(managerB.userId)).toEqual(
      [
        { role: "org_manager", scope_type: "org", scope_id: F.orgB },
        { role: "tenant", scope_type: "tenant", scope_id: F.unitA1 },
      ].sort((a, b) => a.scope_id.localeCompare(b.scope_id))
    );
    const users = await superAdmin.client.rpc("fn_list_visible_users", { _target_user_ids: [managerB.userId] });
    expect(users.error).toBeNull();
    expect((users.data as { user_id: string; role: string }[]).map((r) => [r.user_id, r.role])).toContainEqual([
      managerB.userId,
      "org_manager",
    ]);
    // Their own organization still answers them as its manager.
    expect(await listed(F.unitB1, managerB)).toEqual([EMAIL.tenantB1]);
  });

  it("gives a tenant of another organization a second unit", async () => {
    const out = await post(managerA, F.unitA2, EMAIL.tenantB1);

    expect(out.status).toBe(201);
    expect((await rolesOf(tenantB1.userId)).map((r) => r.scope_id).sort()).toEqual([F.unitA2, F.unitB1].sort());
    expect(await listed(F.unitA2)).toEqual([EMAIL.tenantB1]);
  });

  it("answers 409 for an address that already has access, and sends no second notice", async () => {
    const before = await fixtureTenantRows();
    const out = await post(managerA, F.unitA1, EMAIL.fresh);

    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: `${EMAIL.fresh} can already sign in to this unit.`,
      field: "email",
      code: "already_has_access",
    });
    expect(noticeSpy).not.toHaveBeenCalled();
    expect(await fixtureTenantRows()).toEqual(before);
  });

  it("lets a super admin give access", async () => {
    const out = await post(superAdmin, F.unitA2, EMAIL.bySuperAdmin);

    expect(out.status).toBe(201);
    expect(await listed(F.unitA2)).toEqual([EMAIL.bySuperAdmin, EMAIL.tenantB1].sort());
  });

  it("refuses the unit's own tenant, and writes nothing", async () => {
    const before = await fixtureTenantRows();
    const out = await post(tenantA1, F.unitA1, EMAIL.refused);

    expect(out.status).toBe(403);
    expect(out.body.code).toBe("forbidden");
    expect(await fixtureTenantRows()).toEqual(before);
    expect(await accountId(EMAIL.refused)).toBeNull();
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it("answers another organization's manager as for a unit that does not exist, and writes nothing", async () => {
    // Unit A2: managerB holds tenant access to A1 by now, which lets them
    // read A1's row (and get 403 for its microgrid), but not A2's.
    const before = await fixtureTenantRows();
    const out = await post(managerB, F.unitA2, EMAIL.refused);

    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "Tenant not found", code: "tenant_not_found" });
    // On the unit they rent, they are refused as its tenant.
    const asTenant = await post(managerB, F.unitA1, EMAIL.refused);
    expect(asTenant.status).toBe(403);
    expect(await fixtureTenantRows()).toEqual(before);
    expect(await accountId(EMAIL.refused)).toBeNull();
  });

  it("refuses while the organization's tenant app is off, and writes nothing", async () => {
    const before = await fixtureTenantRows();
    const out = await post(managerB, F.unitB1, EMAIL.refused);

    expect(out.status).toBe(409);
    expect(out.body.code).toBe("tenant_app_disabled");
    expect(await fixtureTenantRows()).toEqual(before);
    expect(await accountId(EMAIL.refused)).toBeNull();
    expect(noticeSpy).not.toHaveBeenCalled();
  });
});

desc("DELETE /api/tenants/[id]/access/[accessId] (RLS mode)", () => {
  it("refuses a tenant, and removes nothing", async () => {
    const before = await fixtureTenantRows();
    const out = await remove(tenantA1, F.unitA1, accessIds.fresh);

    expect(out.status).toBe(403);
    expect(await fixtureTenantRows()).toEqual(before);
  });

  it("answers 404 for an access id of another unit, and removes nothing", async () => {
    const before = await fixtureTenantRows();
    const out = await remove(managerA, F.unitA2, accessIds.fresh);

    expect(out.status).toBe(404);
    expect(out.body.code).toBe("access_not_found");
    expect(await fixtureTenantRows()).toEqual(before);
  });

  it("answers 204 with an empty body and ends the sessions of a person left with no row", async () => {
    const id = (await accountId(EMAIL.fresh))!;
    addSession(id);
    expect(sessionCount(id)).toBe(1);

    const out = await remove(managerA, F.unitA1, accessIds.fresh);

    expect(out.status).toBe(204);
    expect(out.text).toBe("");
    expect(await listed(F.unitA1)).toEqual([EMAIL.managerB, EMAIL.tenantA1].sort());
    expect(await rolesOf(id)).toEqual([]);
    expect(sessionCount(id)).toBe(0);
  });

  it("answers 204 with an empty body and keeps the sessions of a person who holds another row", async () => {
    addSession(managerB.userId);
    const before = sessionCount(managerB.userId);
    // Signed in and reading the unit's tenant pages before the removal.
    const warm = await composeTenantApp({ supabase: managerB.client, tenantId: F.unitA1 });
    expect(warm.ok).toBe(true);
    if (warm.ok) {
      try {
        expect((await warm.data.tenantApp.getUsageMonth({ month: "2026-11" })).ok).toBe(true);
      } finally {
        await warm.data.dispose();
      }
    }

    const out = await remove(managerA, F.unitA1, accessIds.managerB);

    expect(out.status).toBe(204);
    expect(out.text).toBe("");
    expect(await listed(F.unitA1)).toEqual([EMAIL.tenantA1]);
    expect(await rolesOf(managerB.userId)).toEqual([{ role: "org_manager", scope_type: "org", scope_id: F.orgB }]);
    expect(sessionCount(managerB.userId)).toBe(before);

    // The same token, still valid, no longer opens the unit's tenant pages
    // or reads its row: tenant access is re-read on every request.
    const after = await composeTenantApp({ supabase: managerB.client, tenantId: F.unitA1 });
    expect(after).toMatchObject({ ok: false, status: 403 });
    const row = await managerB.client.from("tenants").select("id").eq("id", F.unitA1);
    expect(row).toMatchObject({ error: null, data: [] });
  });

  it("answers 404 once the access is already gone", async () => {
    const out = await remove(managerA, F.unitA1, accessIds.managerB);
    expect(out.status).toBe(404);
    expect(out.body.code).toBe("access_not_found");
  });
});
