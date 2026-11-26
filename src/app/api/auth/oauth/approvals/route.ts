/**
 * POST /api/auth/oauth/approvals — record a person's approval of one client
 * sign-in (RFC #259 § 1, ADR-008 decision 2, #271).
 *
 * MGM's consent page (/oauth/consent) calls this when the person clicks
 * Connect, before it asks Supabase Auth for the code. The access-token hook
 * (20261126090100) refuses the client's code exchange unless such a record
 * exists, younger than ten minutes, and uses it up.
 *
 * Body: { authorization_id }. Answers 201 { client_id, kind } once the record
 * exists; a second call for the same authorization writes nothing more and
 * answers the same. Refusals: 401 for a bearer token, a client's token in
 * the cookie, or no session; 403 for a cross-site request or a client MGM
 * does not list; 404 for an authorization MGM cannot find for this person;
 * 409 one already answered; 410 one expired; 415 a body that is not JSON;
 * 422 a malformed id.
 *
 * Middleware answers most bearer requests before this runs (src/middleware.ts,
 * bearerRequest): 400 with a session cookie as well, 403 while client tokens
 * are off or for an agent client, 401 for a token Supabase Auth does not
 * accept; and it answers 401 for a client's token in the session cookie. An
 * operator client's accepted token reaches this route, which refuses it.
 * The checks below stay as the route's own fence, whatever middleware does.
 *
 * Only the person's browser session may approve, from MGM's own page:
 *   - any Authorization header is refused before anything is read, so a
 *     client's token, which works at MGM's API routes, can never approve a
 *     sign-in;
 *   - a cookie session whose token carries client_id is a client's token put
 *     in a cookie, and is refused too;
 *   - the request must come from this site's own pages (Sec-Fetch-Site, or
 *     Origin where a browser sends no Sec-Fetch-Site).
 * The record is written as the service role only after getUser() has
 * checked the cookie session with Supabase Auth, for that user's id: the
 * approvals table has no grant to any signed-in role
 * (20261126090000). Staff and tenant-only people alike may approve; nothing
 * here reads a role.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAppOrigin } from "@/lib/config/app-url";
import { CONSENT_PROBLEMS, isAuthorizationId, recordClientApproval } from "@/lib/auth/client-consent";

const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** True when the request comes from one of this site's own pages. */
function fromThisSite(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const allowed = new Set([request.nextUrl.origin]);
  try {
    allowed.add(getAppOrigin());
  } catch {
    // MGM_APP_URL unset or invalid: the request's own origin only.
  }
  return allowed.has(origin);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (request.headers.has("authorization")) {
    return answer({ error: "Approve sign-ins from MGM's consent page in your browser." }, 401);
  }
  if (!fromThisSite(request)) {
    return answer({ error: "Approve sign-ins from MGM's consent page." }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return answer({ error: "Send the authorization as JSON." }, 415);
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const authorizationId = body?.authorization_id;
  if (!isAuthorizationId(authorizationId)) {
    return answer({ error: "This sign-in link is incomplete. Run mgm login again.", field: "authorization_id" }, 422);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return answer({ error: "Sign in to MGM, then try again." }, 401);
  }
  // getUser() answers for a client's token as for a browser session
  // (Supabase Auth v2.198.0 keeps GET /user open to client tokens), so the
  // token in the cookie is checked for the claim only a client's carries.
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims || claims.claims.sub !== user.id || "client_id" in claims.claims) {
    return answer({ error: "Sign in to MGM in this browser, then try again." }, 401);
  }

  const result = await recordClientApproval(createServiceClient(), authorizationId, user.id);
  if (result.outcome !== "ok") {
    const problem = CONSENT_PROBLEMS[result.outcome];
    return answer({ error: problem.message, outcome: result.outcome }, problem.status);
  }
  return answer({ client_id: result.client.id, kind: result.client.kind }, 201);
}
