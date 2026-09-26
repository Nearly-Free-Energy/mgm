import "server-only";

import { OpenEmsError } from "./errors";

/**
 * Keycloak token acquisition for `direct_url` backends (issue #4).
 *
 * A manually stored bearer token (00061) unblocks the initial test, but it
 * stops working when it expires. A Keycloak confidential client lets the
 * server obtain access tokens itself via the OAuth2 client-credentials
 * grant and refresh them ahead of expiry, so the dedicated account keeps
 * working without operator intervention.
 *
 * Caching: per-process Map keyed by endpoint + client id, holding the token
 * until 60s before expiry. Serverless instances refetch on cold start —
 * client-credentials is cheap and idempotent, so no cross-instance store.
 *
 * The token travels in memory only: request body (x-www-form-urlencoded),
 * response parse, cache. It is never logged — structured logs here carry
 * the token endpoint host at most, never the token or secret.
 */
export type KeycloakCredentials = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

const EXPIRY_SKEW_MS = 60_000;

const cache = new Map<string, CachedToken>();

function cacheKey(creds: KeycloakCredentials): string {
  return `${creds.tokenUrl}|${creds.clientId}|${creds.clientSecret}`;
}

/**
 * Return a valid access token, fetching (and caching) one if needed.
 * Throws OpenEmsError: AUTH_FAILED on IdP rejection, UNREACHABLE on
 * transport failure, HTTP_ERROR/RPC_ERROR on malformed IdP behavior.
 */
export async function obtainKeycloakToken(
  creds: KeycloakCredentials,
  now: number = Date.now()
): Promise<string> {
  const key = cacheKey(creds);
  const cached = cache.get(key);
  if (cached && cached.expiresAt - now > EXPIRY_SKEW_MS) {
    return cached.accessToken;
  }

  let response: Response;
  try {
    response = await fetch(creds.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    });
  } catch (err) {
    throw new OpenEmsError(
      `Could not reach the Keycloak token endpoint: ${err instanceof Error ? err.message : String(err)}`,
      "OPENEMS_UNREACHABLE",
      503,
      err
    );
  }

  if (response.status === 401 || response.status === 400) {
    throw new OpenEmsError(
      "Keycloak rejected the client credentials. Verify the client id and secret.",
      "OPENEMS_AUTH_FAILED",
      401
    );
  }
  if (!response.ok) {
    throw new OpenEmsError(
      `Keycloak token endpoint returned HTTP ${response.status}.`,
      "OPENEMS_HTTP_ERROR",
      502,
      { status: response.status }
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenEmsError(
      "Keycloak token endpoint did not return JSON.",
      "OPENEMS_RPC_ERROR",
      502
    );
  }
  const accessToken =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).access_token
      : undefined;
  const expiresIn =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).expires_in
      : undefined;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OpenEmsError(
      "Keycloak token endpoint returned no access token.",
      "OPENEMS_RPC_ERROR",
      502
    );
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OpenEmsError(
      "Keycloak token endpoint returned no usable expiry.",
      "OPENEMS_RPC_ERROR",
      502
    );
  }

  cache.set(key, { accessToken, expiresAt: now + expiresIn * 1000 });
  return accessToken;
}

/** Reset the token cache — for tests only. */
export function _resetKeycloakTokenCacheForTests(): void {
  cache.clear();
}
