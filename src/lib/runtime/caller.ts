/**
 * Who is calling: a person's browser session, or a client acting as that
 * person (RFC #259 § 2, ADR-008 decisions 2 and 6).
 *
 * The kind is read from an access token's claims, and nowhere else: this is
 * the only file outside tests that reads `mgm_client_kind`, the claim the
 * token hook (20261126090100_auth_access_token_hook_clients.sql) writes into
 * a client's token. person-boundary.test.ts pins that. If the hook renames
 * the claim or starts writing it into a browser session's token, revisit.
 *
 * Claims decide the kind only once Supabase Auth has accepted the same token
 * string: middleware asks it before any route runs (verifyBearer in
 * ./bearer.ts), and every session check on the route's client asks it again
 * (getUser). A token whose claims were altered fails both.
 *
 * No React, Next.js or Supabase import, so middleware, routes and tests share
 * it.
 */

/** A browser session (cookie), the CLI (operator client) or the assistant bridge (agent client). */
export type CallerKind = "browser" | "operator" | "agent";

export type Caller = Readonly<
  | { kind: "browser" }
  | {
      kind: "operator" | "agent";
      /** The OAuth client's id (`client_id`), a uuid in lower case. */
      clientId: string;
    }
>;

/** How the credential arrived: the session cookie or `Authorization: Bearer`. */
export type Transport = "cookie" | "bearer";

/** Why claims name no caller MGM accepts. */
export type CallerRefusal =
  /** A client's token in the session cookie: treated as signed out. */
  | "client_token_in_cookie"
  /** A bearer token that names no client: a browser session's token used from a script. */
  | "not_a_client"
  /** client_id with no kind: the hook was off when it was issued (ADR-008 decision 2). */
  | "no_kind"
  /** Anything else malformed: no subject, a client id that is not a uuid, an unknown kind, or a role the kind never has. */
  | "malformed";

export type CallerResult = { ok: true; caller: Caller } | { ok: false; reason: CallerRefusal };

export const BROWSER: Caller = Object.freeze({ kind: "browser" });

const KIND_CLAIM = "mgm_client_kind";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The database role each client kind's token runs as. An operator token is
 * the person's own (`authenticated`); an agent token runs as `mgm_agent`
 * once #274 makes the hook set it. Until then the hook refuses every agent
 * sign-in, so no agent token exists, and one with `authenticated` would
 * carry the person's full authority at the database API (ADR-008 decision
 * 7): it is refused here too. If the hook's roles change, revisit.
 */
const ROLE_OF: Record<"operator" | "agent", string> = { operator: "authenticated", agent: "mgm_agent" };

/**
 * The caller the claims of a token name, arriving by `transport`.
 *
 * - Cookie: a browser session, whose token carries no `client_id` (the hook
 *   returns a browser's event unchanged, and Supabase Auth v2.198.0 sets the
 *   claim only for a session an OAuth client started). A client's token
 *   planted in the cookie is refused, as the consent page's route refuses
 *   it (#271).
 * - Bearer: always a client. `client_id` must be a uuid, `mgm_client_kind`
 *   operator or agent, and `role` the one that kind runs as. A token with
 *   `client_id` and no kind was issued while the hook was off and is
 *   refused (ADR-008 decision 2). A token with no `client_id` is a browser
 *   session's, copied into a script, and is refused too, so a bearer
 *   request is always a client and the person can revoke it.
 */
export function callerFromClaims(claims: unknown, transport: Transport): CallerResult {
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return { ok: false, reason: "malformed" };
  const c = claims as Record<string, unknown>;
  if (typeof c.sub !== "string" || c.sub === "") return { ok: false, reason: "malformed" };
  const hasClient = Object.hasOwn(c, "client_id");
  if (transport === "cookie") {
    return hasClient ? { ok: false, reason: "client_token_in_cookie" } : { ok: true, caller: BROWSER };
  }
  if (!hasClient) return { ok: false, reason: "not_a_client" };
  const clientId = c.client_id;
  if (typeof clientId !== "string" || !UUID.test(clientId)) return { ok: false, reason: "malformed" };
  if (!Object.hasOwn(c, KIND_CLAIM) || c[KIND_CLAIM] === null || c[KIND_CLAIM] === "") return { ok: false, reason: "no_kind" };
  const kind = c[KIND_CLAIM];
  if (kind !== "operator" && kind !== "agent") return { ok: false, reason: "malformed" };
  if (c.role !== ROLE_OF[kind]) return { ok: false, reason: "malformed" };
  return { ok: true, caller: Object.freeze({ kind, clientId: clientId.toLowerCase() }) };
}

/**
 * The payload of a JWT, decoded and not verified, or null when it is not
 * one. Callers act on it only together with Supabase Auth's acceptance of the
 * same token (see the header).
 */
export function claimsOfToken(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "" || !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The caller each Supabase client made for a request acts for. Keyed weakly
 * by the client object, so nothing outlives the request that made it.
 */
const CALLERS = new WeakMap<object, Caller>();

/**
 * Records who `client` acts for. createClient (@/lib/supabase/server) calls
 * it, through bearerClientFor, for each client it builds on a bearer token;
 * a cookie client is not recorded and reads as a browser session through
 * callerOf's fallback.
 */
export function recordCaller(client: object, caller: Caller): void {
  CALLERS.set(client, caller);
}

/**
 * Who `client` acts for. A client not built on a bearer token (createClient's
 * cookie client, the service role, a test's stub) reads as a browser
 * session: the kind restricts only clients, and every client token reaches
 * MGM's code through createClient, the one place that builds a client from
 * a bearer token. A guard test in ./__tests__/request-session.test.ts pins
 * the files that may build a Supabase client at all; if another place
 * starts building one on a bearer token, it must record its caller here.
 */
export function callerOf(client: object): Caller {
  return CALLERS.get(client) ?? BROWSER;
}
