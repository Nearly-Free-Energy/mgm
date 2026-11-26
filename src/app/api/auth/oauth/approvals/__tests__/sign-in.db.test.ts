/**
 * Signing in through Supabase Auth's OAuth server the way `mgm login` will,
 * on the job's own Supabase (#271; RFC #259 § 1; ADR-008 decisions 2, 3
 * and 9's early warning).
 *
 * Each sign-in runs MGM's own pieces, unmocked, against real Supabase Auth:
 *   - the authorize request lands on the consent page's path;
 *   - the consent page's read (readClientAuthorization) names the client;
 *   - Connect runs the consent page's own sequence (approveSignIn), whose
 *     POST goes to the real approvals route handler, signed in with the
 *     person's browser session, before it asks Supabase Auth for the code;
 *   - the code page's string (encodePastedCode) is decoded as the CLI will,
 *     and its code exchanged with the PKCE verifier for a token.
 * Only the two Supabase client factories are swapped: the route's cookie
 * client is the person's own browser session, and its service client the
 * suite's service role (CI exports no service-role key).
 *
 * Cases: a staff member and a person whose rows are all tenant rows each get
 * a token; a second sign-in, which Supabase Auth approves without asking,
 * gets no token without the record and one through the consent page; the
 * route refuses a bearer token, a client's token in the cookie and a
 * cross-site request, and writes nothing for any of them.
 *
 * ACM A6 extends this test to call a route with the token and to revoke.
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
import { CODE_PATH, CONSENT_PATH, readClientAuthorization } from "@/lib/auth/client-consent";
import { decodePastedCode, encodePastedCode } from "@/lib/auth/pasted-code";
import { approveSignIn } from "@/app/oauth/consent/approve";

let cookieClient: SupabaseClient | null = null;
let svc: SupabaseClient | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!cookieClient) throw new Error("[sign-in] no cookie session set");
    return cookieClient;
  },
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    if (!svc) throw new Error("[sign-in] no service client");
    return svc;
  },
}));

const skip = shouldSkip();
const APP = "http://127.0.0.1:3000";
const REDIRECT_URI = `${APP}${CODE_PATH}`;
process.env.MGM_APP_URL ??= APP;
const NOT_APPROVED = "Approve this sign-in on MGM's consent page, then try again.";

const F = {
  org: "27100000-0000-4000-8000-000000000001",
  community: "27100000-0000-4000-8001-000000000001",
  microgrid: "27100000-0000-4000-8002-000000000001",
  unit: "27100000-0000-4000-8005-000000000001",
};
const EMAIL = { staff: "oauth-sign-in-staff@test.local", tenant: "oauth-sign-in-tenant@test.local" };

type Person = { userId: string; email: string; browser: SupabaseClient };
let staff: Person;
let tenant: Person;
let clientId = "";

const claimsOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;

function anonClient(): SupabaseClient {
  return createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The person's browser session, made as MGM makes one: an emailed link. */
async function browserFor(userId: string, email: string): Promise<Person> {
  const { data: link, error } = await svc!.auth.admin.generateLink({ type: "magiclink", email });
  expect(error).toBeNull();
  const browser = anonClient();
  const verified = await browser.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
  expect(verified.error).toBeNull();
  return { userId, email, browser };
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

/** What `mgm login` does first: open the authorize address with PKCE and a state of its own. */
async function startLogin() {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    scope: "email",
  });
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/oauth/authorize?${query}`, {
    headers: { apikey: testAnonKey()! },
    redirect: "manual",
  });
  expect(res.status, await res.text()).toBeGreaterThanOrEqual(300);
  const location = new URL(res.headers.get("location")!);
  expect(location.pathname).toBe(CONSENT_PATH);
  const authorizationId = location.searchParams.get("authorization_id")!;
  expect(authorizationId).toBeTruthy();
  return { verifier, state, authorizationId };
}

/** The approvals route, called as the consent page's fetch calls it, from this site. */
async function postApproval(person: Person | null, init: RequestInit, headers: Record<string, string> = {}) {
  cookieClient = person?.browser ?? null;
  const { POST } = await import("../route");
  return POST(
    new NextRequest(`${APP}/api/auth/oauth/approvals`, {
      method: init.method,
      headers: { ...(init.headers as Record<string, string>), "sec-fetch-site": "same-origin", ...headers },
      body: init.body as string,
    })
  );
}

/** The consent page's Connect, for `person`. */
function connect(person: Person, authorizationId: string) {
  return approveSignIn(authorizationId, {
    fetch: (_input, init) => postApproval(person, init),
    oauth: person.browser.auth.oauth,
    siteOrigin: APP,
  });
}

/** What the CLI does with the pasted string. */
function exchange(pasted: string, state: string, verifier: string) {
  const decoded = decodePastedCode(`  ${pasted}\n`);
  expect(decoded?.state).toBe(state);
  return fetch(`${LOCAL_SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { apikey: testAnonKey()!, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: decoded!.code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));
}

