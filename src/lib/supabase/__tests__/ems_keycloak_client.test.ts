/**
 * ems_keycloak_client.test.ts — issue #4 follow-up, migration 00062.
 *
 * Mirrors ems_bearer_token.test.ts (00061) for the Keycloak client-secret
 * column:
 *
 * 1. The column behaves like the other credential columns: encrypted at
 *    rest, writable only through the configuration guard, readable only
 *    through a service_role function.
 * 2. The guard coverage itself is asserted statically (no database) in
 *    `src/lib/__tests__/ems-guard-enumeration.test.ts`, which reads the
 *    newest guard migration — 00062 re-issues it with the new columns in
 *    both enumerations.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();

const FIXTURE = {
  org: "ddbb0000-cccc-4000-8000-000000000001",
  orgOther: "ddbb0000-dddd-4000-8000-000000000001",
  community: "ddbb1111-cccc-4000-8000-000000000001",
  communityOther: "ddbb1111-dddd-4000-8000-000000000001",
  microgrid: "ddbb2222-cccc-4000-8000-000000000001",
} as const;

const EMAILS = ["ems-keycloak-mgr@test.local", "ems-keycloak-outside@test.local"];

describe.skipIf(skip)("#4 — Keycloak client secret (migration 00062)", () => {
  let MGR: TestUser;
  let OUTSIDE: TestUser;

  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [FIXTURE.org, FIXTURE.orgOther], userEmails: EMAILS });
    const svc = await serviceClient();

    await svc.from("organizations").upsert([
      { id: FIXTURE.org, name: "KeycloakTest Org" },
      { id: FIXTURE.orgOther, name: "KeycloakTest Other Org" },
    ]);
    await svc.from("communities").upsert([
      { id: FIXTURE.community, org_id: FIXTURE.org, name: "KeycloakTest Community" },
      {
        id: FIXTURE.communityOther,
        org_id: FIXTURE.orgOther,
        name: "KeycloakTest Other Community",
      },
    ]);
    await svc.from("microgrids").upsert([
      {
        id: FIXTURE.microgrid,
        community_id: FIXTURE.community,
        name: "KeycloakTest Microgrid",
        currency: "UGX",
        ems_type: "direct_url",
        ems_backend_url: "https://example.invalid/rest",
      },
    ]);

    MGR = await createTestUser({
      email: EMAILS[0],
      role: "org_manager",
      scopeId: FIXTURE.org,
    });
    OUTSIDE = await createTestUser({
      email: EMAILS[1],
      role: "org_manager",
      scopeId: FIXTURE.orgOther,
    });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestData({
      orgIds: [FIXTURE.org, FIXTURE.orgOther],
      userEmails: EMAILS,
    });
  });

  // ── Behaviour: the Keycloak columns are inside the guard ─────────────────

  it("an org manager can write the Keycloak columns on their own microgrid", async () => {
    const svc = await serviceClient();
    const { data: ct } = await svc.rpc("fn_ems_encrypt_secret", {
      p_plaintext: "keycloak-client-secret",
    });

    const { error } = await MGR.client
      .from("microgrids")
      .update({
        ems_keycloak_token_url: "https://kc.example/token",
        ems_keycloak_client_id: "mgm-client",
        ems_keycloak_client_secret_encrypted: ct as string,
      })
      .eq("id", FIXTURE.microgrid);

    expect(error).toBeNull();
  });

  it("an org manager from another org cannot change the Keycloak columns", async () => {
    const svc = await serviceClient();
    const { data: before } = await svc
      .from("microgrids")
      .select("ems_keycloak_client_id")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_keycloak_client_id: string | null }>();

    const { error } = await OUTSIDE.client
      .from("microgrids")
      .update({ ems_keycloak_client_id: "intruder" })
      .eq("id", FIXTURE.microgrid);

    // Which layer refuses is not the assertion — RLS filters the row before
    // the trigger is reached. The assertion is that the value did not change.
    void error;

    const { data: after } = await svc
      .from("microgrids")
      .select("ems_keycloak_client_id")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_keycloak_client_id: string | null }>();

    expect(after?.ems_keycloak_client_id).toBe(
      before?.ems_keycloak_client_id ?? null
    );
  });

  // ── The secret is encrypted at rest and unreadable to a user session ─────

  it("the stored client secret is ciphertext, not the plaintext", async () => {
    const svc = await serviceClient();
    const { data } = await svc
      .from("microgrids")
      .select("ems_keycloak_client_secret_encrypted")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_keycloak_client_secret_encrypted: string | null }>();

    expect(data?.ems_keycloak_client_secret_encrypted).toBeTruthy();
    expect(data?.ems_keycloak_client_secret_encrypted).not.toContain(
      "keycloak-client-secret"
    );
  });

  it("fn_get_ems_keycloak_client_secret is not callable by an authenticated user", async () => {
    const { error } = await MGR.client.rpc(
      "fn_get_ems_keycloak_client_secret" as never,
      { _microgrid_id: FIXTURE.microgrid } as never
    );

    // Two shapes are acceptable and mean the same thing — see CLAUDE.md's
    // "PostgREST surface varies by REVOKE pattern" table.
    expect(error).not.toBeNull();
    const code = error?.code ?? "";
    const message = (error?.message ?? "").toLowerCase();
    expect(
      code === "42501" ||
        code === "PGRST202" ||
        message.includes("permission denied") ||
        message.includes("could not find the function")
    ).toBe(true);
  });

  it("service_role can read the client secret back through the function", async () => {
    const svc = await serviceClient();
    const { data, error } = await svc.rpc("fn_get_ems_keycloak_client_secret", {
      _microgrid_id: FIXTURE.microgrid,
    });

    expect(error).toBeNull();
    expect(data).toBe("keycloak-client-secret");
  });
});
