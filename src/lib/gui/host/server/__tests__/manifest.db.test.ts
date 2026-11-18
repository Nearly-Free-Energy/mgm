/**
 * manifest.db.test.ts — buildManifest's reads against a real database.
 *
 * manifest.test.ts pins the query shapes with a fake client. This suite
 * proves real PostgREST and row-level security give the answers they rely on:
 *   - a super_admin acting in one organization sees only that organization's
 *     communities and microgrids among its places, though row-level security
 *     shows them every organization's rows;
 *   - a microgrid past the places cap, named by the path, still gets its
 *     community as its parent;
 *   - a person whose rows are all tenant rows (RFC mgm#197 § 4) gets their
 *     unit from fn_tenant_home, no organization, and the tenant entry only
 *     once the tenant app is turned on for the unit's organization, each
 *     read with their own session; one who also manages an organization
 *     gets that organization's manifest with the tenant entry beside it.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { SurfaceSnapshot } from "../surface-registry";
import { contextFor, managerOf, superAdmin, tenantOf } from "./host-fakes";

const EMPTY: SurfaceSnapshot = {
  views: [],
  actions: new Map(),
  nav: [],
  signals: [],
  status: [],
  search: [],
  entities: new Map(),
  guis: [],
};
/** The tenant home's nav entry and view, as the tenant app contributes them. */
const TENANT_HOME: SurfaceSnapshot = {
  ...EMPTY,
  nav: [
    {
      plugin: "tenant-app",
      def: { id: "tenant.home", title: "My home", icon: "tenants", group: "operate", order: 80, view: "tenant.home", audience: "tenant" },
    },
  ],
  views: [{ plugin: "tenant-app", def: { id: "tenant.home", path: "/my", params: {} } } as unknown as SurfaceSnapshot["views"][number]],
};
let snapshot: SurfaceSnapshot = EMPTY;
// The real runtime, so the plugin gate answers from the database; only the
// surface snapshot is replaced, so each test names what contributes.
vi.mock("@/lib/runtime/root", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime/root")>();
  return {
    ...actual,
    getMgmRuntime: async () => ({ ...(await actual.getMgmRuntime()), mgmSurface: { snapshot: () => snapshot } }),
  };
});
// /my, the tenant home, is released by RFC mgm#197's PR 5.
vi.mock("@/lib/mgm/released-routes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mgm/released-routes")>();
  return { ...actual, isReleasedRoute: (path: string) => path === "/my" || actual.isReleasedRoute(path) };
});

import { MAX_PLACES_PER_KIND } from "../../shared/manifest-model";
import { buildManifest } from "../manifest";

const F = {
  orgA: "e7300000-0000-4000-8000-000000000001",
  orgB: "e7300000-0000-4000-8000-000000000002",
  communityA: "e7300000-0000-4000-8001-000000000001",
  communityB: "e7300000-0000-4000-8001-000000000002",
  microgridB: "e7300000-0000-4000-8002-0000000000ff",
  /** Named last, so it sorts past the places cap. */
  microgridLast: "e7300000-0000-4000-8002-0000000000fe",
  tenantA: "e7300000-0000-4000-8004-000000000001",
};
const microgridA = (i: number) => `e7300000-0000-4000-8002-${String(i).padStart(12, "0")}`;

const EMAILS = {
  managerA: "gui-manifest-manager-a@test.local",
  superAdmin: "gui-manifest-super@test.local",
  tenant: "gui-manifest-tenant@test.local",
  managerBTenant: "gui-manifest-manager-b-tenant@test.local",
};

let managerA: TestUser;
let admin: TestUser;
let tenant: TestUser;
let managerBTenant: TestUser;

const as = (user: TestUser, roles: UserRoleRecord[]) => contextFor(roles, async () => user.client);

async function insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]) {
  const svc = await serviceClient();
  const { error } = await svc.from(table).insert(rows);
  if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
}

const cleanup = () => cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: Object.values(EMAILS) });

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  await insert("organizations", [
    { id: F.orgA, name: "GUI Manifest Org A" },
    { id: F.orgB, name: "GUI Manifest Org B" },
  ]);
  await insert("communities", [
    { id: F.communityA, org_id: F.orgA, name: "GUI Manifest Community A" },
    { id: F.communityB, org_id: F.orgB, name: "GUI Manifest Community B" },
  ]);
  await insert("microgrids", [
    ...Array.from({ length: MAX_PLACES_PER_KIND }, (_, i) => ({
      id: microgridA(i + 1),
      community_id: F.communityA,
      name: `GUI Manifest Microgrid A ${String(i).padStart(3, "0")}`,
      currency: "UGX",
    })),
    { id: F.microgridLast, community_id: F.communityA, name: "GUI Manifest Microgrid A zzz", currency: "UGX" },
    { id: F.microgridB, community_id: F.communityB, name: "GUI Manifest Microgrid B", currency: "UGX" },
  ]);
  await insert("tenants", {
    id: F.tenantA,
    microgrid_id: microgridA(1),
    display_name: "GUI Manifest Tenant",
    unit_label: "Unit 4",
    primary_phone: "+256700000001",
  });
  managerA = await createTestUser({ email: EMAILS.managerA, role: "org_manager", scopeId: F.orgA });
  admin = await createTestUser({ email: EMAILS.superAdmin, role: "super_admin" });
  tenant = await createTestUser({ email: EMAILS.tenant, role: "tenant", scopeId: F.tenantA });
  managerBTenant = await createTestUser({
    email: EMAILS.managerBTenant,
    role: "org_manager",
    scopeId: F.orgB,
    extraRoles: [{ role: "tenant", scopeType: "tenant", scopeId: F.tenantA }],
  });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanup();
}, 60_000);

