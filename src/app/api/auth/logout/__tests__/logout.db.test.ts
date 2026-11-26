/**
 * `mgm logout`'s route end to end on the job's own Supabase (#297; RFC #259
 * § 4; ADR-008 decisions 4 and 5).
 *
 * A client signs in through Supabase Auth's OAuth server as `mgm login`
 * does (authorize, the person's approval with their browser session, the
 * approval record MGM's consent page writes, and the code exchanged with its
 * PKCE verifier). Its token then goes through the real middleware and, with
 * the headers middleware passes on, to the real route handler, whose
 * createClient builds the client from those headers and whose service client
 * runs fn_client_sessions_end on the real database. Only next/headers is
 * stood in for, with those headers, and the release allowlist, which does not
 * list the route until the CLI ships (C4, #300): without that stand-in
 * middleware answers 404 before the route.
 *
 * Cases: a staff member's logout ends that one session (its refresh fails,
 * Supabase Auth and MGM refuse its token) while their other CLI session and
 * their browser session stay signed in, whatever the body names; the access
 * token issued before logout still reads at the database API, as the CLI's
 * documentation says, and the consent stays; a person whose rows are all tenant rows logs out the
 * same way.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  LOCAL_SUPABASE_URL,
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  mintServiceRoleJwt,
  runAsDatabaseOwner,
  serviceClient,
  shouldSkip,
  testAnonKey,
} from "@/lib/supabase/__tests__/rls.helpers";

/** The headers middleware passed on, which the route reads through next/headers. */
let forwarded = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => forwarded,
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
}));
// The route is not released until the CLI ships (C4, #300).
vi.mock("@/lib/mgm/released-routes", async (original) => {
  const actual = await original<typeof import("@/lib/mgm/released-routes")>();
  return { ...actual, isReleasedRoute: (path: string) => path === "/api/auth/logout" || actual.isReleasedRoute(path) };
});

const skip = shouldSkip();
const APP = "http://127.0.0.1:3000";
const REDIRECT_URI = `${APP}/oauth/code`;

const F = {
  org: "29700000-0000-4000-8000-000000000001",
  community: "29700000-0000-4000-8001-000000000001",
  microgrid: "29700000-0000-4000-8002-000000000001",
  unit: "29700000-0000-4000-8005-000000000001",
};
const EMAIL = { staff: "logout-route-staff@test.local", tenant: "logout-route-tenant@test.local" };

type Person = { userId: string; browserToken: string };
type Session = { accessToken: string; refreshToken: string; sessionId: string };
let svc: SupabaseClient;
let staff: Person;
let tenant: Person;
let clientId = "";

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

/** The person's browser session, made as MGM makes one: an emailed link. */
async function browserFor(userId: string, email: string): Promise<Person> {
  const { data: link, error } = await svc.auth.admin.generateLink({ type: "magiclink", email });
  expect(error).toBeNull();
  const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error: verifyError } = await anon.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
  expect(verifyError).toBeNull();
  return { userId, browserToken: data.session!.access_token };
}

/** A whole client sign-in for `person`. */
async function signIn(person: Person): Promise<Session> {
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
  let redirect = details.body.redirect_url as string | undefined;
  if (!redirect) {
    const consent = await auth("POST", `/oauth/authorizations/${authorizationId}/consent`, {
      token: person.browserToken,
      json: { action: "approve" },
    });
    expect(consent.status, JSON.stringify(consent.body)).toBe(200);
    redirect = consent.body.redirect_url as string;
  }
  const { error } = await svc.from("mgm_client_approvals").insert({ user_id: person.userId, client_id: clientId });
  expect(error).toBeNull();
  const token = await auth("POST", "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: new URL(redirect).searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
  });
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  const accessToken = token.body.access_token as string;
  const sessionId = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")).session_id as string;
  return { accessToken, refreshToken: token.body.refresh_token as string, sessionId };
}

async function refresh(session: Session): Promise<number> {
  const res = await auth("POST", "/oauth/token", {
    form: { grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: clientId },
  });
  if (res.status === 200) {
    session.accessToken = res.body.access_token as string;
    session.refreshToken = res.body.refresh_token as string;
  }
  return res.status;
}

