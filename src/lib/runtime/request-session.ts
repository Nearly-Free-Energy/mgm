import "server-only";

/**
 * The route side of the session resolver (RFC #259 § 2, ADR-008 decision 6).
 * createClient (@/lib/supabase/server) calls bearerClientFor first, and
 * builds the cookie client as before when it returns null, so every route,
 * page and GUI host read that already takes its client from createClient
 * takes a bearer request's from here, unchanged.
 */
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { clientTokensAccepted } from "@/lib/config/client-tokens";
import { getServerSupabaseSettings } from "@/lib/config/public-runtime-config";
import { callerFromClaims, claimsOfToken, recordCaller } from "./caller";
import { CREDENTIAL_HEADER, bearerCredential, credentialMarkMatches } from "./credential";

/**
 * A client acting as the bearer token's person, or null when the request
 * carries no bearer token (the cookie client is then the caller's).
 *
 * Throws when the request carries a bearer token middleware did not accept
 * as one: CREDENTIAL_HEADER missing, or not the mark for this token
 * (credentialMark, ./credential.ts), which only a process holding the
 * server-only key makes, so a mark the client set itself is refused. That
 * covers a page, which is cookie-only, and a page or route the middleware
 * matcher skipped. It also throws while MGM_CLIENT_TOKENS is off, so the
 * switch holds on this path too, and for claims middleware would have
 * refused. A throw is a 500, never a session.
 *
 * The token goes on every request the client makes, as the global
 * Authorization header: PostgREST and Storage run as the person under
 * row-level security, and `auth.getUser()` with no argument asks Supabase
 * Auth about this token (`GET /user`), so getCurrentUserAccess,
 * authorizeOrganization, authorizeTenant and every other getUser()-backed
 * check work on it unchanged, and refuse a revoked client at once. The
 * `accessToken` option of supabase-js is not used: it makes every
 * `auth.*` call throw. If supabase-js stops sending the global header to
 * Auth on `getUser()` with no session, every bearer request is refused,
 * closed; revisit.
 *
 * The client records its caller (recordCaller), which openOrganizationScope
 * puts on mgmRequest and the GUI host on its context.
 */
export function bearerClientFor(headers: Headers): SupabaseClient | null {
  const credential = bearerCredential(headers.get("authorization"));
  if (credential === null) return null;
  if (!clientTokensAccepted()) throw new Error("A bearer token reached createClient while MGM_CLIENT_TOKENS is off");
  if (!credential.ok) throw new Error("A malformed bearer token reached createClient");
  if (!credentialMarkMatches(credential.token, headers.get(CREDENTIAL_HEADER))) {
    throw new Error("A bearer token reached a client that middleware did not accept it for");
  }
  const read = callerFromClaims(claimsOfToken(credential.token), "bearer");
  if (!read.ok || read.caller.kind === "browser") throw new Error("A bearer token naming no accepted client reached createClient");
  const settings = getServerSupabaseSettings();
  const client = createSupabaseClient(settings.url, settings.anonKey, {
    global: { headers: { Authorization: `Bearer ${credential.token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  recordCaller(client, read.caller);
  return client;
}
