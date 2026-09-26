import "server-only";

import { OpenEmsError } from "./errors";
import { validateBackendUrl } from "./backend-url";

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
 * transport failure, HTTP_ERROR/RPC_ERROR on malformed IdP behavior,
 * INVALID_BACKEND_URL when the token endpoint fails sink-side validation
 * (thrown before fetch is reachable — the secret never leaves), REDIRECT
 * when the endpoint answers with a 3xx (never followed).
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

  // Sink-side endpoint validation (P1, PR #8 re-review): the token URL is
  // operator-supplied and the request body carries the client secret, so
  // the exact string handed to fetch must pass the same checks as a
  // backend URL — https (http only for localhost), no embedded
  // credentials, no literal private/loopback/link-local hosts. Validating
  // here rather than only at save time also covers rows stored before any
  // write-time check existed. A rejected endpoint throws before fetch is
  // reachable, so the secret cannot leave the process.
  const checked = validateBackendUrl(creds.tokenUrl);
  if (!checked.ok) {
    throw new OpenEmsError(
      `The Keycloak token endpoint was not contacted because it is not valid: ${checked.error} ` +
        `Open the microgrid's OpenEMS Backend setup and save a valid token endpoint URL.`,
      "OPENEMS_INVALID_BACKEND_URL",
      503,
      { tokenUrl: creds.tokenUrl }
    );
  }

  let response: Response;
  try {
    // `redirect: "manual"` — redirects are NOT followed. fetch defaults to
    // `follow`, which would re-send the POST — body included, i.e. the
    // client secret — to a host that never passed the checks above (a
    // 307/308 at request time preserves method and body). Same rule as
    // `client.ts`: a control a redirect can sidestep is not a control.
    response = await fetch(checked.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
      redirect: "manual",
    });
  } catch (err) {
    throw new OpenEmsError(
      `Could not reach the Keycloak token endpoint: ${err instanceof Error ? err.message : String(err)}`,
      "OPENEMS_UNREACHABLE",
      503,
      err
    );
  }

  // A redirect is a configuration problem, not a rejection. Checked before
  // the auth branch — a 3xx has no token body to parse, and parsing it as
  // one would be the wrong error at best. With `redirect: "manual"` the
  // runtime surfaces either the raw 3xx or an opaque redirect (type
  // "opaqueredirect", status 0); handle both, and never follow.
  if (
    (response.status >= 300 && response.status < 400) ||
    response.type === "opaqueredirect"
  ) {
    const location =
      typeof response.headers?.get === "function"
        ? response.headers.get("location")
        : null;
    throw new OpenEmsError(
      `Keycloak token endpoint responded with a redirect` +
        (location ? ` to ${location}` : "") +
        `. Redirects are not followed — update the saved token endpoint URL to the final address.`,
      "OPENEMS_REDIRECT",
      502,
      { status: response.status, location }
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
