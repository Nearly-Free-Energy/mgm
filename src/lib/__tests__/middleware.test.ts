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
 *
 * Located in src/lib/__tests__ so it runs under the `lib` vitest
 * project (vitest.config.ts only globs src/lib, src/components, and
 * src/app).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { renderNotReleasedPage } from "@/lib/public-html/not-released";
import { PUBLIC_PAGE_SECURITY_HEADERS } from "@/lib/public-html/page";

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
    // until it expires. The dashboard layout's getUser() sends it to /login;
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
    const res = await middleware(makeRequest("/settings/plugins"));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("refreshed");
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
