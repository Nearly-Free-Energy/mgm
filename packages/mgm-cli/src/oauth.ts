/**
 * The sign-in itself (RFC #259 § 1, ADR-008 decisions 1 and 3): an
 * authorization code request with PKCE (S256 only) and a fresh state, the
 * code exchanged with the verifier, and refreshes, all at Supabase Auth's
 * OAuth server as the discovery answer names it.
 */
import { createHash, randomBytes } from "node:crypto";
import { CliError } from "./errors.ts";
import { type Fetch, readJson, readRefusal, send } from "./http.ts";

/**
 * The only scope the CLI asks for. Never `openid`: the token hook refuses a
 * client sign-in that asks for it (ADR-008 decision 2), and MGM's clients
 * get an access token and a refresh token, nothing else. Sent explicitly, so
 * a project's own default scope never applies.
 */
export const SCOPE = "email";

/** A PKCE verifier: 32 random bytes, base64url (43 characters, within RFC 7636's 43 to 128). */
export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 challenge for `verifier`. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A fresh state: 32 random bytes, base64url, the shape the code page accepts (pasted-code.ts). */
export function newState(): string {
  return randomBytes(32).toString("base64url");
}

/** The address the browser opens to start the sign-in. */
export function authorizeAddress(
  authorizeUrl: string,
  o: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    scope: SCOPE,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** What Supabase Auth's token endpoint gives a client. */
export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

/** A refusal from the token endpoint (4xx): the code or the refresh token is no longer good. */
export class TokenRefused extends CliError {
  constructor(message: string) {
    super("token_refused", message);
  }
}

type TokenEndpoint = { tokenUrl: string; anonKey: string; clientId: string };

async function tokenRequest(fetch: Fetch, endpoint: TokenEndpoint, form: Record<string, string>, now: () => number): Promise<Tokens> {
  const startedAt = now();
  const res = await send(fetch, endpoint.tokenUrl, {
    method: "POST",
    headers: { apikey: endpoint.anonKey, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...form, client_id: endpoint.clientId }).toString(),
  });
  if (res.status === 429) {
    throw new CliError("rate_limited", "The sign-in server is busy (429). Wait a minute and try again.");
  }
  if (res.status !== 200) {
    const refusal = await readRefusal(res);
    throw new TokenRefused(refusal.error || `the sign-in server answered ${res.status}`);
  }
  const body = await readJson(res);
  const expiresIn = Number(body?.expires_in);
  if (typeof body?.access_token !== "string" || typeof body.refresh_token !== "string" || !Number.isFinite(expiresIn)) {
    throw new CliError("bad_token_answer", "The sign-in server's answer had no tokens.");
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: startedAt + expiresIn * 1000 };
}

/** Exchanges an authorization code with this sign-in's verifier. A code works once. */
export function exchangeCode(
  fetch: Fetch,
  endpoint: TokenEndpoint & { redirectUri: string },
  o: { code: string; verifier: string },
  now: () => number,
): Promise<Tokens> {
  return tokenRequest(
    fetch,
    endpoint,
    { grant_type: "authorization_code", code: o.code, redirect_uri: endpoint.redirectUri, code_verifier: o.verifier },
    now,
  );
}

/**
 * Refreshes. Supabase Auth rotates the refresh token, and reusing an old one
 * outside the project's reuse window signs the person out, so callers hold
 * the token file's lock and have read it again first (session.ts).
 */
export function refreshTokens(fetch: Fetch, endpoint: TokenEndpoint, refreshToken: string, now: () => number): Promise<Tokens> {
  return tokenRequest(fetch, endpoint, { grant_type: "refresh_token", refresh_token: refreshToken }, now);
}

/**
 * The claims of an access token, decoded and not verified, or null. The CLI
 * reads them only to describe its own token (its kind and session); every
 * decision about the token is the server's.
 */
export function claimsOf(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
