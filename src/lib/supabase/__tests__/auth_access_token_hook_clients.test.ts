/**
 * auth_access_token_hook_clients.test.ts — #270, ADR-008 decisions 1, 2
 * and 7; migrations 20261126090000 (mgm_clients, mgm_client_approvals) and
 * 20261126090100 (the hook's rules for clients that are not a browser).
 *
 * 1. Direct calls of fn_auth_access_token_hook, as the database owner, with
 *    crafted events: every rule, one at a time.
 * 2. The catalogs: the hook stays SECURITY INVOKER and is VOLATILE, both
 *    tables have row-level security on, and supabase_auth_admin holds exactly
 *    the grants and policies the hook needs, anon and authenticated none.
 * 3. End to end through Supabase Auth's OAuth server on the local Supabase,
 *    where supabase/config.toml turns it on and Supabase Auth runs the hook
 *    as supabase_auth_admin. Only this part catches a missing grant or
 *    policy: the direct calls run as the owner, who bypasses both.
 *
 * Browser sign-in through the hook (the email and emergency links, and the
 * password refusal) is auth_access_token_hook.test.ts.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

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
const KIND_CLAIM = "mgm_client_kind";
const EMAILS = ["hook-client-a@test.local", "hook-client-b@test.local"];
const REDIRECT_URI = "http://127.0.0.1:3000/oauth/test-code";

const NOT_ACCEPTED = "MGM does not accept this app.";
const REFUSED = "MGM refused this sign-in.";
const NO_OPENID = "MGM gives this app an access token only. Sign in without the openid scope.";
const NOT_APPROVED = "Approve this sign-in on MGM's consent page, then try again.";
const refusal = (message: string) => ({ error: { http_code: 403, message } });

// ── Database-owner helpers ─────────────────────────────────────────────────

function ownerRows<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  expect(result.ok, result.output).toBe(true);
  return JSON.parse(result.stdout) as T[];
}

/** The hook's answer to one event, called as the database owner. */
function hook(event: object): Record<string, unknown> {
  const literal = JSON.stringify(event).replaceAll("'", "''");
  const answer = ownerRows<{ answer: Record<string, unknown> | string }>(
    `SELECT public.fn_auth_access_token_hook('${literal}'::jsonb) AS answer`
  )[0].answer;
  return typeof answer === "string" ? JSON.parse(answer) : answer;
}

/** The kind of event Supabase Auth v2.198.0 sends for an OAuth client. */
function clientEvent(
  method: string,
  userId: string,
  clientId: string,
  opts: { scope?: string; role?: string } = {}
) {
  return {
    user_id: userId,
    authentication_method: method,
    claims: {
      aud: "authenticated",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
      sub: userId,
      email: "hook-client-a@test.local",
      phone: "",
      role: opts.role ?? "authenticated",
      aal: "aal1",
      session_id: "00000000-0000-4000-8000-0000000000ee",
      is_anonymous: false,
      amr: [{ method: "oauth_provider/authorization_code", timestamp: 1 }],
      client_id: clientId,
      scope: opts.scope ?? "email",
    },
  };
}

function withKind(event: ReturnType<typeof clientEvent>, kind: string) {
  return { ...event, claims: { ...event.claims, [KIND_CLAIM]: kind } };
}

// ── Supabase Auth helpers ──────────────────────────────────────────────────

type AuthAnswer = { status: number; headers: Headers; body: Record<string, unknown> };

async function auth(
  method: string,
  path: string,
  opts: { token?: string; json?: object; form?: Record<string, string>; apikey?: string } = {}
): Promise<AuthAnswer> {
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

async function admin(method: string, path: string, json?: object): Promise<AuthAnswer> {
  const key = await mintServiceRoleJwt();
  return auth(method, path, { token: key, apikey: key, json });
}

const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;

const anonClient = () =>
  createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });

