/**
 * Middleware tests (UX5d / #190).
 *
 * Coverage (per AC8 + AC9 of #190):
 *   - Unauthenticated GET on /forgot-password is NOT redirected to /login.
 *   - Unauthenticated GET on /reset-password is NOT redirected to /login.
 *   - Public-paths check still allows /login and /accept-invite (UX5c).
 *   - Unauthenticated GET on a private path (/dashboard) IS redirected.
 *
 * Located in src/lib/__tests__ so it runs under the `lib` vitest
 * project (vitest.config.ts only globs src/lib, src/components, and
 * src/app).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Mock @supabase/ssr so getUser() resolves to a deterministic value.
const getUserMock = vi.fn();
const createServerClientMock = vi.fn((..._args: unknown[]) => ({
  auth: {
    getUser: getUserMock,
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockReset();
  // Provide minimal request-time runtime configuration (#46).
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadMiddleware() {
  vi.resetModules();
  return (await import("../../middleware")).middleware;
}

function makeRequest(pathname: string) {
  return new NextRequest(`http://localhost${pathname}`);
}

describe("middleware PUBLIC_PATHS", () => {
  it("keeps the health endpoint available without a session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/api/mgm/health"));
    expect(res.status).toBe(200);
  });

  it("allows the old review bookmark to reach its dashboard redirect", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/review"));
    expect(res.status).toBe(200);
  });
  it.each([
    "/api/v1/billing/generate",
    "/api/openems/energy",
  ])("returns 404 for unreleased route %s even when signed in", async (path) => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
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
  ])("permits released management route %s", async (path) => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest(path));
    expect(res.status).toBe(200);
  });

  it("redirects microgrid detail away from the legacy OpenEMS overview", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/microgrids/grid-1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/microgrids/grid-1/setup/households");
  });
  it("allows unauthenticated GET on /forgot-password (no redirect)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/forgot-password"));

    // Pass-through (NextResponse.next), not a redirect to /login.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /reset-password (no redirect)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/reset-password"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /login (regression)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/login"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /accept-invite (regression — UX5c)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/accept-invite"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("redirects unauthenticated GET on an available private path to /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/communities"));

    // NextResponse.redirect sets a 3xx and a Location header.
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/login$/);
  });

  // Release 4 (payments): /p/<slug> is the consumer-facing payment-link
  // indirection. Customers arrive with no MGM session; the middleware MUST
  // pass-through (the route's service-role SELECT is the access gate).
  it("passes public payment links through without a session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/p/Kp9XrA"));

    expect(res.status).toBe(200);
  });

  it("passes payment links for authenticated users too", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
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
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
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
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/api/payments/status"));

    // API routes return 401 JSON (not a redirect) when non-public.
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes the public customer pay redirect without a session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(
      makeRequest("/api/billing-line-items/12345678-1234-1234-1234-123456789012/pay")
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps the operator payment-url mint session-gated", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(
      makeRequest("/api/billing-line-items/12345678-1234-1234-1234-123456789012/url")
    );

    expect(res.status).toBe(401);
  });
  it.each(["/api/payments/reconcile-worker", "/payment/callback"])("lets %s reach its own server-side validation without a session", async path => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();
    expect((await middleware(makeRequest(path))).status).toBe(200);
  });
  it("does not exempt worker sibling paths", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();
    expect((await middleware(makeRequest("/api/payments/reconcile-worker/extra"))).status).toBe(404);
  });

});

describe("middleware runtime configuration (#46)", () => {
  it.each([
    {
      env: {
        MGM_PUBLIC_SUPABASE_URL: "https://alpha.example.test",
        MGM_PUBLIC_SUPABASE_ANON_KEY: "anon-alpha",
        MGM_PUBLIC_SUPABASE_COOKIE_NAME: "sb-alpha-auth-token",
        SUPABASE_INTERNAL_URL: "",
      },
      url: "https://alpha.example.test",
      key: "anon-alpha",
      cookie: { cookieOptions: { name: "sb-alpha-auth-token" } },
    },
    {
      env: {
        MGM_PUBLIC_SUPABASE_URL: "http://localhost:54321",
        MGM_PUBLIC_SUPABASE_ANON_KEY: "anon-beta",
        MGM_PUBLIC_SUPABASE_COOKIE_NAME: "",
        SUPABASE_INTERNAL_URL: "http://kong:8000",
      },
      url: "http://kong:8000",
      key: "anon-beta",
      cookie: {},
    },
  ])("builds its Supabase client from the request-time settings ($url)", async ({ env, url, key, cookie }) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
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

  it("fails closed, naming the variable, when configuration is missing", async () => {
    for (const name of [
      "MGM_PUBLIC_SUPABASE_URL",
      "MGM_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]) {
      vi.stubEnv(name, "");
    }
    const middleware = await loadMiddleware();
    await expect(middleware(makeRequest("/settings/plugins"))).rejects.toThrow(
      /MGM_PUBLIC_SUPABASE_URL/
    );
    expect(createServerClientMock).not.toHaveBeenCalled();
  });
});