/** The code page's string for the address Supabase Auth sent the browser to. */
function pastedFrom(redirectUrl: string): string {
  const url = new URL(redirectUrl);
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
  const pasted = encodePastedCode({ state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "" });
  expect(pasted).not.toBeNull();
  return pasted!;
}

function approvals(userId: string): { authorization_id: string | null; used: boolean }[] {
  const result = runAsDatabaseOwner(
    `SELECT authorization_id, used_at IS NOT NULL AS used FROM public.mgm_client_approvals
      WHERE user_id = '${userId}' AND client_id = '${clientId}' ORDER BY created_at`
  );
  expect(result.ok, result.output).toBe(true);
  return JSON.parse(result.stdout);
}

/** A whole first sign-in through the consent page, ending in a token. */
async function signIn(person: Person) {
  const { verifier, state, authorizationId } = await startLogin();
  const read = await readClientAuthorization(svc!, authorizationId, person.userId);
  expect(read).toEqual({ outcome: "ok", client: { id: clientId, kind: "operator", label: "MGM CLI (sign-in test)" } });

  const result = await connect(person, authorizationId);
  expect(result).toMatchObject({ ok: true });
  const pasted = pastedFrom((result as { redirectUrl: string }).redirectUrl);

  const token = await exchange(pasted, state, verifier);
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  expect(token.body.id_token).toBeUndefined();
  expect(claimsOf(token.body.access_token as string)).toMatchObject({
    sub: person.userId,
    role: "authenticated",
    client_id: clientId,
    mgm_client_kind: "operator",
  });
  expect(approvals(person.userId)).toContainEqual({ authorization_id: authorizationId, used: true });
  return token.body as { access_token: string; refresh_token: string };
}

