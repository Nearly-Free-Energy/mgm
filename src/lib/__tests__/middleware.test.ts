/**
 * Middleware tests (UX5d / #190).
 *
 * Coverage (per AC8 + AC9 of #190):
 *   - Unauthenticated GET on /forgot-password is NOT redirected to /login.
 *   - Unauthenticated GET on /reset-password is NOT redirected to /login.
 *   - Public-paths check still allows /login and /accept-invite (UX5c).
 *   - Unauthenticated GET on a private path (/dashboard) IS redirected.
 *   - The session check verifies the token with getClaims(), treats its
 *     errors and throws as signed out, and asks Auth (getUser) before
 *     sending a session away from /login.
 *   - /microgrids/<id> redirects to its Operations day view, keeping ?date=.
 *   - A page outside the installed release answers 404 with the
 *     not-released HTML page; an API path keeps its plain-text 404.
 *   - The web app manifest loads without a session.
 *   - Page requests forward x-mgm-path and carry an enforced content
 *     security policy with a fresh nonce; API requests get neither.
 *   - The two public payment pages keep their route's own policy; a
 *     trailing-slash, deeper, differently cased or percent-encoded
 *     neighbour is not exempt and never passes on without a policy.
 *   - The matcher skips only Next.js's asset folders, the GUI stylesheets'
 *     folder and each file in public/ by name, and each skipped folder has
 *     a 404 route; a static-looking path with no file answers 404 before
 *     the session check and forwards nothing.
 *
 * Located in src/lib/__tests__ so it runs under the `lib` vitest
 * project (vitest.config.ts only globs src/lib, src/components, src/app
 * and src/gui).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { renderNotReleasedPage } from "@/lib/public-html/not-released";
import { PUBLIC_PAGE_SECURITY_HEADERS } from "@/lib/public-html/page";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PUBLIC_DIR = path.join(REPO_ROOT, "public");

// Mock @supabase/ssr so getClaims() (every request) and getUser() (a
// signed-in visit to /login) resolve to deterministic values.
const getClaimsMock = vi.fn();
const getUserMock = vi.fn();
const createServerClientMock = vi.fn((..._args: unknown[]) => ({
  auth: {
    getClaims: getClaimsMock,
    getUser: getUserMock,
  },
}));

function signedIn(sub = "u1") {
  getClaimsMock.mockResolvedValue({ data: { claims: { sub } }, error: null });
}

function signedOut() {
  getClaimsMock.mockResolvedValue({ data: null, error: null });
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getClaimsMock.mockReset();
  getUserMock.mockReset();
  // Provide minimal request-time runtime configuration (#46).
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadMiddleware() {
  vi.resetModules();
  return (await import("../../middleware")).middleware;
}

function makeRequest(pathname: string, headers?: Record<string, string>) {
  return new NextRequest(`http://localhost${pathname}`, { headers });
}

describe("middleware PUBLIC_PATHS", () => {
  it("keeps the health endpoint available without a session", async () => {
    signedOut();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/api/mgm/health"));
    expect(res.status).toBe(200);
  });

  it("allows the old review bookmark to reach its dashboard redirect", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/review"));
    expect(res.status).toBe(200);
  });
  it.each([
    "/api/v1/billing/generate",
    "/api/openems/energy",
  ])("returns 404 for unreleased route %s even when signed in", async (path) => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path));
    expect(res.status).toBe(404);
  });

  it.each([
    "/api/communities",
    "/api/microgrids/grid-1",
    "/api/households/with-meter",
    "/settings/plugins",
    "/microgrids/grid-1/setup/households",
    "/api/microgrids/grid-1/openems-backend",
    "/api/microgrids/grid-1/openems-backend/test",
    "/api/microgrids/grid-1/openems-backend/discover",
    "/api/metering/readings",
    "/api/meter-readings/opening",
    "/microgrids/grid-1/setup/edges",
    "/microgrids/grid-1/setup/openems-backend",
    "/microgrids/grid-1/setup/households/hh-1",
    "/api/billing/generate",
    "/api/billing-periods",
    "/api/billing-line-items/abc/payment-status",
    "/microgrids/grid-1/billing",
    "/microgrids/grid-1/billing/period-1",
    "/microgrids/grid-1/setup/rates",
    "/microgrids/grid-1/operations",
  ])("permits released management route %s", async (path) => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path));
    expect(res.status).toBe(200);
  });

  it("redirects the microgrid index to its Operations day view", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/microgrids/grid-1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/microgrids/grid-1/operations");
  });

  it("redirects the microgrid index with a trailing slash to Operations too", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/microgrids/grid-1/"));
    expect(res.status).toBe(307);
    // Next.js answers a trailing-slash URL with a redirect to the bare path
    // before middleware runs, so only a direct call sees one.
    expect(res.headers.get("location")).toBe("http://localhost/microgrids/grid-1/operations");
  });

  it("drops the trailing slash and keeps the day asked for", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/microgrids/grid-1/?date=2026-11-01"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost/microgrids/grid-1/operations?date=2026-11-01"
    );
  });

  it("keeps the day asked for when it redirects the microgrid index", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/microgrids/grid-1?date=2026-11-01"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost/microgrids/grid-1/operations?date=2026-11-01"
    );
  });

  it("sends a signed-out visit to the microgrid index to /login, not to Operations", async () => {
    signedOut();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/microgrids/grid-1?date=2026-11-01"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it.each([
    { who: "signed in", session: signedIn },
    { who: "signed out", session: signedOut },
  ])(
    "serves the web app manifest without redirecting ($who)",
    async ({ session }) => {
      // Browsers fetch the manifest without cookies, so even a signed-in
      // person's request for it arrives signed out.
      session();
      const middleware = await loadMiddleware();
      const res = await middleware(makeRequest("/manifest.webmanifest"));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  );

  it("does not serve other manifest names", async () => {
    signedOut();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/manifest.json"));
    expect(res.status).toBe(404);
  });

  it("allows unauthenticated GET on /forgot-password (no redirect)", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/forgot-password"));

    // Pass-through (NextResponse.next), not a redirect to /login.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /reset-password (no redirect)", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/reset-password"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /login (regression)", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/login"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /accept-invite (regression — UX5c)", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/accept-invite"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("redirects unauthenticated GET on an available private path to /login", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/communities"));

    // NextResponse.redirect sets a 3xx and a Location header.
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  // #126: the login page returns to the page that was asked for.
  it("passes the page asked for, with its query, to /login in one parameter", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(
      makeRequest("/microgrids/m1/operations?date=2026-11-08"),
    );

    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("http://localhost");
    expect(location.pathname).toBe("/login");
    expect([...location.searchParams.keys()]).toEqual(["next"]);
    expect(location.searchParams.get("next")).toBe(
      "/microgrids/m1/operations?date=2026-11-08",
    );
  });

  it("sends a signed-out /go link to /login, which returns to it", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/go/billing.periods"));

    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/go/billing.periods");
  });

  it("sends a signed-out visit to the start page to a plain /login", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/"));

    expect(res.headers.get("location")).toBe("http://localhost/login");
  });

  // Release 4 (payments): /p/<slug> is the consumer-facing payment-link
  // indirection. Customers arrive with no MGM session; the middleware MUST
  // pass-through (the route's service-role SELECT is the access gate).
  it("passes public payment links through without a session", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/p/Kp9XrA"));

    expect(res.status).toBe(200);
  });

  it("passes payment links for authenticated users too", async () => {
    signedIn();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/p/Kp9XrA"));

    // No redirect — neither to /login nor to / (the authenticated-on-/login
    // branch is the only place a logged-in user gets redirected to root).
    expect(res.status).toBe(200);
  });

  // #294: /api/payments/ipn is Pesapal's IPN webhook — an unauthenticated
  // server-to-server callback with no MGM session. The middleware MUST
  // pass it through, otherwise it 401s ("Authentication required") before
  // the route handler runs and payments never auto-mark. Same class as the
  // /api/v1/ hotfix (#267).
  it("passes the payment webhook through without a session", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/api/payments/ipn"));

    // Pass-through (NextResponse.next), NOT the 401 JSON that API routes get
    // when unauthenticated and non-public.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  // Path scoping: only the exact /api/payments/ipn path is public. Sibling
  // payment routes (auth-gated payment-status mutations) must still 401 an
  // unauthenticated API request. Guards against a broad /api/payments/
  // prefix silently exposing them.
  it("keeps sibling payment routes session-gated", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/api/payments/status"));

    // API routes return 401 JSON (not a redirect) when non-public.
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes the public customer pay redirect without a session", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(
      makeRequest("/api/billing-line-items/12345678-1234-1234-1234-123456789012/pay")
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps the operator payment-url mint session-gated", async () => {
    signedOut();
    const middleware = await loadMiddleware();

    const res = await middleware(
      makeRequest("/api/billing-line-items/12345678-1234-1234-1234-123456789012/url")
    );

    expect(res.status).toBe(401);
  });
  it.each(["/api/payments/reconcile-worker", "/payment/callback"])("lets %s reach its own server-side validation without a session", async path => {
    signedOut();
    const middleware = await loadMiddleware();
    expect((await middleware(makeRequest(path))).status).toBe(200);
  });
  it("does not exempt worker sibling paths", async () => {
    signedOut();
    const middleware = await loadMiddleware();
    expect((await middleware(makeRequest("/api/payments/reconcile-worker/extra"))).status).toBe(404);
  });

});

describe("middleware for routes outside the installed release", () => {
  it.each([
    { path: "/settings/api-tokens", who: "signed in", session: signedIn },
    { path: "/settings/api-tokens", who: "signed out", session: signedOut },
    { path: "/microgrids/grid-1/tenants", who: "signed in", session: signedIn },
    { path: "/admin?next=%3Cscript%3E", who: "signed out", session: signedOut },
    // Only paths under /api/ are API requests; these are page links.
    { path: "/api", who: "signed in", session: signedIn },
    { path: "/apiary", who: "signed out", session: signedOut },
  ])("answers a page link ($path, $who) with the not-released page and 404", async ({ path, session }) => {
    session();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path, { "accept-language": "en-GB,en;q=0.9" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-language")).toBe("en");
    for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    // The page has a way back and shows nothing from the request.
    const body = await res.text();
    expect(body).toBe(renderNotReleasedPage("en"));
    expect(body).toContain('href="/"');
    // Refused before the session check, as the plain-text answer was.
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v1/billing/generate",
    "/api/openems/energy",
    "/api/payments/status",
    "/api/",
  ])("answers an API request (%s) exactly as before", async (path) => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path, { "accept-language": "en" }));
    expect(res.status).toBe(404);
    expect([...res.headers.entries()]).toEqual([["content-type", "text/plain;charset=UTF-8"]]);
    expect(await res.text()).toBe("Not available in this MGM release");
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});

describe("middleware session check", () => {
  it.each(["/settings/plugins", "/api/communities"])(
    "lets a verified token through to %s without asking Auth",
    async (path) => {
      signedIn();
      const middleware = await loadMiddleware();
      const res = await middleware(makeRequest(path));
      expect(res.status).toBe(200);
      expect(getUserMock).not.toHaveBeenCalled();
    }
  );

  it("treats an error from getClaims (such as an unreachable key set) as signed out", async () => {
    getClaimsMock.mockResolvedValue({
      data: null,
      error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 },
    });
    const middleware = await loadMiddleware();
    const page = await middleware(makeRequest("/communities"));
    expect(new URL(page.headers.get("location")!).pathname).toBe("/login");
    expect((await middleware(makeRequest("/api/communities"))).status).toBe(401);
  });

  it.each([
    new Error("Missing exp claim"),
    new Error("Invalid alg claim"),
    new SyntaxError("Unexpected token"),
  ])("treats a token getClaims throws on ($message) as signed out", async (thrown) => {
    getClaimsMock.mockRejectedValue(thrown);
    const middleware = await loadMiddleware();
    const page = await middleware(makeRequest("/communities"));
    expect(new URL(page.headers.get("location")!).pathname).toBe("/login");
    expect((await middleware(makeRequest("/api/communities"))).status).toBe(401);
    // The login page and the public webhook still answer instead of failing.
    expect((await middleware(makeRequest("/login"))).status).toBe(200);
    expect((await middleware(makeRequest("/api/payments/ipn"))).status).toBe(200);
  });

  it.each([
    { claims: { role: "anon" } },
    { claims: { sub: "" } },
  ])("treats verified claims without a subject as signed out (%j)", async (data) => {
    getClaimsMock.mockResolvedValue({ data, error: null });
    const middleware = await loadMiddleware();
    expect((await middleware(makeRequest("/api/communities"))).status).toBe(401);
  });

  it("sends a live session away from /login after asking Auth", async () => {
    signedIn();
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/");
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("sends a live session on /login to its same-site next page", async () => {
    signedIn();
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest("/login?next=%2Fmicrogrids%2Fm1%2Foperations%3Fdate%3D2026-11-08"),
    );
    expect(res.headers.get("location")).toBe(
      "http://localhost/microgrids/m1/operations?date=2026-11-08",
    );
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example"])(
    "sends a live session on /login to / when next is %s",
    async (next) => {
      signedIn();
      getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
      const middleware = await loadMiddleware();
      const res = await middleware(
        makeRequest(`/login?next=${encodeURIComponent(next)}`),
      );
      expect(res.headers.get("location")).toBe("http://localhost/");
    },
  );

  it("shows /login to a session Auth no longer knows, instead of redirecting back to /", async () => {
    // A session signed out on another device keeps a validly signed token
    // until it expires. The (gui) layout's getUser() sends it to /login;
    // redirecting it back to / would loop.
    signedIn();
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not ask Auth on /login when there is no session", async () => {
    signedOut();
    const middleware = await loadMiddleware();
    await middleware(makeRequest("/login"));
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it("returns the cookies a token refresh writes", async () => {
    // getClaims() refreshes an expiring session and hands the new cookies
    // to setAll; the response must carry them.
    getClaimsMock.mockImplementation(async () => {
      const options = createServerClientMock.mock.calls.at(-1)?.[2] as {
        cookies: {
          setAll(cookies: { name: string; value: string; options: object }[]): void;
        };
      };
      options.cookies.setAll([
        { name: "sb-test-auth-token", value: "refreshed", options: { path: "/" } },
      ]);
      return { data: { claims: { sub: "u1" } }, error: null };
    });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/settings/plugins?tab=all"));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("refreshed");
    // The request forwarded to the page carries the refreshed cookie and
    // the request path together.
    expect(res.headers.get("x-middleware-request-cookie")).toContain(
      "sb-test-auth-token=refreshed",
    );
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toBe(
      "/settings/plugins?tab=all",
    );
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(
      res.headers.get("content-security-policy"),
    );
  });
});

const CSP = "content-security-policy";
/** The header middleware does not send while the policy is enforced. */
const REPORT_ONLY = "content-security-policy-report-only";

