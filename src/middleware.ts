import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { getServerSupabaseSettings } from "@/lib/config/public-runtime-config";
import { cookieOptionsFor } from "@/lib/config/cookie-options";
import { notReleasedResponse } from "@/lib/public-html/not-released";
import {
  buildContentSecurityPolicy,
  cspHeaderName,
  newNonce,
} from "@/lib/mgm/content-security-policy";
import {
  RETURN_PATH_PARAM,
  returnPathFor,
  safeReturnPath,
} from "@/lib/auth/return-path";

// Only authentication pages are public in the first MGM release. Inherited
// legacy payment links, customer APIs, and webhooks are blocked by the route
// allowlist before this session check runs.
const PUBLIC_PATHS = [
  "/login",
  "/accept-invite",
  "/forgot-password",
  "/reset-password",
  "/api/mgm/health",
  // Release 4 (payments): Pesapal IPN webhook is an unauthenticated
  // server-to-server callback with no MGM session.
  "/api/payments/ipn",
  // The web app manifest (src/app/manifest.ts). Browsers fetch it without
  // cookies, so a signed-in person's request arrives signed out too.
  "/manifest.webmanifest",
];

/**
 * The request header that carries a page request's path and query to
 * layouts, which Next.js does not otherwise give them. Middleware always
 * replaces it on the paths the matcher below matches. The matcher skips
 * static-file paths, and one with no file in public/ reaches the (gui)
 * catch-all page (src/app/(gui)/[...path]/page.tsx) without this
 * middleware, so there the (gui) layout can receive a value the client
 * sent; that page answers 404 for such a path, because none is released.
 * It is a hint for display and for choosing among the caller's visible
 * organizations, never an authorization; if a reader starts using it for
 * anything else, revisit.
 */
const MGM_PATH_HEADER = "x-mgm-path";
const MGM_PATH_MAX_LENGTH = 2048;

/**
 * Release 4 public payment surfaces (no MGM session). The line-item id /
 * short slug is the bearer token and verification is always server-side.
 * Deliberately narrow: only the customer redirect (`/pay`, `/p/<slug>`)
 * and the IPN webhook are public. Sibling mutation routes
 * (`/url`, `/payment-status`, attempts refresh/reconcile) stay
 * session-gated — guards against a broad `/api/billing-line-items/` prefix
 * silently exposing them.
 */
function isPublicPaymentRoute(pathname: string): boolean {
  if (["/api/payments/ipn", "/api/payments/reconcile-worker", "/payment/callback"].includes(pathname)) return true;
  if (/^\/p\/[^/]+$/.test(pathname)) return true;
  if (/^\/api\/billing-line-items\/[^/]+\/pay$/.test(pathname)) return true;
  return false;
}

