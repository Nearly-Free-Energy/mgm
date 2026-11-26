/**
 * auth_access_token_hook_clients.test.ts — #270 and #274, ADR-008 decisions
 * 1, 2 and 7; migrations 20261126090000 (mgm_clients, mgm_client_approvals),
 * 20261126090100 (the hook's rules for clients that are not a browser) and
 * 20261126160100 (an agent client's token runs as mgm_agent).
 *
 * 1. Direct calls of fn_auth_access_token_hook, as the database owner, with
 *    crafted events: every rule, one at a time.
 * 2. The catalogs: the hook stays SECURITY INVOKER and is VOLATILE, both
 *    tables have row-level security on, supabase_auth_admin holds exactly
 *    the grants and policies the hook needs, service_role every privilege,
 *    and no other role any. A caller with no grant on either table still
 *    gets a browser event back unchanged.
 * 3. End to end through Supabase Auth's OAuth server on the local Supabase,
 *    where supabase/config.toml turns it on and Supabase Auth runs the hook
 *    as supabase_auth_admin. Only this part catches a missing grant or
 *    policy: the direct calls run as the owner, who bypasses both.
 *
 * Browser sign-in through the hook (the email and emergency links, and the
 * password refusal) is auth_access_token_hook.test.ts; what mgm_agent may
 * read and run is agent_role.test.ts.
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
const AGENT_ROLE = "mgm_agent";
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

/** What the hook returns for an agent client: its kind, and the role mgm_agent. */
function asAgent(event: ReturnType<typeof clientEvent>) {
  return { ...event, claims: { ...event.claims, [KIND_CLAIM]: "agent", role: AGENT_ROLE } };
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

/**
 * A token Supabase Auth issued with the role mgm_agent: Supabase Auth itself
 * answers GET /user with it, and PostgREST runs it as mgm_agent, which reads
 * the caller's own role rows and organizations and is refused a write and a
 * table or column it is not granted (agent_role.test.ts has the rest).
 */
async function expectAgentToken(token: string, userId: string) {
  const user = await auth("GET", "/user", { token });
  expect(user.status, JSON.stringify(user.body)).toBe(200);
  expect(user.body.id).toBe(userId);
  const db = clientAs(token);
  const own = await db.from("user_roles").select("user_id");
  expect(own.error).toBeNull();
  expect(own.data).toEqual([]); // the fixture users hold no role rows
  const orgs = await db.from("organizations").select("id, name");
  expect(orgs.error).toBeNull();
  expect(orgs.data).toEqual([]); // and so reach no organization
  expect((await db.from("organizations").select("address_city")).error?.code).toBe("42501");
  expect((await db.from("communities").select("id")).error?.code).toBe("42501");
  const write = await db.from("user_roles").insert({ user_id: userId, role: "super_admin", scope_type: "org" });
  expect(write.error?.code).toBe("42501");
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const OPERATOR = randomUUID();
const OPERATOR_2 = randomUUID();
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
    await list(OPERATOR_2, "operator", "Test operator 2");
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
    await svc.from("mgm_clients").delete().in("client_id", [OPERATOR, OPERATOR_2, AGENT, listedClient].filter(Boolean));
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
    });

    // As authenticated it would hold the person's full authority at the
    // database API; mgm_agent reads only what migrations grant it (#274).
    it("gives a listed agent client's token the role mgm_agent, and changes nothing else", () => {
      const refreshed = clientEvent("token_refresh", userA, AGENT);
      expect(hook(refreshed)).toEqual(asAgent(refreshed));
    });

    it("counts an agent client's new sign-in only against a fresh record, as an operator's", async () => {
      const event = clientEvent("oauth_provider/authorization_code", userA, AGENT);
      expect(hook(event)).toEqual(refusal(NOT_APPROVED));
      await record(userA, AGENT);
      expect(hook(event)).toEqual(asAgent(event));
      expect(approvals(userA, AGENT)).toEqual([{ used: true }]);
      expect(hook(event)).toEqual(refusal(NOT_APPROVED));
    });

    it("refuses an agent client sign-in or refresh that asks for scope openid, and uses no record up", async () => {
      await record(userA, AGENT);
      for (const scope of ["openid", "email openid", "email \u00a0openid"]) {
        expect(hook(clientEvent("token_refresh", userA, AGENT, { scope }))).toEqual(refusal(NO_OPENID));
        expect(hook(clientEvent("oauth_provider/authorization_code", userA, AGENT, { scope }))).toEqual(
          refusal(NO_OPENID)
        );
      }
      expect(approvals(userA, AGENT)).toEqual([{ used: true }, { used: false }]);
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
      // Supabase Auth v2.198.0 splits on an ASCII space and trims each part of
      // every Unicode space, U+00A0 included, so each of these is openid to it.
      for (const scope of [
        "openid",
        "email openid",
        " openid  email ",
        " openid",
        "email  openid",
        "email \u00a0openid",
        "\u00a0openid",
        "email openid\u2003",
        "email\topenid",
      ]) {
        expect(hook(clientEvent("token_refresh", userA, OPERATOR, { scope }))).toEqual(refusal(NO_OPENID));
        expect(hook(clientEvent("oauth_provider/authorization_code", userA, OPERATOR, { scope }))).toEqual(
          refusal(NO_OPENID)
        );
      }
      // Supabase Auth refuses this one at authorize (no such scope); the hook
      // refuses the word anywhere, so it is refused here too.
      expect(hook(clientEvent("token_refresh", userA, OPERATOR, { scope: "email openid_x" }))).toEqual(
        refusal(NO_OPENID)
      );
      expect(approvals(userA, OPERATOR)).toEqual([{ used: false }]);
      const plain = clientEvent("token_refresh", userA, OPERATOR, { scope: "email profile" });
      expect(hook(plain)).toEqual(withKind(plain, "operator"));
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
      await record(userB, OPERATOR_2);
      expect(hook(event)).toEqual(refusal(NOT_APPROVED));
      // None of them was used up by the refusals.
      expect(approvals(userB, OPERATOR)).toEqual([{ used: false }, { used: true }]);
      expect(approvals(userA, OPERATOR)).toEqual([{ used: true }, { used: false }]);
      expect(approvals(userB, OPERATOR_2)).toEqual([{ used: false }]);

      // The other client's record counts for that client.
      const other = clientEvent("oauth_provider/authorization_code", userB, OPERATOR_2);
      expect(hook(other)).toEqual(withKind(other, "operator"));
      expect(approvals(userB, OPERATOR_2)).toEqual([{ used: true }]);
    });

    it("counts a record nine minutes old, inside the ten-minute authorization lifetime", async () => {
      // Someone who takes a few minutes to paste the code still gets in.
      await record(userB, OPERATOR, new Date(Date.now() - 9 * 60_000).toISOString());
      const event = clientEvent("oauth_provider/authorization_code", userB, OPERATOR);
      expect(hook(event)).toEqual(withKind(event, "operator"));
      // The eleven-minute record before it stays unused; the nine-minute one is used.
      expect(approvals(userB, OPERATOR)).toEqual([{ used: false }, { used: true }, { used: true }]);
    });

    it("refuses a new client sign-in whose user_id is not a user id", () => {
      const event = { ...clientEvent("oauth_provider/authorization_code", userA, OPERATOR), user_id: "x" };
      expect(hook(event)).toEqual(refusal(REFUSED));
    });

    it("refuses a client token by any other method", () => {
      for (const method of ["otp", "magiclink", "sso/saml", "oauth", "", "anonymous"]) {
        expect(hook(clientEvent(method, userA, OPERATOR))).toEqual(refusal(REFUSED));
        expect(hook(clientEvent(method, userA, AGENT))).toEqual(refusal(REFUSED));
      }
      const noMethod: Record<string, unknown> = { ...clientEvent("token_refresh", userA, OPERATOR) };
      delete noMethod.authentication_method;
      expect(hook(noMethod)).toEqual(refusal(REFUSED));
    });

    it("never hands out service_role or supabase_admin, and takes a client token only as authenticated", () => {
      for (const role of ["service_role", "supabase_admin"]) {
        for (const client of [OPERATOR, AGENT]) {
          expect(hook(clientEvent("token_refresh", userA, client, { role }))).toEqual(refusal(REFUSED));
        }
        const browser = { user_id: userA, authentication_method: "otp", claims: { sub: userA, role } };
        expect(hook(browser)).toEqual(refusal(REFUSED));
      }
      // An agent token that already says mgm_agent is refused too: Supabase
      // Auth v2.198.0 builds every event's role from the user, authenticated.
      for (const role of ["anon", "postgres", AGENT_ROLE, ""]) {
        for (const client of [OPERATOR, AGENT]) {
          expect(hook(clientEvent("token_refresh", userA, client, { role }))).toEqual(refusal(REFUSED));
        }
      }
      // Every token the hook accepts runs as authenticated or as mgm_agent.
      const roles = [OPERATOR, AGENT].map(
        (client) => (hook(clientEvent("token_refresh", userA, client)) as { claims: { role: string } }).claims.role
      );
      expect(roles).toEqual(["authenticated", AGENT_ROLE]);
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

    it("gives anon, authenticated and mgm_agent no privilege on either table", () => {
      const checks = ["anon", "authenticated", AGENT_ROLE].flatMap((role) =>
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

    it("pins every grant on both tables and their columns, to whichever role", () => {
      const tables = ownerRows<{ tbl: string; owner: string; grantee: string; privileges: string[] }>(
        `SELECT c.relname AS tbl, pg_get_userbyid(c.relowner) AS owner,
                CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee,
                array_agg(e.privilege_type ORDER BY e.privilege_type) AS privileges
           FROM pg_class c, aclexplode(c.relacl) e
          WHERE c.oid IN ('public.mgm_clients'::regclass, 'public.mgm_client_approvals'::regclass)
          GROUP BY 1, 2, 3 ORDER BY 1, 3`
      );
      // The owner and service_role, each with every table privilege
      // (whichever this Postgres version has), and nobody else.
      expect(tables.map(({ tbl, owner, grantee }) => ({ tbl, owner, grantee }))).toEqual([
        { tbl: "mgm_client_approvals", owner: "postgres", grantee: "postgres" },
        { tbl: "mgm_client_approvals", owner: "postgres", grantee: "service_role" },
        { tbl: "mgm_clients", owner: "postgres", grantee: "postgres" },
        { tbl: "mgm_clients", owner: "postgres", grantee: "service_role" },
      ]);
      for (const row of tables) {
        expect(row.privileges, `${row.tbl} ${row.grantee}`).toEqual(tables[0].privileges);
        expect(row.privileges).toEqual(
          expect.arrayContaining(["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"])
        );
      }

      const columns = ownerRows<{ tbl: string; col: string; grantee: string; privilege: string }>(
        `SELECT c.relname AS tbl, a.attname AS col,
                CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee,
                e.privilege_type AS privilege
           FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN LATERAL aclexplode(a.attacl) e
          WHERE c.oid IN ('public.mgm_clients'::regclass, 'public.mgm_client_approvals'::regclass)
          ORDER BY c.relname, a.attnum, 3, 4`
      );
      const auth = (tbl: string, col: string, privilege = "SELECT") => ({
        tbl,
        col,
        grantee: "supabase_auth_admin",
        privilege,
      });
      expect(columns).toEqual([
        auth("mgm_client_approvals", "id"),
        auth("mgm_client_approvals", "user_id"),
        auth("mgm_client_approvals", "client_id"),
        auth("mgm_client_approvals", "created_at"),
        auth("mgm_client_approvals", "used_at"),
        auth("mgm_client_approvals", "used_at", "UPDATE"),
        auth("mgm_clients", "client_id"),
        auth("mgm_clients", "kind"),
      ]);
    });

    // The browser return comes before the first table read, so a missing
    // grant or policy stops client sign-ins only (ADR-008, amendment of 26
    // Nov 2026). The direct calls above run as the owner, and the end-to-end
    // sign-ins with the grants in place, so neither would notice a change
    // that reads a table first.
    it("returns a browser event unchanged to a caller with no grant on either table, and refuses a client's", () => {
      const role = `mgm_hook_probe_${randomBytes(4).toString("hex")}`;
      const browser = JSON.stringify({
        user_id: userA,
        authentication_method: "magiclink",
        claims: { sub: userA, role: "authenticated", amr: [{ method: "otp", timestamp: 1 }] },
      });
      const client = JSON.stringify(clientEvent("token_refresh", userA, OPERATOR));
      // Rolled back, role and all, by the final RAISE, which reports what happened.
      const result = runAsDatabaseOwner(
        [
          "DO $t$",
          "DECLARE",
          "  v_browser jsonb;",
          "  v_client text := 'answered';",
          "  v_tables boolean;",
          "BEGIN",
          `  CREATE ROLE ${role} NOLOGIN NOINHERIT;`,
          `  GRANT ${role} TO CURRENT_USER WITH SET TRUE;`,
          `  GRANT USAGE ON SCHEMA public TO ${role};`,
          `  GRANT EXECUTE ON FUNCTION public.fn_auth_access_token_hook(jsonb) TO ${role};`,
          `  v_tables := has_any_column_privilege('${role}', 'public.mgm_clients', 'SELECT')`,
          `    OR has_any_column_privilege('${role}', 'public.mgm_client_approvals', 'SELECT');`,
          `  SET LOCAL ROLE ${role};`,
          `  v_browser := public.fn_auth_access_token_hook('${browser}'::jsonb);`,
          "  BEGIN",
          `    PERFORM public.fn_auth_access_token_hook('${client}'::jsonb);`,
          "  EXCEPTION WHEN insufficient_privilege THEN",
          "    v_client := SQLSTATE;",
          "  END;",
          "  RAISE EXCEPTION 'hook-grant-probe tables=% unchanged=% client=%',",
          `    v_tables::text, (v_browser = '${browser}'::jsonb)::text, v_client;`,
          "END",
          "$t$",
        ].join("\n")
      );
      expect(result.ok, result.output).toBe(false);
      expect(result.output).toMatch(/hook-grant-probe tables=false unchanged=true client=42501/);
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
        // Added by 20261126150000 for the consent page; the hook does not read it.
        read("mgm_client_approvals", "authorization_id", false),
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
      refreshToken = again.body.refresh_token as string;
    }, 30_000);

    it("refreshes as mgm_agent while the client is listed as an agent, and as authenticated once it is an operator again (#274)", async () => {
      const svc = await serviceClient();
      const kind = (k: string) => svc.from("mgm_clients").update({ kind: k }).eq("client_id", listedClient);
      expect((await kind("agent")).error).toBeNull();
      let agentToken = "";
      try {
        const refreshed = await refresh(listedClient, refreshToken);
        expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
        refreshToken = refreshed.body.refresh_token as string;
        agentToken = refreshed.body.access_token as string;
      } finally {
        expect((await kind("operator")).error).toBeNull();
      }
      expect(claimsOf(agentToken)).toMatchObject({
        sub: userA,
        role: AGENT_ROLE,
        client_id: listedClient,
        [KIND_CLAIM]: "agent",
      });
      await expectAgentToken(agentToken, userA);

      const back = await refresh(listedClient, refreshToken);
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      refreshToken = back.body.refresh_token as string;
      expect(claimsOf(back.body.access_token as string)).toMatchObject({
        role: "authenticated",
        [KIND_CLAIM]: "operator",
      });
      // Neither refresh needed a record. (Unlisting the client above removed
      // the earlier, used one.)
      expect(approvals(userA, listedClient)).toEqual([]);
    }, 30_000);

    // Supabase Auth reads ["email", "openid"] from this scope and accepts it at
    // authorize; it would issue an ID token if the hook let the sign-in pass.
    it("refuses a client sign-in whose openid sits next to a no-break space", async () => {
      const browser = await browserSession(EMAILS[0]);
      const { code, verifier } = await codeFor(listedClient, browser, "email \u00a0openid");
      await record(userA, listedClient);
      const refused = await exchange(listedClient, code, verifier);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toContain(NO_OPENID);
      expect(refused.body.id_token).toBeUndefined();
      // Unlisting the client above removed the earlier, used record.
      expect(approvals(userA, listedClient)).toEqual([{ used: false }]);
      expect(clientSessions(userA, listedClient)).toBe(1);
    }, 60_000);

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

    it("signs an agent client in as mgm_agent, against a recorded approval (#274)", async () => {
      const svc = await serviceClient();
      const kind = (k: string) => svc.from("mgm_clients").update({ kind: k }).eq("client_id", listedClient);
      const usedBefore = approvals(userB, listedClient).filter((a) => a.used).length;
      expect(clientSessions(userB, listedClient)).toBe(0);
      expect((await kind("agent")).error).toBeNull();
      let accepted: AuthAnswer;
      try {
        const browser = await browserSession(EMAILS[1]);
        const { code, verifier } = await codeFor(listedClient, browser, "email");
        await record(userB, listedClient);
        accepted = await exchange(listedClient, code, verifier);
      } finally {
        expect((await kind("operator")).error).toBeNull();
      }
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.id_token).toBeUndefined();
      const token = accepted.body.access_token as string;
      expect(claimsOf(token)).toMatchObject({
        sub: userB,
        role: AGENT_ROLE,
        client_id: listedClient,
        [KIND_CLAIM]: "agent",
      });
      expect(approvals(userB, listedClient).filter((a) => a.used)).toHaveLength(usedBefore + 1);
      expect(clientSessions(userB, listedClient)).toBe(1);
      await expectAgentToken(token, userB);
    }, 60_000);
  });
});