function nonceOf(policy: string | null): string | undefined {
  return policy?.match(/'nonce-([^']+)'/)?.[1];
}

describe("middleware request path and content security policy", () => {
  it("forwards the page's path and query as x-mgm-path", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/microgrids/m1/operations?date=2026-11-08"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toBe(
      "/microgrids/m1/operations?date=2026-11-08",
    );
    // A request header for the page, not a response header for the browser.
    expect(res.headers.get("x-mgm-path")).toBeNull();
  });

  // The (gui) layout and catch-all page answer 404 without x-mgm-path,
  // taking its absence to mean this middleware did not run
  // (src/lib/gui/host/server/middleware-path.ts). So every page request it
  // passes on carries it: full renders, the router's RSC and prefetch
  // requests, public pages, and a signed-in visit to /login whose session
  // turns out dead.
  it.each<{ url: string; session: () => void; headers?: Record<string, string> }>([
    { url: "/", session: signedIn },
    { url: "/communities?tab=all", session: signedIn },
    { url: "/microgrids/m1/operations?_rsc=abc", session: signedIn, headers: { rsc: "1" } },
    { url: "/organizations", session: signedIn, headers: { rsc: "1", "next-router-prefetch": "1" } },
    { url: "/settings/plugins", session: signedIn, headers: { "next-action": "abc", "x-mgm-path": "" } },
    { url: "/login?next=%2Fcommunities", session: signedOut },
    { url: "/accept-invite", session: signedOut },
    { url: "/forgot-password", session: signedOut },
    { url: "/reset-password", session: signedOut },
    { url: "/setup", session: signedIn },
    { url: "/no-access", session: signedIn },
  ])("forwards x-mgm-path on every page request it passes on: $url", async ({ url, session, headers }) => {
    session();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(url, headers));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toBe(url);
  });

  it("forwards x-mgm-path when a dead session's visit to /login is let through", async () => {
    signedIn();
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toBe("/login");
  });

  it("matches the start page, which the (gui) layout renders", async () => {
    expect(unstable_doesMiddlewareMatch({ config: await middlewareConfig(), url: "/" })).toBe(true);
  });

  it("replaces an x-mgm-path the client sent", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest("/communities", { "x-mgm-path": "/organizations/other" }),
    );
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toBe("/communities");
  });

  it("forwards no x-mgm-path and no policy for an API request", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest("/api/communities", { "x-mgm-path": "/organizations/other" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toBeNull();
    expect(res.headers.get("x-middleware-override-headers")).not.toContain("x-mgm-path");
    expect(res.headers.get(CSP)).toBeNull();
    expect(res.headers.get(REPORT_ONLY)).toBeNull();
  });

  it("caps x-mgm-path at 2,048 characters", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(`/communities?q=${"a".repeat(3000)}`));
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toHaveLength(2048);
  });

  it.each([
    { path: "/communities", session: signedIn },
    { path: "/login", session: signedOut },
  ])("gives $path an enforced policy with the Supabase origin and a nonce", async ({ path, session }) => {
    session();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path));
    const policy = res.headers.get(CSP);
    expect(policy).toContain("connect-src 'self' http://localhost:54321");
    expect(policy).toContain("img-src 'self' data: blob: http://localhost:54321");
    expect(policy).toContain("object-src 'none'");
    expect(nonceOf(policy)).toBeTruthy();
    expect(res.headers.get(REPORT_ONLY)).toBeNull();
    // The page's request carries the same policy, which is where Next.js
    // reads the nonce from.
    expect(res.headers.get(`x-middleware-request-${CSP}`)).toBe(policy);
  });

  // Next.js applies middleware's response headers over a route's, so the
  // policy a browser receives is middleware's when it sends one and the
  // route's otherwise. The exempt routes set PUBLIC_PAGE_SECURITY_HEADERS
  // (their route tests check it); if Next.js changes which side wins, revisit.
  const ROUTE_POLICY = PUBLIC_PAGE_SECURITY_HEADERS["Content-Security-Policy"];
  function policyReceived(res: Response, routePolicy: string | null): string | null {
    return res.headers.get(CSP) ?? routePolicy;
  }

  // Their route handlers set PUBLIC_PAGE_SECURITY_HEADERS, which a policy
  // from middleware would replace (src/middleware.ts, ownPolicy).
  it.each([
    { path: "/p/Kp9XrA", session: signedOut },
    { path: "/payment/callback", session: signedOut },
    { path: "/payment/callback", session: signedIn },
  ])("leaves $path to the stricter policy its route sets", async ({ path, session }) => {
    session();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path, { [CSP]: "script-src 'nonce-chosen'" }));
    expect(res.status).toBe(200);
    expect(res.headers.get(CSP)).toBeNull();
    expect(res.headers.get(REPORT_ONLY)).toBeNull();
    expect(res.headers.get(`x-middleware-request-${CSP}`)).toBeNull();
    expect(policyReceived(res, ROUTE_POLICY)).toBe(ROUTE_POLICY);
  });

  // Released pages next to the exempt ones. Each passes through with
  // middleware's own policy, so the exemption is exactly the two paths: a
  // trailing slash (which isReleasedRoute strips) or a deeper path is not
  // exempt.
  it.each([
    "/payment/callback/",
    "/p/Kp9XrA/",
    "/communities/c1/payment",
    "/organizations/o1/payments",
  ])("gives the released page %s middleware's enforced policy, not the exemption", async path => {
    signedIn();
    expect(unstable_doesMiddlewareMatch({ config: await middlewareConfig(), url: path })).toBe(true);
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    const policy = res.headers.get(CSP);
    expect(policy).toContain("object-src 'none'");
    expect(nonceOf(policy)).toBeTruthy();
    expect(res.headers.get(`x-middleware-request-${CSP}`)).toBe(policy);
    expect(policyReceived(res, ROUTE_POLICY)).toBe(policy);
  });

  // Near misses outside the release: none is exempt, and none is passed on
  // without a policy. Each gets the not-released page, which carries
  // PUBLIC_PAGE_SECURITY_HEADERS itself. The URL parser keeps percent
  // escapes in the path, so an encoded slash or letter matches neither the
  // exemption nor the release allowlist.
  it.each([
    "/payment",
    "/payment/callbackx",
    "/payment/callback/extra",
    "/payment/callback.html",
    "/p",
    "/p/",
    "/p/a/b",
    "/pay/x",
    "/P/Kp9XrA",
    "/p%2FKp9XrA",
    "/%70/Kp9XrA",
    "/payment%2Fcallback",
    "/payment/callback%2F",
    "/payment/%63allback",
  ])("answers the unreleased near miss %s with a policy-carrying 404, not the exemption", async path => {
    for (const session of [signedIn, signedOut]) {
      session();
      expect(unstable_doesMiddlewareMatch({ config: await middlewareConfig(), url: path })).toBe(true);
      const middleware = await loadMiddleware();
      const res = await middleware(makeRequest(path));
      expect(res.status).toBe(404);
      expect(res.headers.get("x-middleware-next")).toBeNull();
      expect(res.headers.get(CSP)).toBe(ROUTE_POLICY);
      expect(res.headers.get(REPORT_ONLY)).toBeNull();
    }
  });

  it("takes the Supabase origin from the runtime settings", async () => {
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://db.example.test/base");
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/communities"));
    expect(res.headers.get(CSP)).toContain("connect-src 'self' https://db.example.test;");
  });

  it("names the Supabase origin browsers use, not the server's internal one", async () => {
    vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "https://db.example.test");
    vi.stubEnv("SUPABASE_INTERNAL_URL", "http://kong:8000");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "sb-mgm-auth-token");
    signedIn();
    const middleware = await loadMiddleware();
    const policy = (await middleware(makeRequest("/communities"))).headers.get(CSP);
    expect(policy).toContain("connect-src 'self' https://db.example.test;");
    expect(policy).toContain("img-src 'self' data: blob: https://db.example.test;");
    expect(policy).not.toContain("kong");
  });

  it.each([
    { path: "/communities", header: CSP, value: "script-src 'nonce-chosen'" },
    { path: "/communities", header: REPORT_ONLY, value: "script-src 'nonce-chosen'" },
    { path: "/api/communities", header: CSP, value: "script-src 'nonce-chosen'" },
    { path: "/communities", header: "x-mgm-path", value: "/organizations/other" },
    { path: "/api/communities", header: "x-mgm-path", value: "/organizations/other" },
  ])("drops a client-sent $header on $path after a token refresh too", async ({ path, header, value }) => {
    // setAll rebuilds the pass-through response; it must strip what the
    // client sent just as the first one does.
    getClaimsMock.mockImplementation(async () => {
      const options = createServerClientMock.mock.calls.at(-1)?.[2] as {
        cookies: {
          setAll(cookies: { name: string; value: string; options: object }[]): void;
        };
      };
      options.cookies.setAll([
        { name: "sb-test-auth-token", value: "refreshed", options: { path: "/" } },
      ]);
      return { data: { claims: { sub: "u1" } }, error: null };
    });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path, { [header]: value }));
    expect(res.headers.get("x-middleware-request-cookie")).toContain(
      "sb-test-auth-token=refreshed",
    );
    const forwarded = res.headers.get(`x-middleware-request-${header}`);
    if (forwarded !== null) expect(forwarded).not.toBe(value);
    expect(res.headers.get(`x-middleware-request-${REPORT_ONLY}`)).toBeNull();
    if (path.startsWith("/api/")) {
      expect(res.headers.get("x-middleware-request-x-mgm-path")).toBeNull();
      expect(res.headers.get(`x-middleware-request-${CSP}`)).toBeNull();
    } else {
      expect(nonceOf(res.headers.get(`x-middleware-request-${CSP}`))).toBeTruthy();
    }
  });

  it("uses a different nonce for each request", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const a = nonceOf((await middleware(makeRequest("/communities"))).headers.get(CSP));
    const b = nonceOf((await middleware(makeRequest("/communities"))).headers.get(CSP));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("drops a policy the client sent on the forwarded request", async () => {
    signedIn();
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest("/communities", {
        [CSP]: "script-src 'nonce-chosen'",
        [REPORT_ONLY]: "script-src 'nonce-chosen'",
      }),
    );
    expect(res.headers.get(`x-middleware-request-${REPORT_ONLY}`)).toBeNull();
    const nonce = nonceOf(res.headers.get(`x-middleware-request-${CSP}`));
    expect(nonce).toBeTruthy();
    expect(nonce).not.toBe("chosen");
  });

  it("adds eval and websockets in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    signedIn();
    const middleware = await loadMiddleware();
    const policy = (await middleware(makeRequest("/communities"))).headers.get(CSP);
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("ws:");
  });

  it("still sends a signed-out page request to /login with next=", async () => {
    signedOut();
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest("/communities?tab=all", { "x-mgm-path": "/organizations/other" }),
    );
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/communities?tab=all");
  });
});

