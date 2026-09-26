/**
 * ems_bearer_token.test.ts — issue #4, migration 00061.
 *
 * Mirrors ems_basic_auth_credentials.test.ts (#327) for the Keycloak bearer
 * token column:
 *
 * 1. The column behaves like the other credential columns: encrypted at
 *    rest, writable only through the configuration guard, readable only
 *    through a service_role function.
 * 2. The guard coverage itself is asserted statically (no database) in
 *    `src/lib/__tests__/ems-guard-enumeration.test.ts`, which reads the
 *    newest guard migration — 00061 re-issues it with the new column in
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
  org: "ddbb0000-aaaa-4000-8000-000000000001",
  orgOther: "ddbb0000-bbbb-4000-8000-000000000001",
  community: "ddbb1111-aaaa-4000-8000-000000000001",
  communityOther: "ddbb1111-bbbb-4000-8000-000000000001",
  microgrid: "ddbb2222-aaaa-4000-8000-000000000001",
} as const;

const EMAILS = ["ems-bearer-mgr@test.local", "ems-bearer-outside@test.local"];

describe.skipIf(skip)("#4 — Keycloak bearer token (migration 00061)", () => {
  let MGR: TestUser;
  let OUTSIDE: TestUser;

  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [FIXTURE.org, FIXTURE.orgOther], userEmails: EMAILS });
    const svc = await serviceClient();

    await svc.from("organizations").upsert([
      { id: FIXTURE.org, name: "BearerTest Org" },
      { id: FIXTURE.orgOther, name: "BearerTest Other Org" },
    ]);
    await svc.from("communities").upsert([
      { id: FIXTURE.community, org_id: FIXTURE.org, name: "BearerTest Community" },
      {
        id: FIXTURE.communityOther,
        org_id: FIXTURE.orgOther,
        name: "BearerTest Other Community",
      },
    ]);
    await svc.from("microgrids").upsert([
      {
        id: FIXTURE.microgrid,
        community_id: FIXTURE.community,
        name: "BearerTest Microgrid",
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

  // ── Behaviour: the bearer column is inside the guard ────────────────────

  it("an org manager can write the bearer column on their own microgrid", async () => {
    const svc = await serviceClient();
    const { data: ct } = await svc.rpc("fn_ems_encrypt_secret", {
      p_plaintext: "keycloak-test-token",
    });

    const { error } = await MGR.client
      .from("microgrids")
      .update({ ems_bearer_token_encrypted: ct as string })
      .eq("id", FIXTURE.microgrid);

    expect(error).toBeNull();
  });

  it("an org manager from another org cannot change the bearer column", async () => {
    const svc = await serviceClient();
    const { data: before } = await svc
      .from("microgrids")
      .select("ems_bearer_token_encrypted")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_bearer_token_encrypted: string | null }>();

    const { error } = await OUTSIDE.client
      .from("microgrids")
      .update({ ems_bearer_token_encrypted: "bogus" })
      .eq("id", FIXTURE.microgrid);

    // Which layer refuses is not the assertion — RLS filters the row before
    // the trigger is reached. The assertion is that the value did not change.
    void error;

    const { data: after } = await svc
      .from("microgrids")
      .select("ems_bearer_token_encrypted")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_bearer_token_encrypted: string | null }>();

    expect(after?.ems_bearer_token_encrypted).toBe(
      before?.ems_bearer_token_encrypted ?? null
    );
  });

  // ── The token is encrypted at rest and unreadable to a user session ─────

  it("the stored token is ciphertext, not the plaintext", async () => {
    const svc = await serviceClient();
    const { data } = await svc
      .from("microgrids")
      .select("ems_bearer_token_encrypted")
      .eq("id", FIXTURE.microgrid)
      .single<{ ems_bearer_token_encrypted: string | null }>();

    expect(data?.ems_bearer_token_encrypted).toBeTruthy();
    expect(data?.ems_bearer_token_encrypted).not.toContain("keycloak");
  });

  it("fn_get_ems_bearer_token is not callable by an authenticated user", async () => {
    const { error } = await MGR.client.rpc(
      "fn_get_ems_bearer_token" as never,
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

  it("service_role can read the token back through the function", async () => {
    const svc = await serviceClient();
    const { data, error } = await svc.rpc("fn_get_ems_bearer_token", {
      _microgrid_id: FIXTURE.microgrid,
    });

    expect(error).toBeNull();
    expect(data).toBe("keycloak-test-token");
  });
});
