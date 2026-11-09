/**
 * entities.db.test.ts — resolveSegments against a real database.
 *
 * entities.test.ts proves the refusals with a fake client. This suite proves
 * real PostgREST and row-level security give the answers it relies on:
 *   - every core entity kind resolves to its organization for that
 *     organization's manager and for a super_admin, and to a 404 for another
 *     organization's manager;
 *   - an organization segment must be a row the caller can see;
 *   - a segment that does not sit under the one above it is a 404.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import { CORE_ENTITY_KINDS, type CoreEntityKind } from "@/lib/plugins/bundled";
import type { UserRoleRecord } from "@/lib/types/domain";
import { resolveSegments, type Segment } from "../entities";
import { contextFor, managerOf, superAdmin } from "./host-fakes";

const F = {
  orgA: "e7200000-0000-4000-8000-000000000001",
  orgB: "e7200000-0000-4000-8000-000000000002",
  missingOrg: "e7200000-0000-4000-8000-0000000000ff",
  communityA: "e7200000-0000-4000-8001-000000000001",
  communityA2: "e7200000-0000-4000-8001-000000000002",
  microgridA: "e7200000-0000-4000-8002-000000000001",
  edgeA: "e7200000-0000-4000-8003-000000000001",
  deviceA: "e7200000-0000-4000-8004-000000000001",
  householdA: "e7200000-0000-4000-8005-000000000001",
  rateA: "e7200000-0000-4000-8006-000000000001",
  periodA: "e7200000-0000-4000-8007-000000000001",
  lineItemA: "e7200000-0000-4000-8008-000000000001",
  merchantA: "e7200000-0000-4000-8009-000000000001",
  attemptA: "e7200000-0000-4000-800a-000000000001",
};

const EMAILS = {
  managerA: "gui-entities-manager-a@test.local",
  managerB: "gui-entities-manager-b@test.local",
  superAdmin: "gui-entities-super@test.local",
};

const SEGMENTS: Record<CoreEntityKind, string> = {
  organization: F.orgA,
  community: F.communityA,
  microgrid: F.microgridA,
  edge: F.edgeA,
  device: F.deviceA,
  household: F.householdA,
  billingPeriod: F.periodA,
  lineItem: F.lineItemA,
  rateSchedule: F.rateA,
  paymentAttempt: F.attemptA,
};

let managerA: TestUser;
let managerB: TestUser;
let admin: TestUser;

/** A host context whose new clients are this test user's own session. */
const as = (user: TestUser, roles: UserRoleRecord[]) => contextFor(roles, async () => user.client);
const seg = (kind: CoreEntityKind, id: string): Segment => ({ name: kind, kind, id });

async function insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]) {
  const svc = await serviceClient();
  const { error } = await svc.from(table).insert(rows);
  if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
}