export async function middleware(request: NextRequest) {
  // This fork deploys released MGM slices. Inherited legacy billing, payment,
  // and unreleased handlers must not become callable through deep links
  // or direct API requests before their Cordis plugins are released —
  // see src/lib/mgm/released-routes.ts for the explicit allowlist.
  if (!isReleasedRoute(request.nextUrl.pathname)) {
    // API callers keep the plain-text body they have always had. A person
    // following a link gets a page with a way back to the start page.
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return new NextResponse("Not available in this MGM release", { status: 404 });
    }
    return notReleasedResponse(request.headers.get("accept-language"));
  }
  // Same validated runtime configuration as the server and browser clients
  // (#46). Missing or invalid settings throw a RuntimeConfigError that names
  // the variable, never its value, and the request fails closed.
  const settings = getServerSupabaseSettings();

  // Pages get the request path and a content security policy with a fresh
  // nonce; API requests get neither.
  const isApi = request.nextUrl.pathname.startsWith("/api/");
  const pathWithQuery = `${request.nextUrl.pathname}${request.nextUrl.search}`.slice(
    0,
    MGM_PATH_MAX_LENGTH,
  );
  const csp = isApi
    ? null
    : {
        header: cspHeaderName(),
        policy: buildContentSecurityPolicy({
          nonce: newNonce(),
          supabaseUrl: settings.publicConfig.supabaseUrl,
          development: process.env.NODE_ENV === "development",
        }),
      };

  // Rebuilt on every call: setAll writes refreshed session cookies into
  // request.headers, and Server Components must see them alongside the
  // forwarded headers. Next.js reads the nonce from the forwarded policy.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.delete(MGM_PATH_HEADER);
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
    if (!isApi) headers.set(MGM_PATH_HEADER, pathWithQuery);
    if (csp) headers.set(csp.header, csp.policy);
    const response = NextResponse.next({ request: { headers } });
    if (csp) response.headers.set(csp.header, csp.policy);
    return response;
  };

  let supabaseResponse = forward();

  const supabase = createServerClient(
    settings.url,
    settings.anonKey,
    {
      ...cookieOptionsFor(settings.publicConfig),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = forward();
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getClaims() refreshes an expiring session through setAll as getUser()
  // did, then verifies the access token's signature and expiry locally
  // against the project's published keys, which auth-js caches for ten
  // minutes. Middleware runs in the Vercel region nearest the visitor, not
  // beside the database, so this saves a cross-region Auth call per request.
  // It does not ask Auth whether the session still exists: a session signed
  // out elsewhere passes until its access token expires. That is safe only
  // while every page and route that reaches the service role or a stored
  // credential asks Auth itself first; service-role-session-check.test.ts
  // finds them through the import graph, and a new one that does not breaks
  // this. Local verification needs an asymmetric signing key (the project's
  // is ES256); with a shared-secret key getClaims() falls back to getUser()
  // and saves nothing. If the project's key type changes, revisit.
  let subject: string | undefined;
  try {
    const { data } = await supabase.auth.getClaims();
    subject = data?.claims.sub;
  } catch {
    // getClaims() throws, rather than returning an error, on some malformed
    // tokens (no exp claim, an unsupported alg, a payload that is not JSON)
    // that getUser() reported as no user. Treat them as signed out so a bad
    // cookie reaches /login instead of failing every route.
    subject = undefined;
  }
  const signedIn = typeof subject === "string" && subject !== "";

  const isPublicPath =
    PUBLIC_PATHS.some((p) => request.nextUrl.pathname === p) ||
    isPublicPaymentRoute(request.nextUrl.pathname);

  if (!signedIn && !isPublicPath) {
    // API routes return 401 JSON instead of redirecting to login
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }
    // The page asked for goes along in one parameter, and the login page
    // returns there after sign-in (#126). The original query is not carried
    // over on its own: it belongs to the page, not to /login.
    const url = new URL("/login", request.nextUrl.origin);
    const next = returnPathFor(request.nextUrl.pathname, request.nextUrl.search);
    if (next) url.searchParams.set(RETURN_PATH_PARAM, next);
    return NextResponse.redirect(url);
  }

  if (signedIn && request.nextUrl.pathname.startsWith("/login")) {
    // Claims cannot tell a live session from one signed out elsewhere
    // (signOut() ends the user's sessions on every device), so ask Auth
    // before sending the user away from /login. The (gui) layout and
    // /setup call getUser() and send a dead session here; redirecting on
    // claims alone would bounce between them until the token expired. For a
    // dead session the failed getUser() also clears its cookies through
    // setAll, on the supabaseResponse returned below. If those pages stop
    // calling getUser(), revisit.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      // Same destination the login page would choose, so a sign-in finished
      // in another tab still lands on the page that was asked for.
      const url = new URL(
        safeReturnPath(request.nextUrl.searchParams.get(RETURN_PATH_PARAM)),
        request.nextUrl.origin,
      );
      return NextResponse.redirect(url);
    }
  }

  // A microgrid's own URL opens its Operations day view, keeping the query
  // (?date= picks the day). In-app links go there directly through
  // microgridHref (src/lib/microgrid-links.ts); this keeps bookmarks and old
  // links working, and microgrid-links.test.ts fails if the two disagree. If
  // /microgrids/<id> should show a page of its own, delete this redirect and
  // point microgridHref at that URL.
  if (/^\/microgrids\/[^/]+\/?$/.test(request.nextUrl.pathname)) {
    // A plain URL, not request.nextUrl.clone(): NextURL remembers a trailing
    // slash on the original path and adds it back to the new one.
    const url = new URL(request.nextUrl.href);
    url.pathname = `${request.nextUrl.pathname.replace(/\/$/, "")}/operations`;
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  // Node.js runtime (#46): the middleware reads the request-time runtime
  // configuration from the real process environment, as the server does,
  // instead of the Edge sandbox's environment, so one build or container
  // image serves any installation. Supported for middleware.ts by the
  // installed Next.js (16.x). Moving to proxy.ts (always Node.js) means
  // renaming the file and its export AND deleting this `runtime` line and
  // the `config.runtime` assertion in src/lib/__tests__/middleware.test.ts:
  // Next.js 16 fails `next build` on a `runtime` in a Proxy file ("Route
  // segment config is not allowed in Proxy file"). If Next.js drops that
  // check, revisit.
  runtime: "nodejs",
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - gui-styles/ (compiled GUI stylesheets, static files in public/)
     * - favicon.ico (favicon file)
     * - images in public/, which sit at the top level or in icons/. Deeper
     *   paths ending in an image extension still match, because a dynamic
     *   page segment such as /organizations/x.png must pass through here.
     */
    "/((?!_next/static|_next/image|gui-styles/|favicon.ico|(?:icons/)?[^/]+\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
