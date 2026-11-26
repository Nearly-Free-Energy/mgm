/**
 * A client's token at MGM's routes, end to end on the job's own Supabase
 * (#272; RFC #259 § 2; ADR-008 decisions 4 and 6, and part of decision 9's
 * early warning).
 *
 * Of that early warning, this file signs the operator client in through the
 * OAuth server, calls a route with its token, revokes the grant, and checks
 * that both the refresh and Supabase Auth's answer then fail. It also signs
 * the agent client in and checks that the hook gives its token the role
 * `mgm_agent` (#274); that the role is refused a write is
 * `agent_role.test.ts`'s.
 *
 * A client signs in through Supabase Auth's OAuth server as `mgm login`
 * will: authorize, the person's approval with their browser session, the
 * approval record MGM's consent page writes (written here with the service
 * role; src/app/api/auth/oauth/approvals/__tests__/sign-in.db.test.ts signs
 * in through the page's own route), and the code exchanged
 * with its PKCE verifier. Its token then goes through the real middleware
 * and, with the headers middleware passes on, to a real route handler, whose
 * createClient (@/lib/supabase/server) builds the client from the request
 * headers. Only next/headers is stood in for, with those headers.
 *
 * Cases: a staff member's operator token reads their organization's plugin
 * settings under row-level security, and the request scope knows it is an
 * operator client; a tenant's operator token is refused by the same staff
 * route; revoking the grant with the browser session refuses the token at
 * once, at middleware and at the route's own getUser(), and its refresh
 * fails; a request with both a session cookie and the token is refused; an
 * agent client's token is refused that route and, let on to the view route,
 * builds a client the route reads as that agent client and is refused by
 * the route's own agent check (404 for a view not marked for an
 * assistant); the same token at the catalog route reads the person's
 * organizations as `mgm_agent` and reaches the assistant's gate (409
 * `assistant_disabled`); a browser session's token is refused as a bearer;
 * a live token with a mark set by hand, as on a route middleware skipped, is
 * refused by the route's createClient.
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
let agentClientId = "";

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

/** A whole client sign-in for `person`, ending in an access token and its refresh token. */
async function signIn(person: Person, client: string = clientId): Promise<{ access: string; refresh: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client,
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
  const { error } = await svc.from("mgm_client_approvals").insert({ user_id: person.userId, client_id: client });
  expect(error).toBeNull();
  const token = await auth("POST", "/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: new URL(redirect).searchParams.get("code")!,
      client_id: client,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    },
  });
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  return { access: token.body.access_token as string, refresh: token.body.refresh_token as string };
}