describe.skipIf(skip)("signing in through the OAuth server and MGM's consent page (#271)", { timeout: 120_000 }, () => {
  // The staff member's first sign-in, which records their consent. The
  // first case checks it; the cases that need a client the person approved
  // before, or the token it gave, start it themselves if it has not run, so
  // each runs on its own and fails for its own behaviour.
  let staffFirstSignIn: Promise<{ access_token: string; refresh_token: string }> | undefined;
  const staffSignedIn = () => (staffFirstSignIn ??= signIn(staff));

  beforeAll(async () => {
    await assertEnvironmentReady();
    svc = await serviceClient();
    await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });

    const inserts: [string, Record<string, unknown>[]][] = [
      ["organizations", [{ id: F.org, name: "OAuth sign-in org" }]],
      ["communities", [{ id: F.community, org_id: F.org, name: "OAuth sign-in community" }]],
      ["microgrids", [{ id: F.microgrid, community_id: F.community, name: "OAuth sign-in grid", currency: "UGX", timezone: "Africa/Kampala" }]],
      ["tenants", [{ id: F.unit, microgrid_id: F.microgrid, display_name: "Renter", unit_label: "A1", primary_phone: "+256700000271" }]],
    ];
    for (const [table, rows] of inserts) {
      const { error } = await svc.from(table).insert(rows);
      if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
    }
    const [staffUser, tenantUser] = await Promise.all([
      createTestUser({ email: EMAIL.staff, role: "super_admin" }),
      createTestUser({ email: EMAIL.tenant, role: "tenant", scopeId: F.unit }),
    ]);
    staff = await browserFor(staffUser.userId, EMAIL.staff);
    tenant = await browserFor(tenantUser.userId, EMAIL.tenant);

    // Registered and listed as docs/setup.md registers and lists the CLI.
    const created = await admin("POST", "/admin/oauth/clients", {
      client_name: "mgm-sign-in-test",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    clientId = created.body.client_id as string;
    const { error } = await svc
      .from("mgm_clients")
      .insert({ client_id: clientId, kind: "operator", label: "MGM CLI (sign-in test)" });
    expect(error).toBeNull();
  }, 60_000);

  afterAll(async () => {
    cookieClient = null;
    if (svc && clientId) await svc.from("mgm_clients").delete().eq("client_id", clientId);
    if (clientId) await admin("DELETE", `/admin/oauth/clients/${clientId}`);
    if (svc) await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });
  }, 60_000);

  it("gives a staff member a token through the consent page", async () => {
    await staffSignedIn();
  });

  it("gives a person whose rows are all tenant rows a token the same way", async () => {
    await signIn(tenant);
  });

  it("gets no token for a sign-in Supabase Auth approves without asking, until the consent page has recorded it", async () => {
    // Supabase Auth approves a client the person approved before on its
    // first look at the sign-in, and issues the code at once.
    await staffSignedIn();
    const skipped = await startLogin();
    const details = await staff.browser.auth.oauth.getAuthorizationDetails(skipped.authorizationId);
    expect(details.error).toBeNull();
    expect(details.data && "authorization_id" in details.data).toBe(false);
    const refused = await exchange(
      pastedFrom((details.data as { redirect_url: string }).redirect_url),
      skipped.state,
      skipped.verifier
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain(NOT_APPROVED);
    expect(refused.body.access_token).toBeUndefined();
    // That sign-in is answered now, so the consent page cannot record it.
    const late = await postApproval(staff, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_id: skipped.authorizationId }),
    });
    expect(late.status).toBe(409);

    // Through the consent page, the same kind of sign-in gets its token, and
    // the page never asks Supabase Auth to approve.
    const next = await startLogin();
    const approve = vi.spyOn(staff.browser.auth.oauth, "approveAuthorization");
    try {
      const result = await connect(staff, next.authorizationId);
      expect(result).toMatchObject({ ok: true });
      expect(approve).not.toHaveBeenCalled();
      const token = await exchange(pastedFrom((result as { redirectUrl: string }).redirectUrl), next.state, next.verifier);
      expect(token.status, JSON.stringify(token.body)).toBe(200);
    } finally {
      approve.mockRestore();
    }
    expect(approvals(staff.userId).filter((a) => a.authorization_id === skipped.authorizationId)).toEqual([]);
  });

  it("refuses a bearer token, a client's token in the cookie and a cross-site request, and records nothing", async () => {
    const staffToken = await staffSignedIn();
    const { authorizationId } = await startLogin();
    const body = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_id: authorizationId }),
    };

    const bearer = await postApproval(staff, body, { Authorization: `Bearer ${staffToken.access_token}` });
    expect(bearer.status).toBe(401);
    expect((await bearer.json()).error).toMatch(/consent page in your browser/);

    // The CLI's own token, put into a browser session's place.
    const planted = anonClient();
    const set = await planted.auth.setSession(staffToken);
    expect(set.error).toBeNull();
    const asClient = await postApproval({ ...staff, browser: planted }, body);
    expect(asClient.status).toBe(401);
    // Refused for the claim, not for want of a user: Supabase Auth answers
    // GET /user for a client's token.
    expect((await planted.auth.getUser()).data.user?.id).toBe(staff.userId);
    expect((await asClient.json()).error).toMatch(/in this browser/);

    const crossSite = await postApproval(staff, body, { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);

    expect(approvals(staff.userId).filter((a) => a.authorization_id === authorizationId)).toEqual([]);
  });
});
