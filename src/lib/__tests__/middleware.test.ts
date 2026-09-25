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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock @supabase/ssr so getUser() resolves to a deterministic value.
const getUserMock = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: getUserMock,
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockReset();
  // Provide minimal env for the middleware to construct a client.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
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
  it.each([
    "/api/billing/generate",
    "/api/v1/billing/generate",
    "/api/openems/energy",
    "/api/microgrids/grid-1/openems-backend",
    "/microgrids/grid-1/billing",
    "/microgrids/grid-1/setup/edges",
    "/communities/community-1/payment",
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

  // #223: /p/<slug> is the consumer-facing payment-link indirection.
  // Customers arrive with no MBE session; the middleware MUST pass-through
  // (the route's service-role SELECT is the access-control gate).
  it("blocks inherited public payment links in Release 1", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/p/Kp9XrA"));

    expect(res.status).toBe(404);
  });

  it("blocks inherited payment links for authenticated users too", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/p/Kp9XrA"));

    // No redirect — neither to /login nor to / (the authenticated-on-/login
    // branch is the only place a logged-in user gets redirected to root).
    expect(res.status).toBe(404);
  });

  // #294: /api/payments/ipn is Pesapal's IPN webhook — an unauthenticated
  // server-to-server callback with no MBE session. The middleware MUST
  // pass it through, otherwise it 401s ("Authentication required") before
  // the route handler runs and payments never auto-mark. Same class as the
  // /api/v1/ hotfix (#267).
  it("blocks inherited payment webhooks in Release 1", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/api/payments/ipn"));

    // Pass-through (NextResponse.next), NOT the 401 JSON that API routes get
    // when unauthenticated and non-public.
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  // Path scoping: only the exact /api/payments/ipn path is public. Sibling
  // payment routes (auth-gated payment-status mutations) must still 401 an
  // unauthenticated API request. Guards against a broad /api/payments/
  // prefix silently exposing them.
  it("blocks inherited payment-status routes", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/api/payments/status"));

    // API routes return 401 JSON (not a redirect) when non-public.
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});
