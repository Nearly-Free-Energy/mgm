/**
 * `mgm login`, `mgm whoami` and `mgm logout` end to end on the job's own
 * Supabase (#297; RFC #259 § 1 and § 4; ADR-008 decisions 3, 4 and 5),
 * extending the OAuth sign-in tests of #271 and #272
 * (src/app/api/auth/oauth/approvals/__tests__/sign-in.db.test.ts,
 * src/lib/runtime/__tests__/bearer-session.db.test.ts).
 *
 * The CLI's commands run as `mgm` runs them, with three stand-ins:
 *   - its fetch sends requests for the installation through the real
 *     middleware and then the real route handlers (discovery, the manifest
 *     and logout), in this process, and everything else to the job's real
 *     Supabase Auth;
 *   - its browser is this test: it follows the authorize address to
 *     Supabase Auth, runs the consent page's own Connect (approveSignIn)
 *     with the person's browser session against the real approvals route,
 *     and pastes the code page's string (encodePastedCode);
 *   - its token store is in a temporary directory.
 * Only next/headers is stood in for (with the headers middleware passed
 * on), the approvals route's cookie client (the person's browser session),
 * and the release allowlist, which lists none of these routes until the CLI
 * ships (C4, #300).
 *
 * Cases: a staff member signs in, is named by whoami (with the
 * installation's contract from its manifest), refreshes without a second
 * refresh when two commands need one at once, and logs out, after which the
 * session's refresh fails and the browser session is untouched; a person
 * whose rows are all tenant rows does the same; logout with MGM unreachable
 * deletes the file and says to revoke the app from Connected apps.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { lstat } from "node:fs/promises";

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
import { CODE_PATH } from "@/lib/auth/client-consent";
import { encodePastedCode } from "@/lib/auth/pasted-code";
import { GUI_CONTRACT } from "@/lib/gui/contract";
import { approveSignIn } from "@/app/oauth/consent/approve";
import { run } from "../cli.ts";
import type { Deps } from "../commands.ts";
import type { Fetch } from "../http.ts";
import { type Store, tokenFilePath } from "../store.ts";
import { temporaryStore } from "./fake-installation.ts";

/** The headers middleware passed on, which the routes read through next/headers. */
let forwarded = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => forwarded,
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
}));
/** The approvals route's cookie session: the person's browser, while Connect runs. */
let cookieClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/server", async (original) => {
  const actual = await original<typeof import("@/lib/supabase/server")>();
  return { createClient: async () => cookieClient ?? actual.createClient() };
});
// None of these routes is released until the CLI ships (C4, #300).
const ROUTES = ["/api/auth/discovery", "/api/auth/logout", "/api/gui/manifest"];
vi.mock("@/lib/mgm/released-routes", async (original) => {
  const actual = await original<typeof import("@/lib/mgm/released-routes")>();
  return { ...actual, isReleasedRoute: (path: string) => ROUTES.includes(path) || actual.isReleasedRoute(path) };
});

const skip = shouldSkip();
const APP = "http://127.0.0.1:3000";

const F = {
  org: "29710000-0000-4000-8000-000000000001",
  community: "29710000-0000-4000-8001-000000000001",
  microgrid: "29710000-0000-4000-8002-000000000001",
  unit: "29710000-0000-4000-8005-000000000001",
};
const EMAIL = { staff: "mgm-cli-staff@test.local", tenant: "mgm-cli-tenant@test.local" };

type Person = { userId: string; email: string; browser: SupabaseClient; browserToken: string };
let svc: SupabaseClient;
let staff: Person;
let tenant: Person;
let clientId = "";

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

/** The person's browser session, made as MGM makes one: an emailed link. */
async function browserFor(userId: string, email: string): Promise<Person> {
  const { data: link, error } = await svc.auth.admin.generateLink({ type: "magiclink", email });
  expect(error).toBeNull();
  const browser = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await browser.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: "email" });
  expect(verified.error).toBeNull();
  return { userId, email, browser, browserToken: verified.data.session!.access_token };
}