/** A browser session, made the way MGM signs people in: an emailed link. */
async function browserSession(email: string): Promise<string> {
  const svc = await serviceClient();
  const { data: link, error } = await svc.auth.admin.generateLink({ type: "magiclink", email });
  expect(error).toBeNull();
  const { data, error: verifyError } = await anonClient().auth.verifyOtp({
    token_hash: link.properties!.hashed_token,
    type: "email",
  });
  expect(verifyError).toBeNull();
  return data.session!.access_token;
}

/**
 * Authorization code with PKCE, up to the code: the authorize request, then
 * the person's approval with their browser session. Supabase approves a
 * client the person approved before without asking again.
 */
async function codeFor(clientId: string, browserToken: string, scope: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    scope,
  });
  const authorize = await auth("GET", `/oauth/authorize?${query}`);
  expect(authorize.status, JSON.stringify(authorize.body)).toBeGreaterThanOrEqual(300);
  expect(authorize.status).toBeLessThan(400);
  const location = new URL(authorize.headers.get("location")!);
  expect(location.pathname).toBe("/oauth/consent");
  const authorizationId = location.searchParams.get("authorization_id")!;
  expect(authorizationId).toBeTruthy();

  const details = await auth("GET", `/oauth/authorizations/${authorizationId}`, { token: browserToken });
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  let redirect = details.body.redirect_url as string | undefined;
  if (!redirect) {
    const consent = await auth("POST", `/oauth/authorizations/${authorizationId}/consent`, {
      token: browserToken,
      json: { action: "approve" },
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(200);
    redirect = consent.body.redirect_url as string;
  }
  const code = new URL(redirect).searchParams.get("code")!;
  expect(code).toBeTruthy();
  return { code, verifier };
}

function exchange(clientId: string, code: string, verifier: string) {
  return auth("POST", "/oauth/token", {
    form: { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT_URI, code_verifier: verifier },
  });
}

function refresh(clientId: string, refreshToken: string) {
  return auth("POST", "/oauth/token", {
    form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
  });
}

function clientSessions(userId: string, clientId: string): number {
  return ownerRows<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth.sessions WHERE user_id = '${userId}' AND oauth_client_id = '${clientId}'`
  )[0].n;
}

function approvals(userId: string, clientId: string): { used: boolean }[] {
  return ownerRows<{ used: boolean }>(
    `SELECT used_at IS NOT NULL AS used FROM public.mgm_client_approvals
      WHERE user_id = '${userId}' AND client_id = '${clientId}' ORDER BY created_at`
  );
}

async function record(userId: string, clientId: string, createdAt?: string, usedAt?: string) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_client_approvals").insert({
    user_id: userId,
    client_id: clientId,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(usedAt ? { used_at: usedAt } : {}),
  });
  expect(error).toBeNull();
}

async function list(clientId: string, kind: "operator" | "agent", label: string) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_clients").insert({ client_id: clientId, kind, label });
  expect(error).toBeNull();
}

async function unlist(clientId: string) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_clients").delete().eq("client_id", clientId);
  expect(error).toBeNull();
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const OPERATOR = randomUUID();
const AGENT = randomUUID();
const UNLISTED = randomUUID();
let userA = "";
let userB = "";
let listedClient = "";
let unlistedClient = "";

// Each direct call starts the supabase CLI once (runAsDatabaseOwner), about a
// second apiece, so a test of several calls outlasts vitest's default 5s.
describe.skipIf(skip)("access-token hook: clients that are not a browser (#270)", { timeout: 120_000 }, () => {
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
    await list(OPERATOR, "operator", "Test operator");
    await list(AGENT, "agent", "Test agent");

    // Two public clients, registered as docs/setup.md registers MGM's.
    for (const name of ["hook-test-listed", "hook-test-unlisted"]) {
      const created = await admin("POST", "/admin/oauth/clients", {
        client_name: name,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.client_secret ?? null).toBeNull();
      if (name === "hook-test-listed") listedClient = created.body.client_id as string;
      else unlistedClient = created.body.client_id as string;
    }
    await list(listedClient, "operator", "Test CLI");
  }, 60_000);

  afterAll(async () => {
    const svc = await serviceClient();
    await svc.from("mgm_clients").delete().in("client_id", [OPERATOR, AGENT, listedClient].filter(Boolean));
    for (const id of [listedClient, unlistedClient].filter(Boolean)) {
      await admin("DELETE", `/admin/oauth/clients/${id}`);
    }
    await cleanupTestData({ orgIds: [], userEmails: EMAILS });
  }, 60_000);

  // ── 1. Direct calls ──────────────────────────────────────────────────────

  describe("each rule, called directly", () => {
    it("returns a browser event, which has no client_id, unchanged", () => {
      for (const method of ["otp", "magiclink", "token_refresh"]) {
        const claims: Record<string, unknown> = { ...clientEvent(method, userA, OPERATOR).claims };
        delete claims.client_id;
        delete claims.scope;
        claims.amr = [{ method: "otp", timestamp: 1 }];
        const input = { user_id: userA, authentication_method: method, claims };
        expect(hook(input)).toEqual(input);
      }
    });

    it("writes the kind of a listed client into its refreshed token, and changes nothing else", () => {
      const operator = clientEvent("token_refresh", userA, OPERATOR);
      expect(hook(operator)).toEqual(withKind(operator, "operator"));
      const agent = clientEvent("token_refresh", userA, AGENT);
      expect(hook(agent)).toEqual(withKind(agent, "agent"));
    });

    it("refuses a client the table does not list, or a client_id that is not one", () => {
      for (const id of [UNLISTED, "not-a-uuid", ""]) {
        expect(hook(clientEvent("token_refresh", userA, id))).toEqual(refusal(NOT_ACCEPTED));
      }
      const nullClient = { ...clientEvent("token_refresh", userA, OPERATOR) };
      expect(hook({ ...nullClient, claims: { ...nullClient.claims, client_id: null } })).toEqual(refusal(NOT_ACCEPTED));
    });

    it("refuses a client sign-in or refresh that asks for scope openid, and uses no record up", async () => {
      await record(userA, OPERATOR);
      for (const scope of ["openid", "email openid", " openid  email "]) {
        expect(hook(clientEvent("token_refresh", userA, OPERATOR, { scope }))).toEqual(refusal(NO_OPENID));
        expect(hook(clientEvent("oauth_provider/authorization_code", userA, OPERATOR, { scope }))).toEqual(
          refusal(NO_OPENID)
        );
      }
      expect(approvals(userA, OPERATOR)).toEqual([{ used: false }]);
      // A scope that only contains the word is not openid.
      const near = clientEvent("token_refresh", userA, OPERATOR, { scope: "email openid_x" });
      expect(hook(near)).toEqual(withKind(near, "operator"));
    });

    it("counts a new client sign-in only against a fresh record, and uses it up", () => {
      const event = clientEvent("oauth_provider/authorization_code", userA, OPERATOR);
      // The record the previous test wrote, still unused.
      expect(hook(event)).toEqual(withKind(event, "operator"));
      expect(approvals(userA, OPERATOR)).toEqual([{ used: true }]);
      expect(hook(event)).toEqual(refusal(NOT_APPROVED));
    });

    it("refuses a new client sign-in with no record, an old one, a used one, or another's", async () => {
      const event = clientEvent("oauth_provider/authorization_code", userB, OPERATOR);
      expect(hook(event)).toEqual(refusal(NOT_APPROVED));

      const old = new Date(Date.now() - 11 * 60_000).toISOString();
      await record(userB, OPERATOR, old);
      await record(userB, OPERATOR, undefined, new Date().toISOString());
      await record(userA, OPERATOR);
      await record(userB, AGENT);
      expect(hook(event)).toEqual(refusal(NOT_APPROVED));
      // None of them was used up by the refusals.
      expect(approvals(userB, OPERATOR)).toEqual([{ used: false }, { used: true }]);
      expect(approvals(userA, OPERATOR)).toEqual([{ used: true }, { used: false }]);
      expect(approvals(userB, AGENT)).toEqual([{ used: false }]);

      // The other client's record counts for that client.
      const agent = clientEvent("oauth_provider/authorization_code", userB, AGENT);
      expect(hook(agent)).toEqual(withKind(agent, "agent"));
    });

    it("refuses a new client sign-in whose user_id is not a user id", () => {
      const event = { ...clientEvent("oauth_provider/authorization_code", userA, OPERATOR), user_id: "x" };
      expect(hook(event)).toEqual(refusal(REFUSED));
    });

    it("refuses a client token by any other method", () => {
      for (const method of ["otp", "magiclink", "sso/saml", "oauth", "", "anonymous"]) {
        expect(hook(clientEvent(method, userA, OPERATOR))).toEqual(refusal(REFUSED));
      }
      const noMethod: Record<string, unknown> = { ...clientEvent("token_refresh", userA, OPERATOR) };
      delete noMethod.authentication_method;
      expect(hook(noMethod)).toEqual(refusal(REFUSED));
    });

    it("never hands out service_role or supabase_admin, and a client token runs as authenticated", () => {
      for (const role of ["service_role", "supabase_admin"]) {
        expect(hook(clientEvent("token_refresh", userA, OPERATOR, { role }))).toEqual(refusal(REFUSED));
        const browser = { user_id: userA, authentication_method: "otp", claims: { sub: userA, role } };
        expect(hook(browser)).toEqual(refusal(REFUSED));
      }
      for (const role of ["anon", "postgres", "mgm_agent", ""]) {
        expect(hook(clientEvent("token_refresh", userA, OPERATOR, { role }))).toEqual(refusal(REFUSED));
      }
    });

    it("still refuses a password or recovery session, a client's included", () => {
      const event = clientEvent("password", userA, OPERATOR);
      expect(hook(event)).toEqual(refusal("MGM signs in by email link only. Ask for a sign-in link on the sign-in page."));
    });
  });

  // ── 2. Catalogs ──────────────────────────────────────────────────────────

  describe("grants and policies", () => {
    it("keeps the hook SECURITY INVOKER, makes it VOLATILE, and lets only Supabase Auth call it", () => {
      const [fn] = ownerRows<{ volatile: string; definer: boolean; acl: string }>(
        `SELECT provolatile::text AS volatile, prosecdef AS definer, proacl::text AS acl
           FROM pg_proc WHERE oid = 'public.fn_auth_access_token_hook(jsonb)'::regprocedure`
      );
      expect(fn.volatile).toBe("v");
      expect(fn.definer).toBe(false);
      expect(fn.acl).toContain("supabase_auth_admin=X/");
      expect(fn.acl).not.toMatch(/(^|[{,])(anon|authenticated|service_role)?=X/);
    });

    it("turns row-level security on, with policies for supabase_auth_admin alone", () => {
      const tables = ownerRows<{ name: string; rls: boolean }>(
        `SELECT relname AS name, relrowsecurity AS rls FROM pg_class
          WHERE oid IN ('public.mgm_clients'::regclass, 'public.mgm_client_approvals'::regclass) ORDER BY relname`
      );
      expect(tables).toEqual([
        { name: "mgm_client_approvals", rls: true },
        { name: "mgm_clients", rls: true },
      ]);
      const policies = ownerRows<{
        tablename: string;
        cmd: string;
        roles: string;
        permissive: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT tablename, cmd, roles::text AS roles, permissive, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename IN ('mgm_clients', 'mgm_client_approvals')
          ORDER BY tablename, cmd`
      );
      expect(policies).toEqual([
        {
          tablename: "mgm_client_approvals",
          cmd: "SELECT",
          roles: "{supabase_auth_admin}",
          permissive: "PERMISSIVE",
          qual: "true",
          with_check: null,
        },
        // Only an unused record may be marked used, and never unmarked.
        {
          tablename: "mgm_client_approvals",
          cmd: "UPDATE",
          roles: "{supabase_auth_admin}",
          permissive: "PERMISSIVE",
          qual: "(used_at IS NULL)",
          with_check: "(used_at IS NOT NULL)",
        },
        {
          tablename: "mgm_clients",
          cmd: "SELECT",
          roles: "{supabase_auth_admin}",
          permissive: "PERMISSIVE",
          qual: "true",
          with_check: null,
        },
      ]);
    });

    it("gives anon and authenticated no privilege on either table", () => {
      const checks = ["anon", "authenticated"].flatMap((role) =>
        ["public.mgm_clients", "public.mgm_client_approvals"].flatMap((table) => [
          ...["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].map(
            (p) => `has_table_privilege('${role}', '${table}', '${p}')`
          ),
          ...["SELECT", "INSERT", "UPDATE", "REFERENCES"].map(
            (p) => `has_any_column_privilege('${role}', '${table}', '${p}')`
          ),
        ])
      );
      const [row] = ownerRows<{ any: boolean }>(`SELECT (${checks.join(" OR ")}) AS any`);
      expect(row.any).toBe(false);
    });

    it("gives supabase_auth_admin exactly the columns the hook reads and writes", () => {
      const columns = ownerRows<{ tbl: string; col: string; sel: boolean; ins: boolean; upd: boolean }>(
        `SELECT c.relname AS tbl, a.attname AS col,
                has_column_privilege('supabase_auth_admin', c.oid, a.attname, 'SELECT') AS sel,
                has_column_privilege('supabase_auth_admin', c.oid, a.attname, 'INSERT') AS ins,
                has_column_privilege('supabase_auth_admin', c.oid, a.attname, 'UPDATE') AS upd
           FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.oid IN ('public.mgm_clients'::regclass, 'public.mgm_client_approvals'::regclass)
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY c.relname, a.attnum`
      );
      const read = (tbl: string, col: string, sel: boolean, upd = false) => ({ tbl, col, sel, ins: false, upd });
      expect(columns).toEqual([
        read("mgm_client_approvals", "id", true),
        read("mgm_client_approvals", "user_id", true),
        read("mgm_client_approvals", "client_id", true),
        read("mgm_client_approvals", "created_at", true),
        read("mgm_client_approvals", "used_at", true, true),
        read("mgm_clients", "client_id", true),
        read("mgm_clients", "kind", true),
        read("mgm_clients", "label", false),
        read("mgm_clients", "created_at", false),
      ]);
      const [table] = ownerRows<{ any: boolean }>(
        `SELECT (${["public.mgm_clients", "public.mgm_client_approvals"]
          .flatMap((t) =>
            ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].map(
              (p) => `has_table_privilege('supabase_auth_admin', '${t}', '${p}')`
            )
          )
          .join(" OR ")}) AS any`
      );
      expect(table.any).toBe(false);
    });

    it("refuses a signed-in user's token and the anon key on both tables through the database API", async () => {
      const user = clientAs(await mintUserJwt(userA));
      const anon = anonClient();
      for (const db of [user, anon]) {
        for (const table of ["mgm_clients", "mgm_client_approvals"]) {
          const { error } = await db.from(table).select("*");
          expect(error?.code, table).toBe("42501");
        }
        const { error } = await db.from("mgm_client_approvals").insert({ user_id: userA, client_id: OPERATOR });
        expect(error?.code).toBe("42501");
      }
    });
  });

  // ── 3. End to end ────────────────────────────────────────────────────────

  describe("through Supabase Auth's OAuth server", () => {
    let accessToken = "";
    let refreshToken = "";

    it("refuses a listed client's sign-in with no approval record, then gives the same code its token once the record exists", async () => {
      const browser = await browserSession(EMAILS[0]);
      const { code, verifier } = await codeFor(listedClient, browser, "email");

      const refused = await exchange(listedClient, code, verifier);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toContain(NOT_APPROVED);
      expect(refused.body.access_token).toBeUndefined();
      expect(clientSessions(userA, listedClient)).toBe(0);

      await record(userA, listedClient);
      const accepted = await exchange(listedClient, code, verifier);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.id_token).toBeUndefined();
      accessToken = accepted.body.access_token as string;
      refreshToken = accepted.body.refresh_token as string;
      expect(claimsOf(accessToken)).toMatchObject({
        sub: userA,
        role: "authenticated",
        client_id: listedClient,
        [KIND_CLAIM]: "operator",
      });
      expect(approvals(userA, listedClient)).toEqual([{ used: true }]);
      expect(clientSessions(userA, listedClient)).toBe(1);
    }, 60_000);

    it("gives a browser session no client_id and no kind", async () => {
      const claims = claimsOf(await browserSession(EMAILS[0]));
      expect(claims.client_id).toBeUndefined();
      expect(claims[KIND_CLAIM]).toBeUndefined();
      expect(claims.role).toBe("authenticated");
    }, 30_000);

    it("refuses the client's token on Supabase Auth's account endpoints, and answers GET /user", async () => {
      const update = await auth("PUT", "/user", { token: accessToken, json: { data: { hook_test: true } } });
      expect(update.status, JSON.stringify(update.body)).toBe(403);
      const revoke = await auth("DELETE", `/user/oauth/grants?client_id=${listedClient}`, { token: accessToken });
      expect(revoke.status, JSON.stringify(revoke.body)).toBe(403);
      const user = await auth("GET", "/user", { token: accessToken });
      expect(user.status, JSON.stringify(user.body)).toBe(200);
      expect(user.body.id).toBe(userA);
      expect(clientSessions(userA, listedClient)).toBe(1);
    }, 30_000);

    it("refreshes a client's session with no new record, and keeps its kind", async () => {
      const refreshed = await refresh(listedClient, refreshToken);
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      refreshToken = refreshed.body.refresh_token as string;
      expect(claimsOf(refreshed.body.access_token as string)).toMatchObject({
        sub: userA,
        role: "authenticated",
        client_id: listedClient,
        [KIND_CLAIM]: "operator",
      });
      expect(approvals(userA, listedClient)).toEqual([{ used: true }]);
    }, 30_000);

    it("refuses the refresh once the client is no longer listed", async () => {
      await unlist(listedClient);
      try {
        const refused = await refresh(listedClient, refreshToken);
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(JSON.stringify(refused.body)).toContain(NOT_ACCEPTED);
        expect(refused.body.access_token).toBeUndefined();
      } finally {
        await list(listedClient, "operator", "Test CLI");
      }
      // The refusal rotated nothing: listed again, the same token refreshes.
      const again = await refresh(listedClient, refreshToken);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
    }, 30_000);

    it("refuses a client sign-in that asks for scope openid: no token, no session, the record not used", async () => {
      const browser = await browserSession(EMAILS[1]);
      const { code, verifier } = await codeFor(listedClient, browser, "openid email");
      await record(userB, listedClient);
      const refused = await exchange(listedClient, code, verifier);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toContain(NO_OPENID);
      expect(refused.body.access_token).toBeUndefined();
      expect(refused.body.id_token).toBeUndefined();
      expect(clientSessions(userB, listedClient)).toBe(0);
      expect(approvals(userB, listedClient)).toEqual([{ used: false }]);
    }, 60_000);

    it("refuses an unlisted client's sign-in and creates no session", async () => {
      const browser = await browserSession(EMAILS[0]);
      const { code, verifier } = await codeFor(unlistedClient, browser, "email");
      const refused = await exchange(unlistedClient, code, verifier);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toContain(NOT_ACCEPTED);
      expect(refused.body.access_token).toBeUndefined();
      expect(clientSessions(userA, unlistedClient)).toBe(0);
    }, 60_000);
  });
});
