/**
 * client_sessions_end.test.ts — #297, ADR-008 decision 5; migration
 * 20261126170000 (fn_client_sessions_end).
 *
 * Against the local Supabase, with real client sessions made by Supabase
 * Auth's own OAuth server (authorize, the person's consent with their
 * browser session, the approval record MGM's consent page writes, and the
 * code exchanged with its PKCE verifier), as `mgm login` makes them:
 *   1. The catalogs: SECURITY DEFINER with a pinned search_path, and only
 *      service_role may run it (not anon, authenticated, supabase_auth_admin,
 *      or mgm_agent where #274's role exists); the database API refuses a
 *      signed-in user and the anon key.
 *   2. The shape of auth.sessions and auth.oauth_consents the function
 *      writes, and the cascades that take a session's refresh tokens with
 *      it, as the Supabase Auth version CI runs defines them. A change fails
 *      here first.
 *   3. With a session: only that session ends (its refresh fails, the
 *      person's other session of the client, their other client, their
 *      browser session and another person's session all keep working); a
 *      session of another person, or of another client of the same person,
 *      ends nothing.
 *   4. With no session: every session of that person for the client ends,
 *      their consent is revoked (the next sign-in asks again), and an unused
 *      approval record for that client is used up; nothing else changes.
 *
 * The route that calls it for `mgm logout` is
 * src/app/api/auth/logout/__tests__/logout.db.test.ts.
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
const EMAILS = ["client-sessions-end-a@test.local", "client-sessions-end-b@test.local"];
const REDIRECT_URI = "http://127.0.0.1:3000/oauth/code";
const FUNCTION = "fn_client_sessions_end";

type Person = { userId: string; browserToken: string };
type Session = { sessionId: string; accessToken: string; refreshToken: string; clientId: string };
type Answer = { outcome: string; sessions_ended: number; consent_revoked: boolean };

function ownerRows<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  expect(result.ok, result.output).toBe(true);
  return JSON.parse(result.stdout) as T[];
}

async function auth(method: string, path: string, opts: { token?: string; json?: object; form?: Record<string, string>; apikey?: string } = {}) {
  const headers: Record<string, string> = { apikey: opts.apikey ?? testAnonKey()! };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1${path}`, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { text };
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

async function admin(method: string, path: string, json?: object) {
  const key = await mintServiceRoleJwt();
  return auth(method, path, { token: key, apikey: key, json });
}

const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;

/** The person's browser session, made as MGM makes one: an emailed link. */
async function browserFor(userId: string, email: string): Promise<Person> {
  const svc = await serviceClient();
  const { data: link, error } = await svc.auth.admin.generateLink({ type: "magiclink", email });
  expect(error).toBeNull();
  const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error: verifyError } = await anon.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
  expect(verifyError).toBeNull();
  return { userId, browserToken: data.session!.access_token };
}

/** Starts a sign-in for `clientId`; answers whether Supabase Auth asked for consent, and the code once given. */
async function authorizeFor(person: Person, clientId: string) {
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
  const authorize = await auth("GET", `/oauth/authorize?${query}`);
  expect(authorize.status, JSON.stringify(authorize.body)).toBeGreaterThanOrEqual(300);
  const authorizationId = new URL(authorize.headers.get("location")!).searchParams.get("authorization_id")!;
  const details = await auth("GET", `/oauth/authorizations/${authorizationId}`, { token: person.browserToken });
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  return { verifier, authorizationId, askedForConsent: !details.body.redirect_url, redirect: details.body.redirect_url as string | undefined };
}

/** A whole client sign-in for `person`, ending in a session of `clientId`. */
async function signIn(person: Person, clientId: string): Promise<Session> {
  const started = await authorizeFor(person, clientId);
  let redirect = started.redirect;
  if (!redirect) {
    const consent = await auth("POST", `/oauth/authorizations/${started.authorizationId}/consent`, {
      token: person.browserToken,
      json: { action: "approve" },
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(200);
    redirect = consent.body.redirect_url as string;
  }
  // The record MGM's consent page writes when the person clicks (ADR-008 decision 2).
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_client_approvals").insert({ user_id: person.userId, client_id: clientId });
  expect(error).toBeNull();
  const token = await auth("POST", "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: new URL(redirect).searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: started.verifier,
    },
  });
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  const accessToken = token.body.access_token as string;
  const sessionId = claimsOf(accessToken).session_id as string;
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  return { sessionId, accessToken, refreshToken: token.body.refresh_token as string, clientId };
}