describe("middleware matcher", () => {
  it.each([
    ["/gui-styles/gridtop.3f9a1c2e4b5d.css", false],
    // The name `npm run dev` writes.
    ["/gui-styles/gridtop.css", false],
    ["/_next/static/chunks/main-0123456789abcdef.js", false],
    ["/_next/image", false],
    ["/microgrids", true],
    ["/gui-stylesheet", true],
    ["/gui-styles", true],
    ["/api/gui-styles/x", true],
    ["/settings.css", true],
    // Only Next.js's own two asset paths skip it, not every _next path.
    ["/_next/staticx/a.js", true],
    ["/_next/images/a.png", true],
    ["/_next/nope", true],
    // The files in public/ skip middleware; a page path that happens to end
    // in an image extension does not.
    ["/icon.svg", false],
    ["/favicon.ico", false],
    ["/apple-touch-icon.png", false],
    ["/icons/icon-192.png", false],
    ["/organizations/x.png", true],
    ["/communities/a.svg", true],
    ["/microgrids/1/setup/edges/e.png", true],
    // A static-looking path with no file in public/ goes through it, so it
    // never reaches the (gui) catch-all page without the release check.
    ["/x.png", true],
    ["/apple-touch-icon-precomposed.png", true],
    ["/apple-touch-icon-120x120.png", true],
    ["/icons/x.png", true],
    ["/icons/icon-192.png.map", true],
    ["/favicon.ico.map", true],
    ["/favicon.icon", true],
    ["/robots.txt", true],
  ])("matches %s: %s", async (url, expected) => {
    vi.resetModules();
    const { config } = await import("../../middleware");
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(expected);
  });
});

