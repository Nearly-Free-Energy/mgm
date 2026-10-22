/**
 * synthetic_metering_plugin.test.ts — database-backed tests for issue #44
 * (migration 20261022090000_synthetic_metering_plugin.sql).
 *
 *   - A missing mgm_plugins row means OFF for synthetic-metering and ON for
 *     every other plugin; one organization's state never leaks to another.
 *   - Toggling through fn_mgm_set_plugin_enabled writes an audit row.
 *   - Disabling `metering` is refused while synthetic-metering is enabled
 *     (dependency rule in the plugin service; the SQL function does not
 *     enforce dependencies).
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setOrganizationPluginEnabled } from "@/lib/plugins/state";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "./rls.helpers";

const F = {
  orgA: "c5000000-0000-4000-8000-000000000001",
  orgB: "c5000000-0000-4000-8000-000000000002",
};
const EMAILS = ["synth-plugin-a@test.local", "synth-plugin-b@test.local"];
let managerA: TestUser;

const toggle = (user: TestUser, org: string, plugin: string, enabled: boolean) =>
  user.client.rpc("fn_mgm_set_plugin_enabled", {
    _org_id: org,
    _plugin_name: plugin,
    _plugin_version: "0.1.0",
    _enabled: enabled,
  });

const enabledFor = async (org: string, plugin: string) => {
  const svc = await serviceClient();
  const { data, error } = await svc.rpc("mgm_plugin_enabled_for_org", {
    _org_id: org,
    _plugin_name: plugin,
  });
  expect(error).toBeNull();
  return data;
};

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  const svc = await serviceClient();
  await cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: EMAILS });
  const { error } = await svc.from("organizations").insert([
    { id: F.orgA, name: "Synthetic Plugin Org A" },
    { id: F.orgB, name: "Synthetic Plugin Org B" },
  ]);
  if (error) throw new Error(`[fixture] orgs: ${error.message}`);
  managerA = await createTestUser({
    email: EMAILS[0],
    role: "org_manager",
    scopeId: F.orgA,
  });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanupTestData({ orgIds: [F.orgA, F.orgB], userEmails: EMAILS });
});

describe("synthetic-metering plugin state", () => {
  it("a missing row is off for synthetic-metering and on for other plugins", async () => {
    if (shouldSkip()) return;
    expect(await enabledFor(F.orgA, "synthetic-metering")).toBe(false);
    for (const plugin of ["metering", "billing", "payments", "community-management"]) {
      expect(await enabledFor(F.orgA, plugin)).toBe(true);
    }
  });

  it("enabling writes state and an audit row; other organizations are unaffected", async () => {
    if (shouldSkip()) return;
    const { error } = await toggle(managerA, F.orgA, "synthetic-metering", true);
    expect(error).toBeNull();
    expect(await enabledFor(F.orgA, "synthetic-metering")).toBe(true);
    expect(await enabledFor(F.orgB, "synthetic-metering")).toBe(false);

    const { data } = await managerA.client
      .from("mgm_plugin_audit_log")
      .select("*")
      .eq("org_id", F.orgA)
      .eq("plugin_name", "synthetic-metering")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(data?.[0]).toMatchObject({
      action: "enabled",
      previous_enabled: null,
      new_enabled: true,
      actor_user_id: managerA.userId,
    });
  });

  it("disabling again is audited with the previous state", async () => {
    if (shouldSkip()) return;
    // Re-enable first so the next test starts from a known state afterwards.
    const { error } = await toggle(managerA, F.orgA, "synthetic-metering", false);
    expect(error).toBeNull();
    const { data } = await managerA.client
      .from("mgm_plugin_audit_log")
      .select("*")
      .eq("org_id", F.orgA)
      .eq("plugin_name", "synthetic-metering")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(data?.[0]).toMatchObject({
      action: "disabled",
      previous_enabled: true,
      new_enabled: false,
    });
    expect(await enabledFor(F.orgA, "synthetic-metering")).toBe(false);
  });

  it("refuses to disable metering while synthetic-metering is enabled", async () => {
    if (shouldSkip()) return;
    await toggle(managerA, F.orgA, "synthetic-metering", true);
    await expect(
      setOrganizationPluginEnabled(managerA.client, F.orgA, "metering", false)
    ).rejects.toMatchObject({
      code: "plugin_dependency_required",
      message: expect.stringContaining("Synthetic metering"),
    });
    expect(await enabledFor(F.orgA, "metering")).toBe(true);
  });

  it("an unknown plugin name is still rejected", async () => {
    if (shouldSkip()) return;
    const { error } = await toggle(managerA, F.orgA, "synthetic-metering-x", true);
    expect(error).not.toBeNull();
  });
});