/** Refreshes `session` as the CLI does; on success its tokens are the new ones. */
async function refresh(session: Session): Promise<number> {
  const res = await auth("POST", "/oauth/token", {
    form: { grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: session.clientId },
  });
  if (res.status === 200) {
    session.accessToken = res.body.access_token as string;
    session.refreshToken = res.body.refresh_token as string;
  }
  return res.status;
}

/** Whether Supabase Auth still answers for an access token. */
async function accepted(accessToken: string): Promise<boolean> {
  return (await auth("GET", "/user", { token: accessToken })).status === 200;
}

async function end(userId: string | null, clientId: string | null, sessionId?: string | null): Promise<Answer> {
  const svc = await serviceClient();
  const args: Record<string, string | null> = { _user_id: userId, _client_id: clientId };
  if (sessionId !== undefined) args._session_id = sessionId;
  const { data, error } = await svc.rpc(FUNCTION, args);
  expect(error, JSON.stringify(error)).toBeNull();
  const rows = data as Answer[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

function sessionIds(userId: string, clientId: string): string[] {
  return ownerRows<{ id: string }>(
    `SELECT id FROM auth.sessions WHERE user_id = '${userId}' AND oauth_client_id = '${clientId}' ORDER BY id`,
  ).map((row) => row.id);
}

function consentRevoked(userId: string, clientId: string): boolean | null {
  const rows = ownerRows<{ revoked: boolean }>(
    `SELECT revoked_at IS NOT NULL AS revoked FROM auth.oauth_consents WHERE user_id = '${userId}' AND client_id = '${clientId}'`,
  );
  return rows.length === 0 ? null : rows[0].revoked;
}

let personA: Person;
let personB: Person;
let clientOne = "";
let clientTwo = "";

describe.skipIf(skip)("fn_client_sessions_end: ending a person's client (#297)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [], userEmails: EMAILS });
    const svc = await serviceClient();
    const ids: string[] = [];
    for (const email of EMAILS) {
      const { data, error } = await svc.auth.admin.createUser({ email, email_confirm: true });
      expect(error).toBeNull();
      ids.push(data.user!.id);
    }
    personA = await browserFor(ids[0], EMAILS[0]);
    personB = await browserFor(ids[1], EMAILS[1]);
    for (const name of ["sessions-end-one", "sessions-end-two"]) {
      const created = await admin("POST", "/admin/oauth/clients", {
        client_name: name,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.client_id as string;
      if (name === "sessions-end-one") clientOne = id;
      else clientTwo = id;
      const { error } = await svc.from("mgm_clients").insert({ client_id: id, kind: "operator", label: name });
      expect(error).toBeNull();
    }
  }, 90_000);

  afterAll(async () => {
    const svc = await serviceClient();
    for (const id of [clientOne, clientTwo].filter(Boolean)) {
      await svc.from("mgm_clients").delete().eq("client_id", id);
      await admin("DELETE", `/admin/oauth/clients/${id}`);
    }
    await cleanupTestData({ orgIds: [], userEmails: EMAILS });
  }, 60_000);

  // ── 1. Catalogs ───────────────────────────────────────────────────────────

  it("is SECURITY DEFINER with search_path public, pg_temp, runnable by service_role only", () => {
    const rows = ownerRows<{ definer: boolean; config: string[] | null; volatility: string; roles: Record<string, boolean | null>; public_execute: boolean; args: string }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, p.provolatile::text AS volatility,
              pg_get_function_identity_arguments(p.oid) AS args,
              jsonb_build_object(
                'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
                'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
                'supabase_auth_admin', has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE'),
                -- #274's assistant role, where this database has it.
                'mgm_agent', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mgm_agent')
                                  THEN has_function_privilege('mgm_agent', p.oid, 'EXECUTE') END
              ) AS roles,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '${FUNCTION}'`,
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.args).toBe("_user_id uuid, _client_id uuid, _session_id uuid");
    expect(row.definer).toBe(true);
    expect(row.config).toEqual(["search_path=public, pg_temp"]);
    expect(row.volatility).toBe("v");
    expect(row.public_execute).toBe(false);
    expect(row.roles.service_role).toBe(true);
    expect(row.roles.authenticated).toBe(false);
    expect(row.roles.anon).toBe(false);
    expect(row.roles.supabase_auth_admin).toBe(false);
    expect(row.roles.mgm_agent === null || row.roles.mgm_agent === false).toBe(true);
  });

  it("refuses a signed-in user's token and the anon key through the database API, and ends nothing", async () => {
    const session = await signIn(personA, clientOne);
    const user = clientAs(await mintUserJwt(personA.userId));
    const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false } });
    for (const db of [user, anon]) {
      const { data, error } = await db.rpc(FUNCTION, {
        _user_id: personA.userId,
        _client_id: clientOne,
        _session_id: session.sessionId,
      });
      expect(data).toBeNull();
      expect(
        error?.code === "42501" || error?.message?.toLowerCase().includes("permission denied") || error?.code === "PGRST202",
        JSON.stringify(error),
      ).toBe(true);
    }
    expect(sessionIds(personA.userId, clientOne)).toContain(session.sessionId);
    expect(await refresh(session)).toBe(200);
  });

  // ── 2. The shape of Supabase Auth's tables ────────────────────────────────

  it("writes auth.sessions and auth.oauth_consents as Supabase Auth defines them", () => {
    const columns = ownerRows<{ table_name: string; column_name: string; udt_name: string }>(
      `SELECT table_name, column_name, udt_name FROM information_schema.columns
        WHERE table_schema = 'auth'
          AND ((table_name = 'sessions' AND column_name IN ('id', 'user_id', 'oauth_client_id'))
            OR (table_name = 'oauth_consents' AND column_name IN ('id', 'user_id', 'client_id', 'scopes', 'granted_at', 'revoked_at')))
        ORDER BY table_name, column_name`,
    );
    expect(columns).toEqual([
      { table_name: "oauth_consents", column_name: "client_id", udt_name: "uuid" },
      { table_name: "oauth_consents", column_name: "granted_at", udt_name: "timestamptz" },
      { table_name: "oauth_consents", column_name: "id", udt_name: "uuid" },
      { table_name: "oauth_consents", column_name: "revoked_at", udt_name: "timestamptz" },
      { table_name: "oauth_consents", column_name: "scopes", udt_name: "text" },
      { table_name: "oauth_consents", column_name: "user_id", udt_name: "uuid" },
      { table_name: "sessions", column_name: "id", udt_name: "uuid" },
      { table_name: "sessions", column_name: "oauth_client_id", udt_name: "uuid" },
      { table_name: "sessions", column_name: "user_id", udt_name: "uuid" },
    ]);
    // A session's refresh tokens go with it, so a refresh after it ends fails.
    const cascades = ownerRows<{ tbl: string; del: string }>(
      `SELECT conrelid::regclass::text AS tbl, confdeltype::text AS del FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'auth.sessions'::regclass AND conrelid = 'auth.refresh_tokens'::regclass`,
    );
    expect(cascades).toEqual([{ tbl: "auth.refresh_tokens", del: "c" }]);
    // One consent per person and client, as the function's UPDATE assumes.
    const unique = ownerRows<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'auth.oauth_consents'::regclass AND contype = 'u'`,
    );
    expect(unique).toEqual([{ def: "UNIQUE (user_id, client_id)" }]);
  });

  // ── 3. One session ────────────────────────────────────────────────────────

  it("ends only the named session, and leaves the consent", async () => {
    const mine = await signIn(personA, clientOne);
    const myOther = await signIn(personA, clientOne);
    const myOtherClient = await signIn(personA, clientTwo);
    const theirs = await signIn(personB, clientOne);

    expect(await end(personA.userId, clientOne, mine.sessionId)).toEqual({ outcome: "ended", sessions_ended: 1, consent_revoked: false });

    expect(sessionIds(personA.userId, clientOne)).not.toContain(mine.sessionId);
    expect(await refresh(mine)).toBeGreaterThanOrEqual(400);
    expect(await accepted(mine.accessToken)).toBe(false);

    for (const session of [myOther, myOtherClient, theirs]) {
      expect(await accepted(session.accessToken)).toBe(true);
      expect(await refresh(session)).toBe(200);
    }
    expect(await accepted(personA.browserToken)).toBe(true);
    expect(consentRevoked(personA.userId, clientOne)).toBe(false);

    // Already gone: nothing more to end.
    expect(await end(personA.userId, clientOne, mine.sessionId)).toEqual({ outcome: "not_found", sessions_ended: 0, consent_revoked: false });
  });

  it("ends nothing for another person's session, or the same person's session of another client", async () => {
    const theirs = await signIn(personB, clientOne);
    const myOtherClient = await signIn(personA, clientTwo);
    const before = [...sessionIds(personA.userId, clientOne), ...sessionIds(personB.userId, clientOne), ...sessionIds(personA.userId, clientTwo)];

    expect(await end(personA.userId, clientOne, theirs.sessionId)).toEqual({ outcome: "not_found", sessions_ended: 0, consent_revoked: false });
    expect(await end(personA.userId, clientOne, myOtherClient.sessionId)).toEqual({ outcome: "not_found", sessions_ended: 0, consent_revoked: false });

    const after = [...sessionIds(personA.userId, clientOne), ...sessionIds(personB.userId, clientOne), ...sessionIds(personA.userId, clientTwo)];
    expect(after).toEqual(before);
    expect(await refresh(theirs)).toBe(200);
    expect(await refresh(myOtherClient)).toBe(200);
  });

  it("refuses a call that names no person or no client", async () => {
    const svc = await serviceClient();
    for (const args of [
      { _user_id: null, _client_id: clientOne },
      { _user_id: personA.userId, _client_id: null },
    ]) {
      const { data, error } = await svc.rpc(FUNCTION, args);
      expect(data).toBeNull();
      expect(error?.code, JSON.stringify(error)).toBe("22004");
    }
  });

  // ── 4. Every session, and the consent ─────────────────────────────────────

  it("with no session, ends every session of that person for the client, revokes the consent and uses up an unused approval", async () => {
    const first = await signIn(personA, clientOne);
    const second = await signIn(personA, clientOne);
    const myOtherClient = await signIn(personA, clientTwo);
    const theirs = await signIn(personB, clientOne);
    // A sign-in in flight: the consent page has recorded an approval the hook has not used.
    const svc = await serviceClient();
    const { data: pending, error } = await svc
      .from("mgm_client_approvals")
      .insert({ user_id: personA.userId, client_id: clientOne })
      .select("id")
      .single();
    expect(error).toBeNull();

    const count = sessionIds(personA.userId, clientOne).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(await end(personA.userId, clientOne)).toEqual({ outcome: "ended", sessions_ended: count, consent_revoked: true });

    expect(sessionIds(personA.userId, clientOne)).toEqual([]);
    for (const session of [first, second]) {
      expect(await refresh(session)).toBeGreaterThanOrEqual(400);
      expect(await accepted(session.accessToken)).toBe(false);
    }
    expect(consentRevoked(personA.userId, clientOne)).toBe(true);
    expect(
      ownerRows<{ used: boolean }>(`SELECT used_at IS NOT NULL AS used FROM public.mgm_client_approvals WHERE id = '${pending!.id}'`),
    ).toEqual([{ used: true }]);

    // Nothing else changed.
    expect(await refresh(myOtherClient)).toBe(200);
    expect(await refresh(theirs)).toBe(200);
    expect(consentRevoked(personA.userId, clientTwo)).toBe(false);
    expect(consentRevoked(personB.userId, clientOne)).toBe(false);
    expect(await accepted(personA.browserToken)).toBe(true);

    // The next sign-in asks for consent again.
    expect((await authorizeFor(personA, clientOne)).askedForConsent).toBe(true);
    // And ending it again finds nothing more.
    expect(await end(personA.userId, clientOne)).toEqual({ outcome: "ended", sessions_ended: 0, consent_revoked: false });
  });
});
