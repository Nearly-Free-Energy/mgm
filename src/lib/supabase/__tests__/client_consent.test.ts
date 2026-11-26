/**
 * client_consent.test.ts — #271, ADR-008 decisions 2 and 3; migration
 * 20261126150000 (fn_client_authorization_read, fn_client_approval_record,
 * mgm_client_approvals.authorization_id).
 *
 * Against the local Supabase, with real authorizations made by Supabase
 * Auth's own authorize endpoint (supabase/config.toml turns the OAuth server
 * on):
 *   1. The catalogs: both functions are SECURITY DEFINER with a pinned
 *      search_path, and only service_role may run them; the database API
 *      refuses a signed-in user and the anon key.
 *   2. The shape of auth.oauth_authorizations the functions read, as the
 *      Supabase Auth version CI runs defines it. A change fails here first.
 *   3. Each answer: ok, unlisted, unknown (no such id, no user, or bound to
 *      someone else), expired, answered; only ok writes a record.
 *   4. One record per authorization: a second call writes nothing, and
 *      another person cannot record an authorization someone else recorded.
 *
 * The page and route around these, and a sign-in that uses the record, are
 * src/app/api/auth/oauth/approvals/__tests__/sign-in.db.test.ts.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import {
  LOCAL_SUPABASE_URL,
  assertEnvironmentReady,
  cleanupTestData,
  clientAs,
  mintServiceRoleJwt,
  mintUserJwt,
  runAsDatabaseOwner,
  serviceClient,
  shouldSkip,
  testAnonKey,
} from "./rls.helpers";

const skip = shouldSkip();
const EMAILS = ["client-consent-a@test.local", "client-consent-b@test.local"];
const REDIRECT_URI = "http://127.0.0.1:3000/oauth/code";
const FUNCTIONS = ["fn_client_authorization_read", "fn_client_approval_record"] as const;

type Answer = { outcome: string; client_id: string | null; kind: string | null; label: string | null };

function ownerRows<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  expect(result.ok, result.output).toBe(true);
  return JSON.parse(result.stdout) as T[];
}

async function admin(method: string, path: string, json?: object) {
  const key = await mintServiceRoleJwt();
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

/** A new pending authorization for `clientId`, as `mgm login` starts one. */
async function authorize(clientId: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(24).toString("base64url"),
    scope: "email",
  });
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/oauth/authorize?${query}`, {
    headers: { apikey: testAnonKey()! },
    redirect: "manual",
  });
  expect(res.status, await res.text()).toBeGreaterThanOrEqual(300);
  const id = new URL(res.headers.get("location")!).searchParams.get("authorization_id");
  expect(id).toBeTruthy();
  return id!;
}

/** Binds the authorization to the person, as Supabase Auth does on their first look at it. */
async function look(authorizationId: string, email: string) {
  const svc = await serviceClient();
  const { data: link, error } = await svc.auth.admin.generateLink({ type: "magiclink", email });
  expect(error).toBeNull();
  const browser = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const verified = await browser.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
  expect(verified.error).toBeNull();
  const details = await browser.auth.oauth.getAuthorizationDetails(authorizationId);
  expect(details.error).toBeNull();
}

async function call(fn: (typeof FUNCTIONS)[number], authorizationId: string | null, userId: string | null): Promise<Answer> {
  const svc = await serviceClient();
  const { data, error } = await svc.rpc(fn, { _authorization_id: authorizationId, _user_id: userId });
  expect(error).toBeNull();
  const rows = data as Answer[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

function records(authorizationId: string): { user_id: string; client_id: string; used: boolean }[] {
  return ownerRows(
    `SELECT user_id, client_id, used_at IS NOT NULL AS used FROM public.mgm_client_approvals
      WHERE authorization_id = '${authorizationId}' ORDER BY created_at`
  );
}

const refused = (outcome: string): Answer => ({ outcome, client_id: null, kind: null, label: null });

let userA = "";
let userB = "";
let listed = "";
let unlisted = "";

describe.skipIf(skip)("client consent: the consent page's read and record (#271)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [], userEmails: EMAILS });
    const svc = await serviceClient();
    for (const email of EMAILS) {
      const { data, error } = await svc.auth.admin.createUser({ email, email_confirm: true });
      expect(error).toBeNull();
      if (email === EMAILS[0]) userA = data.user!.id;
      else userB = data.user!.id;
    }
    for (const name of ["consent-test-listed", "consent-test-unlisted"]) {
      const created = await admin("POST", "/admin/oauth/clients", {
        client_name: name,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      if (name === "consent-test-listed") listed = created.body.client_id as string;
      else unlisted = created.body.client_id as string;
    }
    const { error } = await svc.from("mgm_clients").insert({ client_id: listed, kind: "operator", label: "Test CLI" });
    expect(error).toBeNull();
  }, 60_000);

  afterAll(async () => {
    const svc = await serviceClient();
    if (listed) await svc.from("mgm_clients").delete().eq("client_id", listed);
    for (const id of [listed, unlisted].filter(Boolean)) await admin("DELETE", `/admin/oauth/clients/${id}`);
    await cleanupTestData({ orgIds: [], userEmails: EMAILS });
  }, 60_000);

  // ── 1. Catalogs ───────────────────────────────────────────────────────────

  it("defines both functions SECURITY DEFINER with search_path public, pg_temp, runnable by service_role only", () => {
    const rows = ownerRows<{ name: string; definer: boolean; config: string[] | null; volatility: string; roles: Record<string, boolean>; public_execute: boolean }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config, p.provolatile::text AS volatility,
              jsonb_build_object(
                'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
                'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
                'supabase_auth_admin', has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE')
              ) AS roles,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN ('${FUNCTIONS.join("', '")}')
        ORDER BY p.proname`
    );
    expect(rows.map((r) => r.name)).toEqual(["fn_client_approval_record", "fn_client_authorization_read"]);
    for (const row of rows) {
      expect(row.definer, row.name).toBe(true);
      expect(row.config, row.name).toEqual(["search_path=public, pg_temp"]);
      expect(row.public_execute, row.name).toBe(false);
      expect(row.roles, row.name).toEqual({
        service_role: true,
        authenticated: false,
        anon: false,
        supabase_auth_admin: false,
      });
    }
    expect(Object.fromEntries(rows.map((r) => [r.name, r.volatility]))).toEqual({
      fn_client_approval_record: "v",
      fn_client_authorization_read: "s",
    });
  });

  it("refuses a signed-in user's token and the anon key through the database API", async () => {
    const id = await authorize(listed);
    const user = clientAs(await mintUserJwt(userA));
    const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false } });
    for (const db of [user, anon]) {
      for (const fn of FUNCTIONS) {
        const { data, error } = await db.rpc(fn, { _authorization_id: id, _user_id: userA });
        expect(data, fn).toBeNull();
        expect(
          error?.code === "42501" || error?.message?.toLowerCase().includes("permission denied") || error?.code === "PGRST202",
          `${fn}: ${JSON.stringify(error)}`
        ).toBe(true);
      }
    }
    expect(records(id)).toEqual([]);
  }, 30_000);

  // ── 2. The shape of Supabase Auth's table ─────────────────────────────────

  it("reads auth.oauth_authorizations as Supabase Auth defines it", () => {
    const columns = ownerRows<{ column_name: string; udt_name: string }>(
      `SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'oauth_authorizations'
          AND column_name IN ('authorization_id', 'client_id', 'user_id', 'status', 'expires_at')
        ORDER BY column_name`
    );
    expect(columns).toEqual([
      { column_name: "authorization_id", udt_name: "text" },
      { column_name: "client_id", udt_name: "uuid" },
      { column_name: "expires_at", udt_name: "timestamptz" },
      { column_name: "status", udt_name: "oauth_authorization_status" },
      { column_name: "user_id", udt_name: "uuid" },
    ]);
    const labels = ownerRows<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'auth' AND t.typname = 'oauth_authorization_status' ORDER BY e.enumsortorder`
    );
    expect(labels.map((l) => l.label)).toEqual(["pending", "approved", "denied", "expired"]);
  });

  // ── 3. Each answer ────────────────────────────────────────────────────────

  it("names a pending sign-in's listed client to the person, and writes nothing on a read", async () => {
    const id = await authorize(listed);
    expect(await call("fn_client_authorization_read", id, userA)).toEqual({
      outcome: "ok",
      client_id: listed,
      kind: "operator",
      label: "Test CLI",
    });
    expect(records(id)).toEqual([]);
  }, 30_000);

  it("answers unlisted for a client mgm_clients does not list, and writes nothing", async () => {
    const id = await authorize(unlisted);
    for (const fn of FUNCTIONS) expect(await call(fn, id, userA)).toEqual(refused("unlisted"));
    expect(records(id)).toEqual([]);
  }, 30_000);

  it("answers unknown for no such authorization, and for no person", async () => {
    const id = await authorize(listed);
    for (const fn of FUNCTIONS) {
      expect(await call(fn, "A".repeat(32), userA)).toEqual(refused("unknown"));
      expect(await call(fn, null, userA)).toEqual(refused("unknown"));
      expect(await call(fn, id, null)).toEqual(refused("unknown"));
    }
    expect(records(id)).toEqual([]);
  }, 30_000);

  it("answers unknown to a person other than the one Supabase Auth bound the sign-in to, and ok to that one", async () => {
    const id = await authorize(listed);
    await look(id, EMAILS[1]);
    for (const fn of FUNCTIONS) expect(await call(fn, id, userA)).toEqual(refused("unknown"));
    expect(records(id)).toEqual([]);
    expect((await call("fn_client_approval_record", id, userB)).outcome).toBe("ok");
    expect(records(id)).toEqual([{ user_id: userB, client_id: listed, used: false }]);
  }, 30_000);

  it("answers expired once the authorization's time is up, or it is marked expired", async () => {
    const late = await authorize(listed);
    ownerRows(`UPDATE auth.oauth_authorizations SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE authorization_id = '${late}' RETURNING 1 AS n`);
    const marked = await authorize(listed);
    ownerRows(`UPDATE auth.oauth_authorizations SET status = 'expired' WHERE authorization_id = '${marked}' RETURNING 1 AS n`);
    for (const id of [late, marked]) {
      for (const fn of FUNCTIONS) expect(await call(fn, id, userA)).toEqual(refused("expired"));
      expect(records(id)).toEqual([]);
    }
  }, 30_000);

  it("answers answered for a sign-in already approved or denied", async () => {
    for (const status of ["approved", "denied"]) {
      const id = await authorize(listed);
      ownerRows(`UPDATE auth.oauth_authorizations SET status = '${status}' WHERE authorization_id = '${id}' RETURNING 1 AS n`);
      for (const fn of FUNCTIONS) expect(await call(fn, id, userA)).toEqual(refused("answered"));
      expect(records(id)).toEqual([]);
    }
  }, 30_000);

  // ── 4. One record per authorization ───────────────────────────────────────

  it("writes one record per authorization, however often it is asked", async () => {
    const id = await authorize(listed);
    const ok = { outcome: "ok", client_id: listed, kind: "operator", label: "Test CLI" };
    expect(await call("fn_client_approval_record", id, userA)).toEqual(ok);
    expect(await call("fn_client_approval_record", id, userA)).toEqual(ok);
    expect(records(id)).toEqual([{ user_id: userA, client_id: listed, used: false }]);

    // Two sign-ins of the same client by the same person each get their own.
    const second = await authorize(listed);
    expect(await call("fn_client_approval_record", second, userA)).toEqual(ok);
    expect(records(second)).toEqual([{ user_id: userA, client_id: listed, used: false }]);
  }, 30_000);

  it("does not record, for a second person, a sign-in the first person recorded before Supabase Auth bound it", async () => {
    const id = await authorize(listed);
    expect((await call("fn_client_approval_record", id, userA)).outcome).toBe("ok");
    expect(await call("fn_client_approval_record", id, userB)).toEqual(refused("unknown"));
    expect(records(id)).toEqual([{ user_id: userA, client_id: listed, used: false }]);
  }, 30_000);
});