/**
 * The matcher's one pattern, split into what it skips: Next.js's own asset
 * paths, the GUI stylesheets' folder, and each file in public/ by name.
 */
async function matcherSkips(): Promise<string[]> {
  vi.resetModules();
  const { config } = await import("../../middleware");
  expect(config.matcher).toHaveLength(1);
  const inner = /^\/\(\(\?!(.*)\)\.\*\)$/.exec(config.matcher[0])?.[1];
  expect(inner, "the matcher keeps the shape /((?!a|b|c).*)").toBeTruthy();
  return inner!.split("|");
}

/** The folders whose missing files must not reach the (gui) catch-all page. */
const SKIPPED_FOLDERS: Record<string, string> = {
  "_next/static/": "src/app/%5Fnext/static/[...file]/route.ts",
  "gui-styles/": "src/app/gui-styles/[...file]/route.ts",
};

/** Every file in public/ as its URL path without the leading slash. */
function publicFiles(dir = PUBLIC_DIR, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".DS_Store") return [];
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory() ? publicFiles(path.join(dir, entry.name), `${name}/`) : [name];
  });
}

describe("middleware matcher and public/", () => {
  // Every request the matcher skips is served without the middleware, so
  // without its content security policy, its security headers and the
  // x-mgm-path it sets. The (gui) layout and catch-all page must never be
  // among them: the matcher skips only files that exist, and folders whose
  // missing files have a 404 route of their own.
  it("skips each file in public/ by its exact name, and no name that is not there", async () => {
    const files = publicFiles().filter((file) => !file.startsWith("gui-styles/"));
    const named = (await matcherSkips())
      .filter((entry) => !(entry in SKIPPED_FOLDERS) && entry !== "_next/image$")
      .map((entry) => {
        expect(entry, "a file is named whole, ending in $").toMatch(/\$$/);
        return entry.slice(0, -1).replace(/\\\./g, ".");
      });
    expect(named.sort(), "List each file in public/ in the matcher of src/middleware.ts").toEqual(files.sort());
    for (const file of files) {
      expect(unstable_doesMiddlewareMatch({ config: await middlewareConfig(), url: `/${file}` }), file).toBe(false);
    }
  });

  it("skips every built GUI stylesheet, whatever its name", async () => {
    const built = publicFiles().filter((file) => file.startsWith("gui-styles/"));
    for (const file of [...built, "gui-styles/gridtop.0123456789ab.css"]) {
      expect(unstable_doesMiddlewareMatch({ config: await middlewareConfig(), url: `/${file}` }), file).toBe(false);
    }
  });

  it("gives each folder it skips a 404 route, so a missing file there never reaches the (gui) layout", async () => {
    const skips = await matcherSkips();
    const folders = skips.filter((entry) => entry.endsWith("/"));
    expect(folders.sort()).toEqual(Object.keys(SKIPPED_FOLDERS).sort());
    for (const route of Object.values(SKIPPED_FOLDERS)) {
      expect(existsSync(path.join(REPO_ROOT, route)), route).toBe(true);
      expect(readFileSync(path.join(REPO_ROOT, route), "utf8")).toContain("notReleasedResponse");
    }
  });
});