describe.skipIf(shouldSkip())("buildManifest against the database", () => {
  it("lists only the chosen organization's places to a super_admin", async () => {
    for (const [org, community, other] of [
      [F.orgA, F.communityA, F.communityB],
      [F.orgB, F.communityB, F.communityA],
    ]) {
      const outcome = await buildManifest(as(admin, [superAdmin()]), { gui: "gridtop", requested: org });
      expect(outcome.ok && outcome.manifest.org.id).toBe(org);
      if (!outcome.ok) return;
      const places = outcome.manifest.org.places;
      expect(places.map((p) => p.id)).toContain(community);
      expect(places.map((p) => p.id)).not.toContain(other);
      expect(places.filter((p) => p.kind === "microgrid").every((p) => p.parent === community)).toBe(true);
    }
  });

  it("gives a path microgrid past the places cap its community", async () => {
    const outcome = await buildManifest(as(managerA, [managerOf(F.orgA)]), {
      gui: "gridtop",
      path: `/microgrids/${F.microgridLast}/billing`,
    });
    expect(outcome.ok && outcome.manifest.org.places.filter((p) => p.id === F.microgridLast)).toEqual([
      expect.objectContaining({ kind: "microgrid", parent: F.communityA }),
    ]);
  });
});

describe.skipIf(shouldSkip())("buildManifest for a person who holds a unit, against the database", () => {
  async function setTenantApp(orgId: string, enabled: boolean | null) {
    const svc = await serviceClient();
    const { error } =
      enabled === null
        ? await svc.from("mgm_plugins").delete().eq("org_id", orgId).eq("plugin_name", "tenant-app")
        : await svc.from("mgm_plugins").upsert({ org_id: orgId, plugin_name: "tenant-app", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
    if (error) throw new Error(`[fixture] mgm_plugins: ${error.message}`);
  }

  beforeAll(() => {
    snapshot = TENANT_HOME;
  });
  afterAll(async () => {
    snapshot = EMPTY;
    await setTenantApp(F.orgA, null);
  });

  it("gives a tenant-only person their unit and no organization, and the tenant entry only once the app is on", async () => {
    await setTenantApp(F.orgA, null);
    const off = await buildManifest(as(tenant, [tenantOf(F.tenantA)]), { gui: "gridtop", path: "/" });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.manifest.org).toEqual({
      id: F.tenantA,
      name: "GUI Manifest Tenant",
      href: "/my",
      timezone: "UTC",
      // The tenant app is off for an organization that never turned it on.
      nav: [],
      status: [],
      places: [{ kind: "tenant", id: F.tenantA, label: "GUI Manifest Tenant", href: "/my" }],
    });
    expect(off.manifest.orgs).toEqual([]);

    await setTenantApp(F.orgA, true);
    const on = await buildManifest(as(tenant, [tenantOf(F.tenantA)]), { gui: "gridtop" });
    expect(on.ok && on.manifest.org.nav.map((n) => n.id)).toEqual(["tenant.home"]);
  });

  it("gives a person who manages one organization and rents in another that organization's manifest, with the tenant entry", async () => {
    await setTenantApp(F.orgA, true);
    const roles = [managerOf(F.orgB), tenantOf(F.tenantA)];
    const outcome = await buildManifest(as(managerBTenant, roles), { gui: "gridtop" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.manifest.org).toMatchObject({ id: F.orgB, name: "GUI Manifest Org B" });
    expect(outcome.manifest.orgs.map((o) => o.id)).toEqual([F.orgB]);
    expect(outcome.manifest.org.nav.map((n) => n.id)).toEqual(["tenant.home"]);
    expect(outcome.manifest.org.places.map((p) => p.kind)).not.toContain("tenant");

    // Off where they rent: no tenant entry, though their own organization's state is untouched.
    await setTenantApp(F.orgA, false);
    const off = await buildManifest(as(managerBTenant, roles), { gui: "gridtop" });
    expect(off.ok && off.manifest.org.nav).toEqual([]);
  });
});
