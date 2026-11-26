/**
 * Checks a bearer token with Supabase Auth (ADR-008 decision 6). Middleware
 * calls it for every request that carries one, before any route runs.
 */
import { createClient } from "@supabase/supabase-js";
import { callerFromClaims, claimsOfToken, type Caller, type CallerRefusal } from "./caller";

export type BearerCheck =
  | { ok: true; caller: Exclude<Caller, { kind: "browser" }>; userId: string }
  | { ok: false; reason: CallerRefusal | "auth_refused" };

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
 * When Auth stops answering it, every bearer request fails here with 401,
 * closed: switch this call, and the getUser() session checks on the clients
 * createClient (@/lib/supabase/server) builds, to `GET /oauth/userinfo`
 * (ADR-008 decision 6).
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
  }).auth;
  let userId: string | undefined;
  try {
    const { data, error } = await auth.getUser(token);
    userId = error ? undefined : data.user?.id;
  } catch {
    userId = undefined;
  }
  if (!userId) return { ok: false, reason: "auth_refused" };
  if (claims?.sub !== userId) return { ok: false, reason: "malformed" };
  return { ok: true, caller: read.caller, userId };
}
