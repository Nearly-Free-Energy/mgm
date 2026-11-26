/**
 * How a request presents its session (RFC #259 § 2, ADR-008 decision 6): the
 * session cookie, `Authorization: Bearer <token>`, or neither. Shared by
 * middleware, which decides, and createClient (@/lib/supabase/server), which
 * builds the client the decision calls for.
 *
 * No React, Next.js or Supabase import, so middleware, routes and tests share
 * it. It uses node:crypto, which middleware has because it runs on the
 * Node.js runtime (config.runtime in src/middleware.ts).
 */
import { createHmac } from "node:crypto";
import { secretMatches } from "@/lib/security/constant-time";

/**
 * The request header middleware sets on a request whose bearer token it
 * accepted, after deleting any value the client sent, as it does for
 * x-mgm-path. Its value is credentialMark(token): a MAC of the token under a
 * server-only key, so only a process holding that key can make it, never the
 * client. createClient builds a bearer client only when the mark matches the
 * request's token, and refuses a bearer token without it, so a bearer token
 * never opens a page or reaches a route middleware did not check, even one
 * the middleware matcher skips. It says which client to build, never who the
 * caller is: the kind is read again from the token (./caller.ts) and the
 * token checked again by the route's own getUser().
 */
export const CREDENTIAL_HEADER = "x-mgm-credential";

/**
 * The server-only setting the mark is keyed with. SUPABASE_SERVICE_ROLE_KEY
 * is required on every installation (docs/setup.md) and never reaches a
 * browser, and middleware and the routes read the same environment. If the
 * installation ever runs middleware where that key is not set, or the key
 * is ever sent to a browser, revisit: the mark is then never made, or
 * forgeable.
 */
const MARK_KEY_VARIABLE = "SUPABASE_SERVICE_ROLE_KEY";
/** Separates this MAC from any other use of the key. */
const MARK_CONTEXT = "mgm-credential-mark-v1";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The mark middleware puts on an accepted bearer request: HMAC-SHA256 of the
 * token, keyed with SUPABASE_SERVICE_ROLE_KEY, or null when that key is not
 * set (middleware then refuses every bearer token).
 */
export function credentialMark(token: string, env: Env = process.env): string | null {
  const key = env[MARK_KEY_VARIABLE];
  if (!key) return null;
  return createHmac("sha256", key).update(`${MARK_CONTEXT}\u0000${token}`, "utf8").digest("base64url");
}

/** True only when `mark` is the mark for `token`, compared in constant time. */
export function credentialMarkMatches(token: string, mark: string | null, env: Env = process.env): boolean {
  const expected = credentialMark(token, env);
  return expected !== null && secretMatches(expected, mark);
}

/** A JWT's three base64url parts. */
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type BearerCredential = { ok: true; token: string } | { ok: false };

/**
 * The bearer credential an Authorization header presents: null when there is
 * no header or it uses another scheme (Basic, say, from a proxy in front of
 * the installation), else the token, or `{ ok: false }` when the Bearer
 * scheme carries no single well-formed token. The scheme is matched without
 * regard to case (RFC 9110 § 11.1).
 */
export function bearerCredential(authorization: string | null): BearerCredential | null {
  if (authorization === null) return null;
  const value = authorization.trim();
  if (!/^bearer(?:\s|$)/i.test(value)) return null;
  const token = value.slice("bearer".length).trim();
  return TOKEN.test(token) ? { ok: true, token } : { ok: false };
}

/**
 * Whether `cookies` carry the session cookie `key` or one of its chunks
 * (`key.0`, `key.1`, …, as @supabase/ssr splits a long session), with a
 * value. A stale or invalid session cookie still counts: a request that
 * sends any session cookie and a bearer token is refused, so it is never a
 * guess which one acts.
 */
export function sessionCookiePresent(cookies: readonly { name: string; value: string }[], key: string): boolean {
  return cookies.some(
    ({ name, value }) =>
      value !== "" && (name === key || (name.startsWith(`${key}.`) && /^(?:0|[1-9][0-9]*)$/.test(name.slice(key.length + 1)))),
  );
}