async function middlewareConfig() {
  return (await import("../../middleware")).config;
}

describe("middleware for a static-looking path with no file in public/", () => {
  it.each([
    { path: "/apple-touch-icon-precomposed.png", who: "signed out", session: signedOut },
    { path: "/apple-touch-icon-precomposed.png", who: "signed in", session: signedIn },
    { path: "/x.png", who: "signed out", session: signedOut },
    { path: "/x.png", who: "signed in", session: signedIn },
    { path: "/icons/x.svg", who: "signed in", session: signedIn },
    { path: "/favicon.ico.map", who: "signed out", session: signedOut },
    // Served from public/ without the middleware; were the file removed and
    // the matcher not updated, this is the answer it would get.
    { path: "/apple-touch-icon.png", who: "signed out", session: signedOut },
  ])("answers $path ($who) with 404 and the security headers, before the session check", async ({ path, session }) => {
    session();
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest(path, { "accept-language": "en", "x-mgm-path": "/microgrids/m/operations?org=other" }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getClaimsMock).not.toHaveBeenCalled();
    // Nothing is passed on to a page or layout: no rewrite, no forwarded
    // request, so neither the client's x-mgm-path nor any other reaches one.
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-override-headers")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-mgm-path")).toBeNull();
  });
});

describe("middleware runtime configuration (#46)", () => {
  it.each([
    {
      env: {
        MGM_PUBLIC_SUPABASE_URL: "https://alpha.example.test",
        MGM_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_alpha",
        MGM_PUBLIC_SUPABASE_COOKIE_NAME: "sb-alpha-auth-token",
        SUPABASE_INTERNAL_URL: "",
      },
      url: "https://alpha.example.test",
      key: "sb_publishable_alpha",
      cookie: { cookieOptions: { name: "sb-alpha-auth-token" } },
    },
    {
      env: {
        MGM_PUBLIC_SUPABASE_URL: "http://localhost:54321",
        MGM_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_beta",
        MGM_PUBLIC_SUPABASE_COOKIE_NAME: "sb-beta-auth-token",
        SUPABASE_INTERNAL_URL: "http://kong:8000",
      },
      url: "http://kong:8000",
      key: "sb_publishable_beta",
      cookie: { cookieOptions: { name: "sb-beta-auth-token" } },
    },
    {
      env: {
        MGM_PUBLIC_SUPABASE_URL: "http://localhost:54321",
        MGM_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_gamma",
        MGM_PUBLIC_SUPABASE_COOKIE_NAME: "",
        SUPABASE_INTERNAL_URL: "",
      },
      url: "http://localhost:54321",
      key: "sb_publishable_gamma",
      cookie: {},
    },
  ])("builds its Supabase client from the request-time settings ($url)", async ({ env, url, key, cookie }) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    signedIn();
    const middleware = await loadMiddleware();
    await middleware(makeRequest("/settings/plugins"));
    const [calledUrl, calledKey, options] = createServerClientMock.mock.calls.at(-1) as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(calledUrl).toBe(url);
    expect(calledKey).toBe(key);
    expect(options.cookieOptions).toEqual((cookie as { cookieOptions?: unknown }).cookieOptions);
  });

  it("refuses an internal URL on another host without a shared cookie name", async () => {
    vi.stubEnv("SUPABASE_INTERNAL_URL", "http://kong:8000");
    vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", "");
    const middleware = await loadMiddleware();
    await expect(middleware(makeRequest("/settings/plugins"))).rejects.toThrow(
      /MGM_PUBLIC_SUPABASE_COOKIE_NAME must be set/
    );
  });

  // Delete this test with the `runtime` line when moving to proxy.ts: Next.js
  // 16 refuses route segment config in a Proxy file (see src/middleware.ts).
  it("runs on the Node.js runtime so it reads the real process environment", async () => {
    vi.resetModules();
    const { config } = await import("../../middleware");
    expect(config.runtime).toBe("nodejs");
  });

  it("fails closed, naming the variable, when configuration is missing", async () => {
    for (const name of ["MGM_PUBLIC_SUPABASE_URL", "MGM_PUBLIC_SUPABASE_ANON_KEY"]) {
      vi.stubEnv(name, "");
    }
    // A retired name does not stand in for a missing MGM_ name (#79).
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://legacy.example.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_legacy");
    const middleware = await loadMiddleware();
    await expect(middleware(makeRequest("/settings/plugins"))).rejects.toThrow(
      /MGM_PUBLIC_SUPABASE_URL/
    );
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});