/** The headers NextResponse.next() passes on to the route (x-middleware-override-headers). */
function passedOn(res: Response): Headers | null {
  if (res.headers.get("x-middleware-next") !== "1") return null;
  const names = (res.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  const headers = new Headers();
  for (const name of names) headers.set(name, res.headers.get(`x-middleware-request-${name}`) ?? "");
  return headers;
}

/** The installation, in this process: middleware, then the route handler, as Next.js runs them. */
async function installation(input: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  const request = new NextRequest(input, { method, headers: init.headers, body: init.body as string | undefined });
  const { middleware } = await import("@/middleware");
  const gate = await middleware(request);
  const headers = passedOn(gate);
  if (!headers) return gate;
  forwarded = headers;
  const passed = new NextRequest(input, { method, headers, body: init.body as string | undefined });
  const route = `${method} ${new URL(input).pathname}`;
  if (route === "GET /api/auth/discovery") return (await import("@/app/api/auth/discovery/route")).GET(passed);
  if (route === "GET /api/gui/manifest") return (await import("@/app/api/gui/manifest/route")).GET(passed);
  if (route === "POST /api/auth/logout") return (await import("@/app/api/auth/logout/route")).POST(passed);
  return new Response("Not found", { status: 404 });
}

type Counts = { refreshes: number };

/** The CLI's fetch: the installation in this process, Supabase for real. */
function cliFetch(counts: Counts, o: { mgmDown?: boolean } = {}): Fetch {
  return async (input, init = {}) => {
    if (input.startsWith(`${APP}/`)) {
      if (o.mgmDown) throw new TypeError("fetch failed");
      return installation(input, init);
    }
    if (input.endsWith("/auth/v1/oauth/token") && new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token") {
      counts.refreshes += 1;
    }
    return fetch(input, init);
  };
}

/** The browser half of a sign-in for `person`: the string the code page shows them. */
async function approveInBrowser(person: Person, address: string): Promise<string> {
  // A browser sends no apikey; Supabase Auth's authorize endpoint needs none.
  const authorize = await fetch(address, { redirect: "manual" });
  expect(authorize.status, await authorize.text()).toBeGreaterThanOrEqual(300);
  const authorizationId = new URL(authorize.headers.get("location")!).searchParams.get("authorization_id")!;
  const result = await approveSignIn(authorizationId, {
    fetch: async (path, init) => {
      cookieClient = person.browser;
      try {
        const { POST } = await import("@/app/api/auth/oauth/approvals/route");
        return await POST(
          new NextRequest(`${APP}${path}`, {
            method: init.method,
            headers: { ...(init.headers as Record<string, string>), "sec-fetch-site": "same-origin" },
            body: init.body as string,
          }),
        );
      } finally {
        cookieClient = null;
      }
    },
    oauth: person.browser.auth.oauth,
    siteOrigin: APP,
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const back = new URL((result as { redirectUrl: string }).redirectUrl);
  expect(`${back.origin}${back.pathname}`).toBe(`${APP}${CODE_PATH}`);
  return encodePastedCode({ state: back.searchParams.get("state")!, code: back.searchParams.get("code")! })!;
}

/** `mgm` as `person` would run it, at this installation, with `store`. */
async function mgm(argv: string[], person: Person, store: Store, o: { counts?: Counts; mgmDown?: boolean } = {}) {
  let opened = "";
  const deps: Deps = {
    fetch: cliFetch(o.counts ?? { refreshes: 0 }, o),
    store,
    now: Date.now,
    platform: "linux",
    note: () => {},
    openBrowser: async (address) => {
      opened = address;
      return true;
    },
    prompt: () => approveInBrowser(person, opened),
  };
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, deps, { out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join(""), err: err.join("") };
}

async function refreshStatus(refreshToken: string): Promise<number> {
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { apikey: testAnonKey()!, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  });
  await res.text();
  return res.status;
}

async function userStatus(token: string): Promise<number> {
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: testAnonKey()!, Authorization: `Bearer ${token}` } });
  await res.text();
  return res.status;
}

