/**
 * auth_access_token_hook.test.ts — RFC #186 PR 5, migration 20261117210000.
 *
 * 1. fn_auth_access_token_hook refuses a token for a session a password or
 *    a recovery started, new or refreshed, and returns every other browser
 *    event unchanged. Since 20261126090100 it also checks an event that
 *    carries a client_id (a client of Supabase Auth's OAuth server):
 *    auth_access_token_hook_clients.test.ts.
 * 2. Only Supabase Auth (supabase_auth_admin) may call it.
 * 3. End to end against the local Supabase, where supabase/config.toml
 *    enables the hook: password sign-in and password sign-up get no
 *    session; an emailed link signs in, and its session refreshes.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import {
  LOCAL_SUPABASE_URL,
  assertEnvironmentReady,
  cleanupTestData,
  runAsDatabaseOwner,
  serviceClient,
  shouldSkip,
  testAnonKey,
} from "./rls.helpers";

const skip = shouldSkip();
const PASSWORD = `hook-pw-${Date.now()}-A1!`;
const EMAILS = ["hook-password@test.local", "hook-signup@test.local"];
const REFUSAL = "MGM signs in by email link only. Ask for a sign-in link on the sign-in page.";

/** The hook's answer to one event, called as the database owner. */
function hook(event: object): Record<string, unknown> {
  const literal = JSON.stringify(event).replaceAll("'", "''");
  const result = runAsDatabaseOwner(`SELECT public.fn_auth_access_token_hook('${literal}'::jsonb) AS answer`);
  expect(result.ok, result.output).toBe(true);
  const rows = JSON.parse(result.stdout) as { answer: Record<string, unknown> | string }[];
  const answer = rows[0].answer;
  return typeof answer === "string" ? JSON.parse(answer) : answer;
}

const event = (method: string, amr: string[]) => ({
  user_id: "00000000-0000-4000-8000-0000000000aa",
  authentication_method: method,
  claims: { sub: "00000000-0000-4000-8000-0000000000aa", role: "authenticated", amr: amr.map((m) => ({ method: m, timestamp: 1 })) },
});

const anonClient = () =>
  createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });

describe.skipIf(skip)("access-token hook (RFC #186)", () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [], userEmails: EMAILS });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestData({ orgIds: [], userEmails: EMAILS });
  });

  it.each([
    ["password", ["password"]],
    ["recovery", ["recovery"]],
    ["token_refresh", ["password"]],
    ["token_refresh", ["otp", "recovery"]],
  ])("refuses %s with amr %j", (method, amr) => {
    expect(hook(event(method, amr))).toEqual({ error: { http_code: 403, message: REFUSAL } });
  });

  it.each([
    ["otp", ["otp"]],
    ["token_refresh", ["otp"]],
    ["magiclink", ["magiclink"]],
  ])("returns %s with amr %j unchanged", (method, amr) => {
    const input = event(method, amr);
    expect(hook(input)).toEqual(input);
  });

  it("returns an event without an amr claim unchanged", () => {
    const input = { authentication_method: "otp", claims: { sub: "x" } };
    expect(hook(input)).toEqual(input);
  });

  it("lets no MGM role call it", async () => {
    const svc = await serviceClient();
    const { error } = await svc.rpc("fn_auth_access_token_hook", { event: event("otp", ["otp"]) });
    expect(
      error?.code === "42501" || error?.message?.toLowerCase().includes("permission denied") || error?.code === "PGRST202"
    ).toBe(true);
    const grants = runAsDatabaseOwner(
      "SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.fn_auth_access_token_hook(jsonb)'::regprocedure"
    );
    expect(grants.ok, grants.output).toBe(true);
    const acl = (JSON.parse(grants.stdout) as { acl: string }[])[0].acl;
    expect(acl).toContain("supabase_auth_admin=X/");
    expect(acl).not.toMatch(/(^|[{,])(anon|authenticated|service_role)?=X/);
  });

  it("gives a password sign-in no session", async () => {
    const svc = await serviceClient();
    const { error: createError } = await svc.auth.admin.createUser({ email: EMAILS[0], password: PASSWORD, email_confirm: true });
    expect(createError).toBeNull();
    const { data, error } = await anonClient().auth.signInWithPassword({ email: EMAILS[0], password: PASSWORD });
    expect(data.session).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.message).toBe(REFUSAL);
  });

  it("gives a password sign-up no session", async () => {
    const { data, error } = await anonClient().auth.signUp({ email: EMAILS[1], password: PASSWORD });
    expect(data.session).toBeNull();
    expect(error?.message).toBe(REFUSAL);
  });

  // The same link /api/auth/sign-in-link emails and
  // scripts/emergency-sign-in-link.py hands over: generate_link type
  // magiclink, then /auth/confirm's verifyOtp({ token_hash, type: "email" }).
  it("signs in by emailed or emergency link, and refreshes that session", async () => {
    const svc = await serviceClient();
    const { data: link, error: linkError } = await svc.auth.admin.generateLink({ type: "magiclink", email: EMAILS[0] });
    expect(linkError).toBeNull();
    const client = anonClient();
    const { data, error } = await client.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
    expect(error).toBeNull();
    expect(data.session?.access_token).toEqual(expect.any(String));
    const refreshed = await client.auth.refreshSession({ refresh_token: data.session!.refresh_token });
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session?.access_token).toEqual(expect.any(String));
  });
});