/** The refresh `mgm` will make with a public client's refresh token. */
function refresh(refreshToken: string) {
  return auth("POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId } });
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

    // Registered and listed as docs/setup.md registers and lists the CLI and
    // the assistant bridge.
    const register = async (name: string, kind: "operator" | "agent", label: string) => {
      const created = await admin("POST", "/admin/oauth/clients", {
        client_name: name,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.client_id as string;
      const { error } = await svc.from("mgm_clients").insert({ client_id: id, kind, label });
      expect(error).toBeNull();
      return id;
    };
    clientId = await register("mgm-bearer-session-test", "operator", "MGM CLI (bearer test)");
    agentClientId = await register("mgm-bearer-session-agent-test", "agent", "MGM assistant bridge (bearer test)");
    staffToken = (await signIn(staff)).access;
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const id of [clientId, agentClientId].filter(Boolean)) {
      if (svc) await svc.from("mgm_clients").delete().eq("client_id", id);
      await admin("DELETE", `/admin/oauth/clients/${id}`);
    }
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
    const tenantToken = (await signIn(tenant)).access;
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

  it("refuses an agent client on that route before it runs, and lets it on to the view route, which refuses it itself", async () => {
    // A whole sign-in of the agent client: the hook gives its token the
    // role mgm_agent (20261126160100).
    const agentToken = (await signIn(staff, agentClientId)).access;
    const claims = JSON.parse(Buffer.from(agentToken.split(".")[1], "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: staff.userId, role: "mgm_agent", client_id: agentClientId, mgm_client_kind: "agent" });
    const { from, res } = await getPlugins(agentToken);
    expect(from).toBe("middleware");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "agent_route_refused" });

    const { middleware } = await import("@/middleware");
    const viewUrl = `${APP}/api/gui/view?href=%2F`;
    const view = await middleware(new NextRequest(viewUrl, { headers: { authorization: `Bearer ${agentToken}` } }));
    const headers = passedOn(view);
    expect(headers?.get("x-mgm-credential")).toBe(credentialMark(agentToken));

    // On the headers middleware passed on, the route's createClient builds a
    // client that callerOf reads as this agent client: the caller
    // openHostRequest hands the host.
    forwarded = headers!;
    const { createClient: requestClient } = await import("@/lib/supabase/server");
    const { callerOf } = await import("@/lib/runtime/caller");
    expect(callerOf(await requestClient())).toEqual({ kind: "agent", clientId: agentClientId });

    // The view route itself, on the same headers. openHostRequest checks the
    // session with getUser() on the agent's client and reads the person's
    // role rows on it, now as mgm_agent (#274), so the request reaches the
    // route's own agent checks: no view is marked for an assistant yet
    // (ASSISTANT_READS is empty), so the home view answers 404
    // gui_not_found and no loader runs. The 409 assistant_disabled a marked
    // view meets at the assistant gate is shown with a mark stood in
    // (src/app/api/gui/__tests__/agent-client.test.ts); once a view is
    // marked, this case can ask for it here too, with the grants for the
    // rows its path names (a community's, a microgrid's or an edge's).
    const { GET } = await import("@/app/api/gui/view/route");
    const res2 = await GET(new NextRequest(viewUrl, { headers: headers! }));
    expect(res2.status).toBe(404);
    expect(await res2.json()).toMatchObject({ ok: false, code: "gui_not_found" });
    expect(res2.headers.get("set-cookie")).toBeNull();
  });

  it("lets an agent client's token read the person's organizations at the catalog route, which the assistant's gate then refuses", async () => {
    const agentToken = (await signIn(staff, agentClientId)).access;
    // Middleware answers 404 for the catalog until it is released (RFC #259
    // § 7), before it looks at the token, so the route is called directly
    // with the headers middleware passes on to an accepted agent request:
    // the token and its mark (GET /api/gui/view above shows both).
    const headers = new Headers({ authorization: `Bearer ${agentToken}`, "x-mgm-credential": credentialMark(agentToken)! });
    forwarded = headers;
    const url = `${APP}/api/gui/catalog`;
    const { GET } = await import("@/app/api/gui/catalog/route");
    // Without entity=, the catalog picks the organization with
    // visibleOrganizations, which reads organizations (id, name) on the
    // agent's client as mgm_agent (20261126160000), and only then asks the
    // assistant's gate. Without that grant the read fails and the answer is
    // 503 gui_unavailable.
    const res = await GET(new NextRequest(url, { headers }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "assistant_disabled" });
    expect(res.headers.get("set-cookie")).toBeNull();

    // Asked for this organization by id, the same: it is one the person reaches.
    const named = await GET(new NextRequest(`${url}?org=${F.org}`, { headers }));
    expect(named.status).toBe(409);
    expect(await named.json()).toMatchObject({ code: "assistant_disabled" });
  });

  it("refuses a live token whose mark the client set by hand, as on a route middleware skipped", async () => {
    const token = (await signIn(staff)).access;
    expect((await getPlugins(token)).res.status).toBe(200);
    for (const mark of ["bearer", credentialMark(staffToken)!]) {
      await expect(routeWith(new Headers({ authorization: `Bearer ${token}`, "x-mgm-credential": mark }))).rejects.toThrow(
        /middleware did not accept/,
      );
    }
  });

  it("refuses the token at once once the person revokes the client, at middleware and at the route's own session check, and its refresh fails", async () => {
    const { access: token, refresh: refreshToken } = await signIn(staff);
    // A real refresh token, or the refused refresh below would prove nothing.
    expect(refreshToken).toEqual(expect.any(String));
    expect(refreshToken.length).toBeGreaterThan(0);
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

    // The revoke deleted the client's session, so its refresh token gets no
    // new token either (ADR-008 decisions 4 and 9).
    const refreshed = await refresh(refreshToken);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBeGreaterThanOrEqual(400);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBeLessThan(500);
    expect(refreshed.body.access_token).toBeUndefined();
  });
});