// Same cleanup as gate.db.test.ts: payment_merchant_versions has no cascade
// from organizations, so its rows go first; if that foreign key gains a
// cascade, the delete becomes a no-op. Org A holds a payment attempt, which
// the billing retention guards keep, so cleanupTestData purges it as the
// database owner.
async function cleanup() {
  const svc = await serviceClient();
  const { error } = await svc.from("payment_merchant_versions").delete().in("org_id", [F.orgA, F.orgB]);
  if (error) throw new Error(`[cleanup] payment_merchant_versions: ${error.message}`);
  await cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: Object.values(EMAILS) });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();

  await insert("organizations", [
    { id: F.orgA, name: "GUI Entities Org A" },
    { id: F.orgB, name: "GUI Entities Org B" },
  ]);
  await insert("communities", [
    { id: F.communityA, org_id: F.orgA, name: "GUI Entities Community A" },
    { id: F.communityA2, org_id: F.orgA, name: "GUI Entities Community A2" },
  ]);
  await insert("microgrids", {
    id: F.microgridA,
    community_id: F.communityA,
    name: "GUI Entities Microgrid A",
    currency: "UGX",
  });
  await insert("edges", {
    id: F.edgeA,
    microgrid_id: F.microgridA,
    name: "GUI Entities Edge A",
    openems_edge_id: "gui-entities-edge-a",
  });
  await insert("devices", {
    id: F.deviceA,
    edge_id: F.edgeA,
    name: "GUI Entities Meter A",
    device_type: "consumption_meter",
    openems_component_id: "gui-entities-meter-a",
  });
  await insert("households", {
    id: F.householdA,
    microgrid_id: F.microgridA,
    display_name: "GUI Entities Household A",
    primary_phone: "+256700007201",
  });
  await insert("rate_schedules", {
    id: F.rateA,
    microgrid_id: F.microgridA,
    tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }],
    service_charge: 0,
    tax_rate: 0,
  });
  await insert("billing_periods", {
    id: F.periodA,
    microgrid_id: F.microgridA,
    start_date: "2026-04-01",
    end_date: "2026-04-30",
    status: "draft",
  });
  await insert("billing_line_items", {
    id: F.lineItemA,
    billing_period_id: F.periodA,
    household_id: F.householdA,
    device_id: F.deviceA,
    usage_kwh: 1,
    total_amount: 500,
  });
  // Merchant account first: the payment_account_snapshot trigger writes the
  // version row that payment_attempt_scope requires.
  await insert("payment_merchant_accounts", {
    id: F.merchantA,
    org_id: F.orgA,
    display_name: "GUI Entities Merchant A",
  });
  await insert("payment_attempts", {
    id: F.attemptA,
    org_id: F.orgA,
    line_item_id: F.lineItemA,
    community_id: F.communityA,
    merchant_account_id: F.merchantA,
    merchant_account_version: 1,
    amount: 500,
    merchant_reference: `GUI-ENTITIES-${F.attemptA}`,
  });

  managerA = await createTestUser({ email: EMAILS.managerA, role: "org_manager", scopeId: F.orgA });
  managerB = await createTestUser({ email: EMAILS.managerB, role: "org_manager", scopeId: F.orgB });
  admin = await createTestUser({ email: EMAILS.superAdmin, role: "super_admin" });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanup();
}, 60_000);

describe.skipIf(shouldSkip())("resolveSegments against the database", () => {
  it("has a segment for every core entity kind", () => {
    expect(Object.keys(SEGMENTS).sort()).toEqual([...CORE_ENTITY_KINDS].sort());
  });

  it.each(CORE_ENTITY_KINDS.map((kind) => [kind] as const))(
    "resolves a %s to its organization for its manager and for a super_admin",
    async (kind) => {
      const segments = [seg(kind, SEGMENTS[kind])];
      await expect(resolveSegments(as(managerA, [managerOf(F.orgA)]), { entities: new Map() }, segments)).resolves
        .toMatchObject({ ok: true, organizationId: F.orgA });
      await expect(resolveSegments(as(admin, [superAdmin()]), { entities: new Map() }, segments)).resolves
        .toMatchObject({ ok: true, organizationId: F.orgA });
    },
  );

  it.each(CORE_ENTITY_KINDS.map((kind) => [kind] as const))(
    "refuses a %s to another organization's manager",
    async (kind) => {
      await expect(
        resolveSegments(as(managerB, [managerOf(F.orgB)]), { entities: new Map() }, [seg(kind, SEGMENTS[kind])]),
      ).resolves.toEqual({ ok: false, status: 404 });
    },
  );

  it("refuses an organization segment that is not a visible row, even to a super_admin", async () => {
    await expect(
      resolveSegments(as(admin, [superAdmin()]), { entities: new Map() }, [seg("organization", F.missingOrg)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("refuses a manager whose role names an organization they cannot see", async () => {
    // Roles claim Org A, but the client is Org B's manager: row-level security hides every row.
    await expect(
      resolveSegments(as(managerB, [managerOf(F.orgA)]), { entities: new Map() }, [seg("organization", F.orgA)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("checks nesting, and labels the trail from the rows", async () => {
    const ctx = as(managerA, [managerOf(F.orgA)]);
    const resolved = await resolveSegments(ctx, { entities: new Map() }, [
      seg("community", F.communityA),
      seg("microgrid", F.microgridA),
      seg("device", F.deviceA),
    ]);
    expect(resolved).toMatchObject({ ok: true, organizationId: F.orgA });
    expect(resolved.ok && resolved.trail.map((t) => t.label)).toEqual([
      "GUI Entities Community A",
      "GUI Entities Microgrid A",
    ]);

    await expect(
      resolveSegments(ctx, { entities: new Map() }, [seg("community", F.communityA2), seg("microgrid", F.microgridA)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });
});
