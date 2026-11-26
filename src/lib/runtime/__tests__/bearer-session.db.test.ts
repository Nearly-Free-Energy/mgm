/**
 * A client's token at MGM's routes, end to end on the job's own Supabase
 * (#272; RFC #259 § 2; ADR-008 decisions 4, 6 and 9's early warning).
 *
 * A client signs in through Supabase Auth's OAuth server as `mgm login`
 * will: authorize, the person's approval with their browser session, the
 * approval record MGM's consent page writes (written here with the service
 * role, as #271's sign-in test is not on main yet), and the code exchanged
 * with its PKCE verifier. Its token then goes through the real middleware
 * and, with the headers middleware passes on, to a real route handler, whose
 * createClient (@/lib/supabase/server) builds the client from the request
 * headers. Only next/headers is stood in for, with those headers.
 *
 * Cases: a staff member's operator token reads their organization's plugin
 * settings under row-level security, and the request scope knows it is an
 * operator client; a tenant's operator token is refused by the same staff
 * route; revoking the grant with the browser session refuses the token at
 * once, at middleware and at the route's own getUser(); a request with both
 * a session cookie and the token is refused; an agent client's token is
 * refused that route, and a browser session's token is refused as a bearer;
 * a live token with a mark set by hand, as on a route middleware skipped, is
 * refused by the route's createClient.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";

import {
  LOCAL_SUPABASE_URL,
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  mintServiceRoleJwt,
  serviceClient,
  shouldSkip,
  testAnonKey,
} from "@/lib/supabase/__tests__/rls.helpers";
import { credentialMark } from "@/lib/runtime/credential";

/** The headers middleware passed on, which the route reads through next/headers. */
let forwarded = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => forwarded,
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
}));

const skip = shouldSkip();
const APP = "http://127.0.0.1:3000";
const REDIRECT_URI = `${APP}/oauth/test-code`;

const F = {
  org: "27200000-0000-4000-8000-000000000001",
  community: "27200000-0000-4000-8001-000000000001",
  microgrid: "27200000-0000-4000-8002-000000000001",
  unit: "27200000-0000-4000-8005-000000000001",
};
const EMAIL = { staff: "bearer-session-staff@test.local", tenant: "bearer-session-tenant@test.local" };

type Person = { userId: string; email: string; browserToken: string };
let svc: SupabaseClient;
let staff: Person;
let tenant: Person;
let clientId = "";

const anonClient = () =>
  createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });

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
  const { data, error: verifyError } = await anonClient().auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
  expect(verifyError).toBeNull();
  return { userId, email, browserToken: data.session!.access_token };
}

/** A whole client sign-in for `person`, ending in an access token. */
async function signIn(person: Person): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
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
  // The record MGM's consent page writes when the person clicks (ADR-008 decision 2).
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
  return token.body.access_token as string;
}

