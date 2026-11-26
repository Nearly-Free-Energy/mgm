/**
 * Checks a bearer token with Supabase Auth (ADR-008 decision 6). Middleware
 * calls it for every request that carries one, before any route runs: first
 * the token's signature against the project's published signing keys, then
 * Supabase Auth's own answer about it.
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
 * The project's published signing keys (`/auth/v1/.well-known/jwks.json`),
 * the ES256 keys only, by key id. Supabase Auth signs every access token with
 * one of them (the project's key is ES256; middleware's getClaims() relies on
 * the same), and publishes a new key before it signs with it, so a token
 * whose key id is not in a set at most KEYS_TTL_MS old is refused without
 * fetching the keys again. If the project moves to another algorithm or a
 * shared-secret key, every bearer token is refused here as `auth_refused`:
 * revisit this with middleware's getClaims() note.
 */
export const KEYS_TTL_MS = 10 * 60_000;
/** How long a failed fetch of the keys is remembered before trying again. */
export const KEYS_RETRY_MS = 30_000;

type SigningKeys = { url: string; keys: Map<string, CryptoKey>; fetchedAt: number };
let signingKeys: SigningKeys | undefined;
let keysFailedAt: { url: string; at: number } | undefined;
let keysInFlight: { url: string; promise: Promise<SigningKeys | undefined> } | undefined;

/** For tests: forget the cached keys. */
export function resetSigningKeysForTests(): void {
  signingKeys = undefined;
  keysFailedAt = undefined;
  keysInFlight = undefined;
}

async function fetchSigningKeys(url: string): Promise<SigningKeys | undefined> {
  try {
    const res = await boundedFetch(`${url}/auth/v1/.well-known/jwks.json`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { keys?: unknown };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      if (typeof jwk !== "object" || jwk === null) continue;
      const k = jwk as JsonWebKey & { kid?: unknown; use?: unknown };
      if (typeof k.kid !== "string" || k.kty !== "EC" || k.crv !== "P-256") continue;
      if (k.alg !== undefined && k.alg !== "ES256") continue;
      if (k.use !== undefined && k.use !== "sig") continue;
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "EC", crv: "P-256", x: k.x, y: k.y },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        keys.set(k.kid, key);
      } catch {
        // A key that does not import verifies nothing; the others still do.
      }
    }
    return { url, keys, fetchedAt: Date.now() };
  } catch {
    return undefined;
  }
}

/**
 * The cached keys while fresh; otherwise one fetch shared by every request
 * that waits for it. A failed fetch keeps the last keys it had, if any, and
 * is not tried again for KEYS_RETRY_MS. Undefined: no keys to check with.
 */
async function currentSigningKeys(url: string): Promise<Map<string, CryptoKey> | undefined> {
  const now = Date.now();
  const cached = signingKeys?.url === url ? signingKeys : undefined;
  if (cached && now - cached.fetchedAt < KEYS_TTL_MS) return cached.keys;
  if (keysFailedAt?.url === url && now - keysFailedAt.at < KEYS_RETRY_MS) return cached?.keys;
  if (keysInFlight?.url !== url) {
    const promise = fetchSigningKeys(url).then((fetched) => {
      if (fetched) {
        signingKeys = fetched;
        keysFailedAt = undefined;
      } else {
        keysFailedAt = { url, at: Date.now() };
      }
      keysInFlight = undefined;
      return fetched;
    });
    keysInFlight = { url, promise };
  }
  const fetched = await keysInFlight!.promise;
  return fetched?.keys ?? cached?.keys;
}

/**
 * Whether the token is signed with ES256 by one of the project's published
 * keys and, when it carries `exp`, has not expired. `unavailable`: no keys
 * could be fetched, so nothing is known about the token.
 */
async function signatureCheck(token: string, url: string): Promise<"valid" | "invalid" | "unavailable"> {
  const parts = token.split(".");
  if (parts.length !== 3) return "invalid";
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return "invalid";
  }
  if (typeof header !== "object" || header === null || header.alg !== "ES256" || typeof header.kid !== "string") return "invalid";
  const keys = await currentSigningKeys(url);
  if (!keys) return "unavailable";
  const key = keys.get(header.kid);
  if (!key) return "invalid";
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.length !== 64) return "invalid";
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed);
  return ok ? "valid" : "invalid";
}

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
 * Reads the caller from the token's claims (callerFromClaims), checks the
 * token's signature against the project's published keys (signatureCheck)
 * and its expiry, then asks Supabase Auth for the token's user. A token
 * whose claims MGM would refuse anyway, or that no key of the project
 * signed, or that has expired, is refused without the round trip; every
 * token that could be accepted is asked about. Auth answers only for a token whose signature,
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
 * Every failure is closed. A refusal by Auth, a signature no published key
 * verifies, or an expired token is `auth_refused`; no answer about the
 * token (authUnavailable, or none within AUTH_TIMEOUT_MS), or no keys to
 * check its signature with, is `auth_unavailable`.
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
  // Only a token signed with one of the project's keys is worth asking Auth
  // about; the rest are refused here, without a call to Auth.
  const signature = await signatureCheck(token, settings.url);
  if (signature === "unavailable") return { ok: false, reason: "auth_unavailable" };
  if (signature === "invalid") return { ok: false, reason: "auth_refused" };
  const exp = claims?.exp;
  if (typeof exp === "number" && exp * 1000 <= Date.now()) return { ok: false, reason: "auth_refused" };
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
