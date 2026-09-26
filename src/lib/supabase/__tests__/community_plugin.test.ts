/**
 * community_plugin.test.ts — database-backed tests for Release 1 (issue #3).
 *
 * Covers the `mgm_plugins` / `mgm_plugin_audit_log` schema (migration 00056):
 *   - Missing plugin rows default to enabled (no backfill required).
 *   - Org managers can read/write plugin state only for their own org.
 *   - Disabling community-management fails direct domain writes closed
 *     (42501) while reads keep working and rows are preserved.
 *   - Every toggle is recorded in the append-only audit log.
 *   - organization-directory cannot be disabled (core lock).
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "./rls.helpers";

const FIXTURE = {
  orgA: "c1000000-0000-4000-8000-000000000001",
  orgB: "c1000000-0000-4000-8000-000000000002",
  communityA: "c1000000-0000-4000-8001-000000000001",
  microgridA: "c1000000-0000-4000-8002-000000000001",
};

let userA: TestUser; // org_manager scoped to orgA
let userB: TestUser; // org_manager scoped to orgB
let userD: TestUser; // super_admin

const testUserEmails = [
  "plugin-test-usera@test.local",
  "plugin-test-userb@test.local",
  "plugin-test-userd@test.local",
];

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  const svc = await serviceClient();

  await cleanupTestData({
    orgIds: [FIXTURE.orgA, FIXTURE.orgB],
    userEmails: testUserEmails,
  });

  const { error: orgError } = await svc.from("organizations").insert([
    { id: FIXTURE.orgA, name: "Plugin Test Org A" },
    { id: FIXTURE.orgB, name: "Plugin Test Org B" },
  ]);
  if (orgError) throw new Error(`[fixture] orgs: ${orgError.message}`);

  const { error: commError } = await svc.from("communities").insert([
    { id: FIXTURE.communityA, org_id: FIXTURE.orgA, name: "Plugin Community A" },
  ]);
  if (commError) throw new Error(`[fixture] communities: ${commError.message}`);

  const { error: mgError } = await svc.from("microgrids").insert([
    {
      id: FIXTURE.microgridA,
      community_id: FIXTURE.communityA,
      name: "Plugin Microgrid A",
      currency: "UGX",
    },
  ]);
  if (mgError) throw new Error(`[fixture] microgrids: ${mgError.message}`);

  [userA, userB, userD] = await Promise.all([
    createTestUser({
      email: testUserEmails[0],
      role: "org_manager",
      scopeId: FIXTURE.orgA,
    }),
    createTestUser({
      email: testUserEmails[1],
      role: "org_manager",
      scopeId: FIXTURE.orgB,
    }),
    createTestUser({ email: testUserEmails[2], role: "super_admin" }),
  ]);
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanupTestData({
    orgIds: [FIXTURE.orgA, FIXTURE.orgB],
    userEmails: testUserEmails,
  });
});

describe("mgm plugin state + enforcement", () => {
  it("defaults to enabled when no state row exists", async () => {
    if (shouldSkip()) return;
    const svc = await serviceClient();
    const { data, error } = await svc.rpc("mgm_plugin_enabled_for_org", {
      _org_id: FIXTURE.orgA,
      _plugin_name: "community-management",
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("org_manager A can write a community while the plugin is enabled", async () => {
    if (shouldSkip()) return;
    const { error } = await userA.client.from("communities").insert({
      org_id: FIXTURE.orgA,
      name: "Plugin Enabled Community",
    });
    expect(error).toBeNull();
  });

  it("org_manager B cannot read or mutate orgA plugin state", async () => {
    if (shouldSkip()) return;
    const { data: rows } = await userB.client
      .from("mgm_plugins")
      .select("*")
      .eq("org_id", FIXTURE.orgA);
    expect(rows ?? []).toEqual([]);

    const { error: toggleError } = await userB.client.rpc(
      "fn_mgm_set_plugin_enabled",
      {
        _org_id: FIXTURE.orgA,
        _plugin_name: "community-management",
        _plugin_version: "0.1.0",
        _enabled: false,
      }
    );
    expect(toggleError?.code).toBe("42501");
  });

  it("disabling fails domain writes closed while reads keep working", async () => {
    if (shouldSkip()) return;
    const { error: toggleError } = await userD.client.rpc(
      "fn_mgm_set_plugin_enabled",
      {
        _org_id: FIXTURE.orgA,
        _plugin_name: "community-management",
        _plugin_version: "0.1.0",
        _enabled: false,
      }
    );
    expect(toggleError).toBeNull();

    const { error: helperError, data: enabled } = await userA.client.rpc(
      "mgm_plugin_enabled_for_org",
      { _org_id: FIXTURE.orgA, _plugin_name: "community-management" }
    );
    expect(helperError).toBeNull();
    expect(enabled).toBe(false);

    // Reads still work.
    const { data: communities, error: readError } = await userA.client
      .from("communities")
      .select("id")
      .eq("org_id", FIXTURE.orgA);
    expect(readError).toBeNull();
    expect((communities ?? []).length).toBeGreaterThan(0);

    // Direct community writes fail closed.
    const { error: communityError } = await userA.client
      .from("communities")
      .insert({ org_id: FIXTURE.orgA, name: "Blocked Community" });
    expect(communityError?.code).toBe("42501");

    // Direct microgrid writes fail closed.
    const { error: microgridError } = await userA.client
      .from("microgrids")
      .insert({
        community_id: FIXTURE.communityA,
        name: "Blocked Microgrid",
        currency: "UGX",
      });
    expect(microgridError?.code).toBe("42501");
  });

  it("records the disable in the append-only audit log", async () => {
    if (shouldSkip()) return;
    const { data, error } = await userD.client
      .from("mgm_plugin_audit_log")
      .select("*")
      .eq("org_id", FIXTURE.orgA)
      .eq("plugin_name", "community-management")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      action: "disabled",
      previous_enabled: null,
      new_enabled: false,
    });
    expect(data?.[0]?.actor_user_id).toBe(userD.userId);
  });

  it("locks organization-directory against disable", async () => {
    if (shouldSkip()) return;
    const { error } = await userD.client.rpc("fn_mgm_set_plugin_enabled", {
      _org_id: FIXTURE.orgA,
      _plugin_name: "organization-directory",
      _plugin_version: "0.1.0",
      _enabled: false,
    });
    expect(error?.code).toBe("P0001");
    expect(error?.message).toContain("cannot be disabled");
  });

  it("re-enabling preserves data and restores writes", async () => {
    if (shouldSkip()) return;
    const { error: toggleError } = await userD.client.rpc(
      "fn_mgm_set_plugin_enabled",
      {
        _org_id: FIXTURE.orgA,
        _plugin_name: "community-management",
        _plugin_version: "0.1.0",
        _enabled: true,
      }
    );
    expect(toggleError).toBeNull();

    // Rows written before the disable survived.
    const { data: communities, error: readError } = await userA.client
      .from("communities")
      .select("id, name")
      .eq("org_id", FIXTURE.orgA);
    expect(readError).toBeNull();
    expect(
      (communities ?? []).some((row) => row.name === "Plugin Enabled Community")
    ).toBe(true);

    const { error: writeError } = await userA.client
      .from("communities")
      .insert({ org_id: FIXTURE.orgA, name: "Plugin Re-enabled Community" });
    expect(writeError).toBeNull();
  });

  it("bootstrap RPC is not executable by authenticated clients", async () => {
    if (shouldSkip()) return;
    // EXECUTE is granted to service_role only: the token guard lives in the
    // Next.js route, so direct PostgREST calls must be denied even for a
    // super_admin. Either grant-layer denial (42501) or schema-cache
    // filtering (PGRST202) is the same secure outcome.
    const { error } = await userD.client.rpc(
      "fn_mgm_bootstrap_first_organization",
      {
        _operator_user_id: userD.userId,
        _name: "Second Org",
        _address_city: "Kampala",
        _address_country: "Uganda",
        _organization_directory_version: "0.1.0",
        _community_management_version: "0.1.0",
      }
    );
    expect(error).not.toBeNull();
    expect(
      error?.code === "42501" ||
        error?.code === "PGRST202" ||
        (error?.message ?? "").toLowerCase().includes("permission denied")
    ).toBe(true);

    const svc = await serviceClient();
    const { data: orgs } = await svc
      .from("organizations")
      .select("id")
      .eq("name", "Second Org");
    expect(orgs ?? []).toEqual([]);
  });

  it("denies direct plugin-state writes even for the owning org manager", async () => {
    if (shouldSkip()) return;
    // State changes are exposed only through fn_mgm_set_plugin_enabled.
    const { error: insertError } = await userA.client
      .from("mgm_plugins")
      .insert({
        org_id: FIXTURE.orgA,
        plugin_name: "community-management",
        version: "9.9.9",
        enabled: false,
      });
    expect(insertError).not.toBeNull();

    const { error: updateError } = await userA.client
      .from("mgm_plugins")
      .update({ enabled: false })
      .eq("org_id", FIXTURE.orgA)
      .eq("plugin_name", "community-management");
    // RLS may silently filter an UPDATE. Verify the protected state.
    void updateError;
    const svc = await serviceClient();
    const { data: plugin, error: readError } = await svc
      .from("mgm_plugins")
      .select("enabled")
      .eq("org_id", FIXTURE.orgA)
      .eq("plugin_name", "community-management")
      .single();
    expect(readError).toBeNull();
    expect(plugin?.enabled).toBe(true);

    // Forged audit history is denied as well.
    const { error: auditError } = await userA.client
      .from("mgm_plugin_audit_log")
      .insert({
        org_id: FIXTURE.orgA,
        plugin_name: "community-management",
        action: "disabled",
        previous_enabled: true,
        new_enabled: false,
        actor_user_id: userA.userId,
      });
    expect(auditError).not.toBeNull();
  });

  it("anonymous callers cannot resolve plugin state", async () => {
    if (shouldSkip()) return;
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(
      "http://localhost:54321",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
    );
    const { error } = await anon.rpc("mgm_plugin_enabled_for_org", {
      _org_id: FIXTURE.orgA,
      _plugin_name: "community-management",
    });
    // Either grant-layer denial (42501) or schema-cache filtering (PGRST202)
    // is the same secure outcome; see CLAUDE.md § Migration conventions.
    expect(
      error?.code === "42501" ||
        error?.code === "PGRST202" ||
        (error?.message ?? "").toLowerCase().includes("permission denied")
    ).toBe(true);
  });
});
