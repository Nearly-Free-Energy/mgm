import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isReleasedRoute } from "@/lib/mgm/released-routes";

// Only authentication pages are public in the first MGM release. Inherited
// MBE payment links, customer APIs, and webhooks are blocked by the route
// allowlist before this session check runs.
const PUBLIC_PATHS = [
  "/login",
  "/accept-invite",
  "/forgot-password",
  "/reset-password",
  "/api/mgm/health",
];

export async function middleware(request: NextRequest) {
  // This fork deploys released MGM slices. Inherited MBE billing, payment,
  // and unreleased handlers must not become callable through deep links
  // or direct API requests before their Cordis plugins are released —
  // see src/lib/mgm/released-routes.ts for the explicit allowlist.
  if (!isReleasedRoute(request.nextUrl.pathname)) {
    return new NextResponse("Not available in this MGM release", { status: 404 });
  }
  let supabaseResponse = NextResponse.next({
    request,
  });

  const cookieName = process.env.NEXT_PUBLIC_SUPABASE_COOKIE_NAME;

  const supabase = createServerClient(
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieName ? { cookieOptions: { name: cookieName } } : {}),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicPath = PUBLIC_PATHS.some((p) =>
    request.nextUrl.pathname.startsWith(p)
  );

  if (!user && !isPublicPath) {
    // API routes return 401 JSON instead of redirecting to login
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && request.nextUrl.pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Existing management links target the old microgrid overview, which
  // renders OpenEMS and billing widgets. Land on the household list instead.
  if (/^\/microgrids\/[^/]+\/?$/.test(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `${request.nextUrl.pathname.replace(/\/$/, "")}/setup/households`;
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