describe.skipIf(skip)("mgm login, whoami and logout against the job's own Supabase (#297)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
    vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", testAnonKey()!);
    vi.stubEnv("MGM_APP_URL", APP);
    vi.stubEnv("MGM_CLIENT_TOKENS", "");
    vi.stubEnv("MGM_GUI", "");
    // Keys the mark middleware passes on, and the routes' service client (CI exports no service-role key).
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
    vi.spyOn(console, "info").mockImplementation(() => {});
    svc = await serviceClient();
    await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });

    const inserts: [string, Record<string, unknown>[]][] = [
      ["organizations", [{ id: F.org, name: "CLI org" }]],
      ["communities", [{ id: F.community, org_id: F.org, name: "CLI community" }]],
      ["microgrids", [{ id: F.microgrid, community_id: F.community, name: "CLI grid", currency: "UGX", timezone: "Africa/Kampala" }]],
      ["tenants", [{ id: F.unit, microgrid_id: F.microgrid, display_name: "Renter", unit_label: "A1", primary_phone: "+256700000298" }]],
      // A tenant-only person's manifest needs the tenant app on.
      ["mgm_plugins", [{ org_id: F.org, plugin_name: "tenant-app", version: "0.1.0", enabled: true }]],
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
      client_name: "mgm-cli-test",
      redirect_uris: [`${APP}${CODE_PATH}`],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    clientId = created.body.client_id as string;
    const { error } = await svc.from("mgm_clients").insert({ client_id: clientId, kind: "operator", label: "MGM CLI (cli test)" });
    expect(error).toBeNull();
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (svc && clientId) await svc.from("mgm_clients").delete().eq("client_id", clientId);
    if (clientId) await admin("DELETE", `/admin/oauth/clients/${clientId}`);
    if (svc) await cleanupTestData({ orgIds: [F.org], userEmails: Object.values(EMAIL) });
  }, 60_000);

  it("signs a staff member in, names them, refreshes once for two commands, and logs out of that session only", async () => {
    const { store, cleanup } = await temporaryStore();
    try {
      const login = await mgm(["login", "--url", APP, "--json"], staff, store);
      expect(login.err).toBe("");
      expect(login.code).toBe(0);
      const path = tokenFilePath(store.base, APP, "operator");
      expect(JSON.parse(login.out)).toEqual({
        installation: APP,
        email: EMAIL.staff,
        user_id: staff.userId,
        client_id: clientId,
        client_kind: "operator",
        token_file: path,
        contract: { cli: GUI_CONTRACT, installation: GUI_CONTRACT },
        contract_note: null,
      });
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      // The consent page's approval was recorded and used up by the code exchange.
      const approvals = runAsDatabaseOwner(
        `SELECT count(*)::int AS n FROM public.mgm_client_approvals WHERE user_id = '${staff.userId}' AND client_id = '${clientId}' AND used_at IS NOT NULL`,
      );
      expect(JSON.parse(approvals.stdout)).toEqual([{ n: 1 }]);

      const whoami = await mgm(["whoami"], staff, store);
      expect(whoami.code).toBe(0);
      expect(whoami.out).toContain(`Signed in to ${APP} as ${EMAIL.staff}.`);
      expect(whoami.out).toContain("Client:     operator (the MGM command line)");
      expect(whoami.out).toContain(`Token file: ${path}`);

      // Two commands that both need a refresh: one refresh, and both go on signed in.
      const before = (await store.readToken(path))!;
      await store.writeToken(path, { ...before, expires_at: Date.now() });
      const counts = { refreshes: 0 };
      const both = await Promise.all([mgm(["whoami"], staff, store, { counts }), mgm(["whoami"], staff, store, { counts })]);
      expect(both.map((r) => r.code)).toEqual([0, 0]);
      expect(counts.refreshes).toBe(1);
      const refreshed = (await store.readToken(path))!;
      expect(refreshed.refresh_token).not.toBe(before.refresh_token);

      const logout = await mgm(["logout"], staff, store);
      expect(logout.code).toBe(0);
      expect(logout.out).toBe(`Signed out of ${APP}. The token file is deleted.\n`);
      expect(await store.readToken(path)).toBeNull();
      // That session is over; the browser session is not.
      expect(await refreshStatus(refreshed.refresh_token)).toBeGreaterThanOrEqual(400);
      expect(await userStatus(refreshed.access_token)).toBeGreaterThanOrEqual(400);
      expect(await userStatus(staff.browserToken)).toBe(200);

      const after = await mgm(["whoami"], staff, store);
      expect(after.code).toBe(1);
      expect(after.err).toContain(`You are not signed in to ${APP}. Run: mgm login --url ${APP}`);
    } finally {
      await cleanup();
    }
  });

  it("does the same for a person whose rows are all tenant rows", async () => {
    const { store, cleanup } = await temporaryStore();
    try {
      const login = await mgm(["login", "--url", APP], tenant, store);
      expect(login.err).toBe("");
      expect(login.code).toBe(0);
      expect(login.out).toContain(`Signed in to ${APP} as ${EMAIL.tenant}.`);
      expect(login.out).toContain(`Contract:   ${GUI_CONTRACT} (this mgm), ${GUI_CONTRACT} (installation)`);
      const token = (await store.readToken(tokenFilePath(store.base, APP, "operator")))!;
      const logout = await mgm(["logout"], tenant, store);
      expect(logout.code).toBe(0);
      expect(await refreshStatus(token.refresh_token)).toBeGreaterThanOrEqual(400);
    } finally {
      await cleanup();
    }
  });

  it("deletes the token file and says to revoke the app when MGM cannot be reached at logout", async () => {
    const { store, cleanup } = await temporaryStore();
    try {
      expect((await mgm(["login", "--url", APP], staff, store)).code).toBe(0);
      const token = (await store.readToken(tokenFilePath(store.base, APP, "operator")))!;
      const logout = await mgm(["logout"], staff, store, { mgmDown: true });
      expect(logout.code).toBe(1);
      expect(logout.out).toMatch(/may still be signed in[\s\S]*Connected apps/);
      expect(await store.readToken(tokenFilePath(store.base, APP, "operator"))).toBeNull();
      // The session is still live, as the advice says, until it is revoked.
      expect(await refreshStatus(token.refresh_token)).toBe(200);
      await svc.rpc("fn_client_sessions_end", { _user_id: staff.userId, _client_id: clientId });
    } finally {
      await cleanup();
    }
  });
});
