/**
 * manifest.db.test.ts — buildManifest's reads against a real database.
 *
 * manifest.test.ts pins the query shapes with a fake client. This suite
 * proves real PostgREST and row-level security give the answers they rely on:
 *   - a super_admin acting in one organization sees only that organization's
 *     communities and microgrids among its places, though row-level security
 *     shows them every organization's rows;
 *   - a microgrid past the places cap, named by the path, still gets its
 *     community as its parent.
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
import { contextFor, managerOf, superAdmin } from "./host-fakes";

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
// The real runtime, so the plugin gate answers from the database; only the
// surface snapshot is replaced, because nothing contributes yet.
vi.mock("@/lib/runtime/root", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime/root")>();
  return {
    ...actual,
    getMgmRuntime: async () => ({ ...(await actual.getMgmRuntime()), mgmSurface: { snapshot: () => EMPTY } }),
  };
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
};
const microgridA = (i: number) => `e7300000-0000-4000-8002-${String(i).padStart(12, "0")}`;

const EMAILS = {
  managerA: "gui-manifest-manager-a@test.local",
  superAdmin: "gui-manifest-super@test.local",
};

let managerA: TestUser;
let admin: TestUser;

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
  managerA = await createTestUser({ email: EMAILS.managerA, role: "org_manager", scopeId: F.orgA });
  admin = await createTestUser({ email: EMAILS.superAdmin, role: "super_admin" });
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
