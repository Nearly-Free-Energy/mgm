/**
 * Checks a bearer token with Supabase Auth (ADR-008 decision 6). Middleware
 * calls it for every request that carries one, before any route runs.
 */
import { createClient } from "@supabase/supabase-js";
import { callerFromClaims, claimsOfToken, type Caller, type CallerRefusal } from "./caller";

export type BearerCheck =
  | { ok: true; caller: Exclude<Caller, { kind: "browser" }>; userId: string }
  | {
      ok: false;
      /**
       * `auth_refused`: Supabase Auth answered and does not accept the token
       * (a revoked client, an expired token). `auth_unavailable`: it gave no
       * answer about the token (see authUnavailable), so the token may still
       * be good; middleware answers 503 rather than 401, so a client retries
       * instead of signing the person in again.
       */
      reason: CallerRefusal | "auth_refused" | "auth_unavailable";
    };

/**
 * How long middleware waits for Supabase Auth's answer before refusing the
 * request as `auth_unavailable`, so a hung Auth does not hold every bearer
 * request until the platform's function limit.
 */
export const AUTH_TIMEOUT_MS = 5_000;

/** fetch, bounded by AUTH_TIMEOUT_MS on top of any signal the caller set. */
function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}

/**
 * True when Supabase Auth gave no answer about the token: it could not be
 * reached or timed out (auth-js reports both as AuthRetryableFetchError,
 * status 0), answered with a server error (502 to 504 also come as that
 * error, any other 5xx as an AuthApiError with its status) or a body that is
 * not its JSON (AuthUnknownError, no status), or asked to slow down (429).
 * Any other 4xx is Auth refusing the token.
 */
function authUnavailable(error: unknown): boolean {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status !== "number" || status === 0 || status === 429 || status >= 500;
}

/**
 * Reads the caller from the token's claims (callerFromClaims), then asks
 * Supabase Auth for the token's user. A token whose claims MGM would refuse
 * anyway is refused without the round trip; every token that could be
 * accepted is asked about. Auth answers only for a token whose signature,
 * expiry and session it accepts, so a revoked client (DELETE
 * /user/oauth/grants deletes its sessions) is refused on the next request,
 * and the claims of a token Auth accepted can be trusted, as auth-js trusts
 * them in getClaims().
 *
 * It asks `GET /user`, the one user endpoint Supabase Auth v2.198.0 still
 * answers for a client's token (marked there as a temporary exception).
 * When Auth stops answering it, it refuses the token with a 4xx, so every
 * bearer request fails here as `auth_refused` (401), closed: switch this
 * call, and the getUser() session checks on the clients createClient
 * (@/lib/supabase/server) builds, to `GET /oauth/userinfo` (ADR-008
 * decision 6).
 *
 * Every failure is closed. A refusal by Auth is `auth_refused`; no answer
 * about the token (authUnavailable, or none within AUTH_TIMEOUT_MS) is
 * `auth_unavailable`.
 *
 * The client stores no session and refreshes nothing.
 */
export async function verifyBearer(
  token: string,
  settings: { url: string; anonKey: string },
): Promise<BearerCheck> {
  const claims = claimsOfToken(token);
  const read = callerFromClaims(claims, "bearer");
  if (!read.ok) return read;
  if (read.caller.kind === "browser") return { ok: false, reason: "not_a_client" };
  const auth = createClient(settings.url, settings.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  }).auth;
  let userId: string | undefined;
  try {
    const { data, error } = await auth.getUser(token);
    if (error) return { ok: false, reason: authUnavailable(error) ? "auth_unavailable" : "auth_refused" };
    userId = data.user?.id;
  } catch {
    // auth-js returns Auth's errors; a throw is something else going wrong
    // before an answer, not a refusal of the token.
    return { ok: false, reason: "auth_unavailable" };
  }
  if (!userId) return { ok: false, reason: "auth_refused" };
  if (claims?.sub !== userId) return { ok: false, reason: "malformed" };
  return { ok: true, caller: read.caller, userId };
}