/** The headers NextResponse.next() passes on to the route (x-middleware-override-headers). */
function passedOn(res: Response): Headers | null {
  if (res.headers.get("x-middleware-next") !== "1") return null;
  const names = (res.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  const headers = new Headers();
  for (const name of names) headers.set(name, res.headers.get(`x-middleware-request-${name}`) ?? "");
  return headers;
}

/** POST `path` through middleware and then, if it passes, `route`, as Next.js would run them. */
async function send(path: string, token: string, body?: object) {
  const init = {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  };
  const { middleware } = await import("@/middleware");
  const gate = await middleware(new NextRequest(`${APP}${path}`, init));
  const headers = passedOn(gate);
  if (!headers) return { from: "middleware" as const, res: gate };
  forwarded = headers;
  const { POST } = await import("../route");
  return { from: "route" as const, res: await POST(new NextRequest(`${APP}${path}`, { ...init, headers })) };
}

describe.skipIf(skip)("POST /api/auth/logout ends the calling client's own session (#297)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", testAnonKey()!);
    vi.stubEnv("MGM_CLIENT_TOKENS", "");
    // Keys the mark middleware passes on, and the route's service client (CI exports no service-role key).
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
    vi.spyOn(console, "info").mockImplementation(() => {});
    svc = await serviceClient();
    await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });

    const inserts: [string, Record<string, unknown>[]][] = [
      ["organizations", [{ id: F.org, name: "Logout org" }]],
      ["communities", [{ id: F.community, org_id: F.org, name: "Logout community" }]],
      ["microgrids", [{ id: F.microgrid, community_id: F.community, name: "Logout grid", currency: "UGX", timezone: "Africa/Kampala" }]],
      ["tenants", [{ id: F.unit, microgrid_id: F.microgrid, display_name: "Renter", unit_label: "A1", primary_phone: "+256700000297" }]],
    ];
    for (const [table, rows] of inserts) {
      const { error } = await svc.from(table).insert(rows);
      if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
    }
    const [staffUser, tenantUser] = await Promise.all([
      createTestUser({ email: EMAIL.staff, role: "org_manager", scopeId: F.org }),
      createTestUser({ email: EMAIL.tenant, role: "tenant", scopeId: F.unit }),
    ]);
    staff = await browserFor(staffUser.userId, EMAIL.staff);
    tenant = await browserFor(tenantUser.userId, EMAIL.tenant);

    const created = await admin("POST", "/admin/oauth/clients", {
      client_name: "mgm-logout-test",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    clientId = created.body.client_id as string;
    const { error } = await svc.from("mgm_clients").insert({ client_id: clientId, kind: "operator", label: "MGM CLI (logout test)" });
    expect(error).toBeNull();
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (svc && clientId) await svc.from("mgm_clients").delete().eq("client_id", clientId);
    if (clientId) await admin("DELETE", `/admin/oauth/clients/${clientId}`);
    if (svc) await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });
  }, 60_000);

  it("ends that one session, whatever the body names, and leaves the person's other sessions signed in", async () => {
    const ending = await signIn(staff);
    const other = await signIn(staff);

    const { from, res } = await send("/api/auth/logout", ending.accessToken, { session_id: other.sessionId, user_id: tenant.userId });
    expect(from).toBe("route");
    expect(res.status).toBe(204);

    // The session that sent it is over: its refresh fails, and Supabase Auth and MGM refuse its token.
    expect(await refresh(ending)).toBeGreaterThanOrEqual(400);
    expect((await auth("GET", "/user", { token: ending.accessToken })).status).toBeGreaterThanOrEqual(400);
    const again = await send("/api/auth/logout", ending.accessToken);
    expect(again.from).toBe("middleware");
    expect(again.res.status).toBe(401);

    // The token issued before logout still reads at the database API until it expires (ADR-008 decision 4).
    const rest = await fetch(`${LOCAL_SUPABASE_URL}/rest/v1/organizations?select=id&id=eq.${F.org}`, {
      headers: { apikey: testAnonKey()!, Authorization: `Bearer ${ending.accessToken}` },
    });
    expect(rest.status).toBe(200);
    expect(await rest.json()).toEqual([{ id: F.org }]);

    // The other CLI session, named in the body, and the browser session are untouched.
    expect(await refresh(other)).toBe(200);
    expect((await auth("GET", "/user", { token: other.accessToken })).status).toBe(200);
    expect((await auth("GET", "/user", { token: staff.browserToken })).status).toBe(200);
    // Logout leaves the consent, so Connected apps keeps listing the client.
    const consent = runAsDatabaseOwner(
      `SELECT revoked_at IS NULL AS live FROM auth.oauth_consents WHERE user_id = '${staff.userId}' AND client_id = '${clientId}'`,
    );
    expect(consent.ok, consent.output).toBe(true);
    expect(JSON.parse(consent.stdout)).toEqual([{ live: true }]);
  });

  it("logs out a person whose rows are all tenant rows the same way", async () => {
    const session = await signIn(tenant);
    const { from, res } = await send("/api/auth/logout", session.accessToken);
    expect(from).toBe("route");
    expect(res.status).toBe(204);
    expect(await refresh(session)).toBeGreaterThanOrEqual(400);
    expect((await auth("GET", "/user", { token: tenant.browserToken })).status).toBe(200);
  });

  it("refuses a browser session's token sent as a bearer token, before the route", async () => {
    const { from, res } = await send("/api/auth/logout", staff.browserToken);
    expect(from).toBe("middleware");
    expect(res.status).toBe(401);
    expect((await auth("GET", "/user", { token: staff.browserToken })).status).toBe(200);
  });
});
