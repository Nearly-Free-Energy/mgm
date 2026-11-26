/**
 * POST /api/auth/logout — ends the calling operator client's own session
 * (RFC #259 § 4, ADR-008 decisions 4 and 5, #297). `mgm logout` calls it,
 * then deletes its token file.
 *
 * Supabase Auth's own /logout refuses a client's token from v2.198.0, so MGM
 * ends the session itself, through fn_client_sessions_end
 * (20261126170000_client_sessions_end.sql), which only service_role may run.
 *
 * Only an operator client's bearer token is accepted, as the resolver reports
 * its kind (callerOf, @/lib/runtime/caller): a browser session signs out in
 * the browser, and an agent client is refused by middleware before this runs
 * (AGENT_ROUTES) and by the kind check here. The person, the client and the
 * session are the token's own claims (`sub`, `client_id`, `session_id`), read
 * once Supabase Auth has accepted the same token string (getUser()), and the
 * body is never read, so a request can end only the session that sent it.
 *
 * It ends that one session. The person's browser session, their other
 * clients and another `mgm` session of theirs stay signed in. Their consent
 * for the client stays too, so Connected apps keeps listing the client while
 * any session of it may be signed in, and the person can still revoke it
 * there (revoking ends every session of it). After it the session's
 * refresh fails, and Supabase Auth and MGM's routes refuse its access token
 * at once; the access token still works at the database API until it expires
 * (the project's JWT expiry; ADR-008 decision 4).
 *
 * Answers 204 with no body when the session is ended or was already gone.
 * Refusals: 401 for a session Auth no longer accepts or claims that do not
 * name one session, 403 `operator_client_only` for any caller but an operator
 * client, 500 when the database refuses. Middleware answers a bearer request
 * it does not accept first (src/middleware.ts, bearerRequest).
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { callerOf, claimsOfToken } from "@/lib/runtime/caller";
import { bearerCredential } from "@/lib/runtime/credential";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const caller = callerOf(supabase);
  if (caller.kind !== "operator") {
    return refusal(403, "operator_client_only", "Only the MGM command line signs out here. In a browser, use Sign out.");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return refusal(401, "unauthenticated", "Authentication required");

  // The token createClient built this client on; Auth has just accepted it.
  const credential = bearerCredential(request.headers.get("authorization"));
  const claims = credential?.ok ? claimsOfToken(credential.token) : null;
  const sessionId = claims?.session_id;
  if (
    !claims ||
    claims.sub !== user.id ||
    typeof claims.client_id !== "string" ||
    claims.client_id.toLowerCase() !== caller.clientId ||
    typeof sessionId !== "string" ||
    !UUID.test(sessionId)
  ) {
    return refusal(401, "unauthenticated", "Authentication required");
  }

  const { data, error } = await createServiceClient().rpc("fn_client_sessions_end", {
    _user_id: user.id,
    _client_id: caller.clientId,
    _session_id: sessionId,
  });
  const outcome = (data as { outcome?: string }[] | null)?.[0]?.outcome;
  if (error || (outcome !== "ended" && outcome !== "not_found")) {
    console.error(
      JSON.stringify({ event: "auth.logout", outcome: "error", client_id: caller.clientId, error: error?.message ?? "no answer" }),
    );
    return refusal(500, "logout_failed", "MGM could not end this session. Revoke the app from Connected apps instead.");
  }
  console.info(JSON.stringify({ event: "auth.logout", outcome, client_id: caller.clientId }));
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
