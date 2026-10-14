/**
 * gate.db.test.ts — the MGM runtime gate against a real database
 * (docs/cordis-runtime.md § "The gate").
 *
 * The unit tests in gate.test.ts prove the gate asks the right questions
 * with a fake client. This suite proves real PostgREST + RLS answer them:
 *   - every target kind's embedded select resolves the owning organization
 *     for an org_manager of that organization and for a super_admin;
 *   - an org_manager of another organization resolves nothing (RLS hides
 *     the row and the gate does not leak plugin state across orgs);
 *   - writes are refused with 409 `<plugin>_disabled` while the plugin is
 *     off, reads pass, and enabling the plugin lets the write through.
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
import { MGM_BUNDLED_PLUGINS, getBundledPlugin } from "@/lib/plugins/bundled";
import { MgmGate, resolveTargetOrganization, type GateTarget } from "../gate";
import type { MgmCatalog } from "../services";

const F = {
  orgA: "e7000000-0000-4000-8000-000000000001",
  orgB: "e7000000-0000-4000-8000-000000000002",
  communityA: "e7000000-0000-4000-8001-000000000001",
  microgridA: "e7000000-0000-4000-8002-000000000001",
  edgeA: "e7000000-0000-4000-8003-000000000001",
  deviceA: "e7000000-0000-4000-8004-000000000001",
  householdA: "e7000000-0000-4000-8005-000000000001",
  rateA: "e7000000-0000-4000-8006-000000000001",
  periodA: "e7000000-0000-4000-8007-000000000001",
  lineItemA: "e7000000-0000-4000-8008-000000000001",
};

const EMAILS = {
  managerA: "gate-db-manager-a@test.local",
  managerB: "gate-db-manager-b@test.local",
  superAdmin: "gate-db-super@test.local",
};

const catalog: MgmCatalog = {
  plugins: MGM_BUNDLED_PLUGINS,
  get: (name) => getBundledPlugin(name),
  isCore: (name) => getBundledPlugin(name)?.core ?? false,
};
const gate = new MgmGate(catalog);

const TARGETS: GateTarget[] = [
  { kind: "organization", id: F.orgA },
  { kind: "community", id: F.communityA },
  { kind: "microgrid", id: F.microgridA },
  { kind: "edge", id: F.edgeA },
  { kind: "device", id: F.deviceA },
  { kind: "billingPeriod", id: F.periodA },
  { kind: "lineItem", id: F.lineItemA },
  { kind: "rateSchedule", id: F.rateA },
];

let managerA: TestUser;
let managerB: TestUser;
let superAdmin: TestUser;

async function setPlugin(plugin: string, enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert(
      { org_id: F.orgA, plugin_name: plugin, version: "0.1.0", enabled },
      { onConflict: "org_id,plugin_name" }
    );
  if (error) throw new Error(`[fixture] mgm_plugins ${plugin}: ${error.message}`);
}

async function insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]) {
  const svc = await serviceClient();
  const { error } = await svc.from(table).insert(rows);
  if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: Object.values(EMAILS) });

  await insert("organizations", [
    { id: F.orgA, name: "Gate DB Org A" },
    { id: F.orgB, name: "Gate DB Org B" },
  ]);
  await insert("communities", { id: F.communityA, org_id: F.orgA, name: "Gate DB Community A" });
  await insert("microgrids", {
    id: F.microgridA,
    community_id: F.communityA,
    name: "Gate DB Microgrid A",
    currency: "UGX",
  });
  await insert("edges", {
    id: F.edgeA,
    microgrid_id: F.microgridA,
    name: "Gate DB Edge A",
    openems_edge_id: "gate-db-edge-a",
  });
  await insert("devices", {
    id: F.deviceA,
    edge_id: F.edgeA,
    name: "Gate DB Meter A",
    device_type: "consumption_meter",
    openems_component_id: "gate-db-meter-a",
  });
  await insert("households", {
    id: F.householdA,
    microgrid_id: F.microgridA,
    display_name: "Gate DB Household A",
    primary_phone: "+256700007001",
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

  managerA = await createTestUser({ email: EMAILS.managerA, role: "org_manager", scopeId: F.orgA });
  managerB = await createTestUser({ email: EMAILS.managerB, role: "org_manager", scopeId: F.orgB });
  superAdmin = await createTestUser({ email: EMAILS.superAdmin, role: "super_admin" });
});

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: Object.values(EMAILS) });
});

describe.skipIf(shouldSkip())("MGM runtime gate against the database", () => {
  it.each(TARGETS.map((target) => [target.kind, target] as const))(
    "resolves a %s to its organization for that organization's manager",
    async (_kind, target) => {
      await expect(resolveTargetOrganization(managerA.client, target)).resolves.toBe(F.orgA);
    }
  );

  it.each(TARGETS.map((target) => [target.kind, target] as const))(
    "resolves a %s for a super_admin",
    async (_kind, target) => {
      await expect(resolveTargetOrganization(superAdmin.client, target)).resolves.toBe(F.orgA);
    }
  );

  it.each(TARGETS.filter((t) => t.kind !== "organization").map((t) => [t.kind, t] as const))(
    "hides a %s from another organization's manager",
    async (_kind, target) => {
      await expect(resolveTargetOrganization(managerB.client, target)).resolves.toBeNull();
    }
  );

  it("refuses a metering write while Metering is off and allows it once enabled", async () => {
    // Billing and Payments depend on Metering; turn them off first, as Settings does.
    await setPlugin("pesapal", false);
    await setPlugin("payments", false);
    await setPlugin("billing", false);
    await setPlugin("metering", false);
    try {
      const request = { plugin: "metering" as const, target: { kind: "device" as const, id: F.deviceA } };
      await expect(gate.check(managerA.client, { ...request, method: "PATCH" })).resolves.toMatchObject({
        ok: false,
        status: 409,
        code: "metering_disabled",
      });
      await expect(gate.check(managerA.client, { ...request, method: "GET" })).resolves.toEqual({
        ok: true,
        organizationId: null,
      });
      // Another organization's manager learns nothing about Org A's plugin state.
      await expect(gate.check(managerB.client, { ...request, method: "PATCH" })).resolves.toEqual({
        ok: true,
        organizationId: null,
      });
    } finally {
      await setPlugin("metering", true);
      await setPlugin("billing", true);
      await setPlugin("payments", true);
      await setPlugin("pesapal", true);
    }
    await expect(
      gate.check(managerA.client, {
        plugin: "metering",
        target: { kind: "edge", id: F.edgeA },
        method: "DELETE",
      })
    ).resolves.toEqual({ ok: true, organizationId: F.orgA });
  });

  it("refuses billing writes on every billing target while Billing is off", async () => {
    await setPlugin("pesapal", false);
    await setPlugin("payments", false);
    await setPlugin("billing", false);
    try {
      for (const target of [
        { kind: "rateSchedule", id: F.rateA },
        { kind: "billingPeriod", id: F.periodA },
        { kind: "lineItem", id: F.lineItemA },
        { kind: "community", id: F.communityA },
        { kind: "microgrid", id: F.microgridA },
      ] as GateTarget[]) {
        await expect(
          gate.check(managerA.client, { plugin: "billing", target, method: "POST" })
        ).resolves.toMatchObject({ ok: false, status: 409, code: "billing_disabled" });
      }
    } finally {
      await setPlugin("billing", true);
      await setPlugin("payments", true);
      await setPlugin("pesapal", true);
    }
  });

  it("treats a missing row as enabled (no mgm_plugins row)", async () => {
    const svc = await serviceClient();
    await svc.from("mgm_plugins").delete().eq("org_id", F.orgA);
    await expect(
      gate.check(managerA.client, {
        plugin: "community-management",
        target: { kind: "community", id: F.communityA },
        method: "PATCH",
      })
    ).resolves.toEqual({ ok: true, organizationId: F.orgA });
  });
});
