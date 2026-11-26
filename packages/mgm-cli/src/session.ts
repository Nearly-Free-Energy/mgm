/**
 * A usable access token from a token file, refreshed when it is about to
 * expire, without ever refreshing twice with one refresh token.
 */
import { CliError, messageOf } from "./errors.ts";
import type { Fetch } from "./http.ts";
import type { LockOptions } from "./lock.ts";
import { TokenRefused, refreshTokens } from "./oauth.ts";
import type { Store, TokenFile } from "./store.ts";

/** A token with less than this left is refreshed first. */
export const REFRESH_MARGIN_MS = 60_000;

export type SessionDeps = { fetch: Fetch; store: Store; now: () => number; lock?: LockOptions };

/** The sign-in has ended (refused on refresh, or the token refused): the person runs `mgm login` again. */
export class SignedOut extends CliError {
  constructor(installation: string, why: string) {
    super("signed_out", `Your sign-in to ${installation} has ended (${why}). Run: mgm login --url ${installation}`);
  }
}

export function notSignedIn(installation: string): CliError {
  return new CliError("not_signed_in", `You are not signed in to ${installation}. Run: mgm login --url ${installation}`);
}

function fresh(file: TokenFile, now: number): boolean {
  return file.expires_at - now > REFRESH_MARGIN_MS;
}

/**
 * `current` with an access token good for at least a minute, refreshing and
 * saving it at `path` when it is not. The caller holds the file's lock and
 * read `current` under it.
 *
 * A refusal from the token endpoint (the app was revoked or the session
 * ended) throws SignedOut; no answer throws Unreachable. If the refresh
 * worked but the file could not be written, the old refresh token is spent
 * and the new one lost, so the error says to sign in again.
 */
export async function refreshedUnderLock(deps: SessionDeps, path: string, current: TokenFile): Promise<TokenFile> {
  if (fresh(current, deps.now())) return current;
  let tokens;
  try {
    tokens = await refreshTokens(
      deps.fetch,
      { tokenUrl: current.token_url, anonKey: current.anon_key, clientId: current.client_id },
      current.refresh_token,
      deps.now,
    );
  } catch (error) {
    if (error instanceof TokenRefused) throw new SignedOut(current.installation, error.message);
    throw error;
  }
  const next: TokenFile = {
    ...current,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.expiresAt,
    saved_at: new Date(deps.now()).toISOString(),
  };
  try {
    await deps.store.writeToken(path, next);
  } catch (error) {
    throw new CliError(
      "refresh_not_saved",
      `mgm refreshed your sign-in but could not save it (${messageOf(error)}), so the sign-in is lost. Run: mgm login --url ${current.installation}`,
    );
  }
  return next;
}

/**
 * The token file at `path`, for `installation`, with an access token good
 * for at least a minute.
 *
 * 1. A token with time left is used as it is, with no lock.
 * 2. Otherwise the command takes the file's lock and reads the file again.
 *    If another command refreshed meanwhile (the refresh token changed, or
 *    the token now has time left), that one is used.
 * 3. Otherwise it refreshes, writes the new tokens, and releases the lock.
 */
export async function freshTokenFile(deps: SessionDeps, path: string, installation: string): Promise<TokenFile> {
  const first = await deps.store.readToken(path);
  if (!first) throw notSignedIn(installation);
  if (fresh(first, deps.now())) return first;

  return deps.store.withLock(
    path,
    async () => {
      const current = await deps.store.readToken(path);
      if (!current) throw notSignedIn(installation);
      if (current.refresh_token !== first.refresh_token) return current;
      return refreshedUnderLock(deps, path, current);
    },
    deps.lock,
  );
}