/** The headers NextResponse.next() passes on to the route (x-middleware-override-headers). */
function passedOn(res: Response): Headers | null {
  if (res.headers.get("x-middleware-next") !== "1") return null;
  const names = (res.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  const headers = new Headers();
  for (const name of names) headers.set(name, res.headers.get(`x-middleware-request-${name}`) ?? "");
  return headers;
}

/** GET /api/organizations/[id]/plugins through middleware and then the route, as Next.js would run them. */
async function getPlugins(token: string, extra: Record<string, string> = {}) {
  const url = `${APP}/api/organizations/${F.org}/plugins`;
  const { middleware } = await import("@/middleware");
  const gate = await middleware(new NextRequest(url, { headers: { authorization: `Bearer ${token}`, ...extra } }));
  const headers = passedOn(gate);
  if (!headers) return { from: "middleware" as const, res: gate };
  return { from: "route" as const, res: await routeWith(headers) };
}

/** The route alone, with `headers` as the request's. */
async function routeWith(headers: Headers) {
  forwarded = headers;
  const { GET } = await import("@/app/api/organizations/[id]/plugins/route");
  return GET(new NextRequest(`${APP}/api/organizations/${F.org}/plugins`, { headers }), { params: Promise.resolve({ id: F.org }) });
}

describe.skipIf(skip)("a client's bearer token at MGM's routes (#272)", { timeout: 120_000 }, () => {
  let staffToken = "";

  beforeAll(async () => {
    await assertEnvironmentReady();
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", testAnonKey()!);
    vi.stubEnv("MGM_CLIENT_TOKENS", "");
    // Keys the mark middleware passes on and the route checks (credentialMark).
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
    svc = await serviceClient();
    await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });

    const inserts: [string, Record<string, unknown>[]][] = [
      ["organizations", [{ id: F.org, name: "Bearer session org" }]],
      ["communities", [{ id: F.community, org_id: F.org, name: "Bearer session community" }]],
      ["microgrids", [{ id: F.microgrid, community_id: F.community, name: "Bearer session grid", currency: "UGX", timezone: "Africa/Kampala" }]],
      ["tenants", [{ id: F.unit, microgrid_id: F.microgrid, display_name: "Renter", unit_label: "A1", primary_phone: "+256700000272" }]],
      // Read back through row-level security, so the answer shows whose session read it.
      ["mgm_plugins", [{ org_id: F.org, plugin_name: "metering", enabled: false, version: "0.1.0" }]],
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

    // Registered and listed as docs/setup.md registers and lists the CLI.
    const created = await admin("POST", "/admin/oauth/clients", {
      client_name: "mgm-bearer-session-test",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    clientId = created.body.client_id as string;
    const { error } = await svc.from("mgm_clients").insert({ client_id: clientId, kind: "operator", label: "MGM CLI (bearer test)" });
    expect(error).toBeNull();
    staffToken = await signIn(staff);
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (svc && clientId) await svc.from("mgm_clients").delete().eq("client_id", clientId);
    if (clientId) await admin("DELETE", `/admin/oauth/clients/${clientId}`);
    if (svc) await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });
  }, 60_000);

  it("lets a staff member's operator token read their organization's plugins, under row-level security", async () => {
    const { from, res } = await getPlugins(staffToken);
    expect(from).toBe("route");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: { name: string; enabled: boolean }[] };
    expect(body.plugins.find((p) => p.name === "metering")?.enabled).toBe(false);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("gives the request scope the operator client as its caller", async () => {
    const { middleware } = await import("@/middleware");
    const headers = passedOn(await middleware(new NextRequest(`${APP}/api/communities`, { method: "POST", headers: { authorization: `Bearer ${staffToken}` } })));
    expect(headers?.get("x-mgm-credential")).toBe(credentialMark(staffToken));
    forwarded = headers!;
    const { createClient: requestClient } = await import("@/lib/supabase/server");
    const { authorizeOrganization, openOrganizationScope } = await import("@/lib/runtime/scope");
    const client = await requestClient();
    // The step every organization composer runs first: getUser() on this client.
    const access = await authorizeOrganization(client, F.org);
    expect(access).toMatchObject({ ok: true, user: { id: staff.userId } });
    const scope = await openOrganizationScope({ organizationId: F.org, userId: staff.userId, roles: [], supabase: client });
    try {
      expect(scope.ctx.get("mgmRequest")?.caller).toEqual({ kind: "operator", clientId });
    } finally {
      await scope.dispose();
    }
  });

  it("refuses a tenant's operator token on the same staff route", async () => {
    const tenantToken = await signIn(tenant);
    const { from, res } = await getPlugins(tenantToken);
    expect(from).toBe("route");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "plugin_forbidden" });
  });

  it("refuses a request with both a session cookie and the token, before the route", async () => {
    const cookieName = `sb-${new URL(LOCAL_SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
    const { from, res } = await getPlugins(staffToken, { cookie: `${cookieName}=base64-e30` });
    expect(from).toBe("middleware");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "credentials_conflict" });
  });

  it("refuses a browser session's token sent as a bearer token", async () => {
    const { from, res } = await getPlugins(staff.browserToken);
    expect(from).toBe("middleware");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required", code: "unauthenticated" });
  });

  it("refuses an agent client on that route before it runs, and lets it on to the view route", async () => {
    // No agent client can sign in until #274 (the hook refuses it), so this
    // token carries the claims one will, signed with the project's secret;
    // Supabase Auth answers GET /user for it, as for a client's token.
    const now = Math.floor(Date.now() / 1000);
    const agentToken = await new SignJWT({
      sub: staff.userId,
      aud: "authenticated",
      role: "mgm_agent",
      client_id: randomUUID(),
      mgm_client_kind: "agent",
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
    const { from, res } = await getPlugins(agentToken);
    expect(from).toBe("middleware");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "agent_route_refused" });

    const { middleware } = await import("@/middleware");
    const view = await middleware(new NextRequest(`${APP}/api/gui/view?href=%2F`, { headers: { authorization: `Bearer ${agentToken}` } }));
    expect(passedOn(view)?.get("x-mgm-credential")).toBe(credentialMark(agentToken));
  });

  it("refuses a live token whose mark the client set by hand, as on a route middleware skipped", async () => {
    const token = await signIn(staff);
    expect((await getPlugins(token)).res.status).toBe(200);
    for (const mark of ["bearer", credentialMark(staffToken)!]) {
      await expect(routeWith(new Headers({ authorization: `Bearer ${token}`, "x-mgm-credential": mark }))).rejects.toThrow(
        /middleware did not accept/,
      );
    }
  });

  it("refuses the token at once once the person revokes the client, at middleware and at the route's own session check", async () => {
    const token = await signIn(staff);
    expect((await getPlugins(token)).res.status).toBe(200);

    const revoke = await auth("DELETE", `/user/oauth/grants?client_id=${clientId}`, { token: staff.browserToken });
    expect(revoke.status, JSON.stringify(revoke.body)).toBeLessThan(300);

    const { from, res } = await getPlugins(token);
    expect(from).toBe("middleware");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required", code: "unauthenticated" });

    // Had middleware let it through, the route's own getUser() refuses it too.
    const direct = await routeWith(new Headers({ authorization: `Bearer ${token}`, "x-mgm-credential": credentialMark(token)! }));
    expect(direct.status).toBe(401);
    expect(await direct.json()).toMatchObject({ code: "plugin_unauthenticated" });
  });
});
