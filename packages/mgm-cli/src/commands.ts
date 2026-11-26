/**
 * `mgm login`, `mgm whoami` and `mgm logout` (RFC #259 § 1 and § 4; ADR-008
 * decisions 3, 4 and 5). Each takes its outside world as `deps`, so tests
 * run it against stand-ins or a real installation, and returns what it
 * found; cli.ts prints it.
 */
import { decodePastedCode } from "../../../src/lib/auth/pasted-code.ts";
import { canonicalOrigin, fetchDiscovery, installationOrigin, operatorClient } from "./discovery.ts";
import { CliError, Unreachable, messageOf } from "./errors.ts";
import { type Fetch, readRefusal, send } from "./http.ts";
import { CLI_CONTRACT, type Identity, authUser, contractNote, whoIs } from "./identity.ts";
import { TokenRefused, authorizeAddress, challengeFor, claimsOf, exchangeCode, newState, newVerifier, refreshTokens } from "./oauth.ts";
import { REFRESH_MARGIN_MS, type SessionDeps, SignedOut, freshTokenFile, refreshedUnderLock } from "./session.ts";
import { type Store, type TokenFile, assertSupportedPlatform, tokenFilePath } from "./store.ts";

export type Deps = SessionDeps & {
  fetch: Fetch;
  store: Store;
  platform: string;
  /** Asks the person for one line (written to stderr) and returns what they typed. */
  prompt: (question: string) => Promise<string>;
  /** Tries to open an address in the person's browser; true when it did. */
  openBrowser: (url: string) => Promise<boolean>;
  /** A progress line for the person, on stderr. */
  note: (line: string) => void;
};

/** Who a command is signed in as, which every command reports. */
export type SignedIn = {
  installation: string;
  email: string | null;
  user_id: string;
  client_id: string;
  client_kind: string;
  token_file: string;
  contract: { cli: string; installation: string | null };
  /** Set when the two contracts differ. */
  contract_note: string | null;
};

/** The address a command was given: `--url`, else the installation `mgm login` last signed in to. */
async function typedInstallation(deps: Deps, url: string | undefined): Promise<string> {
  if (url !== undefined) return installationOrigin(url);
  const current = await deps.store.currentInstallation();
  if (current) return current;
  throw new CliError("no_installation", "No installation given. Run: mgm login --url <the address you open MGM at>", 2);
}

/**
 * The installation whose token file `whoami` and `logout` use, and that
 * file's path. Token files are named after an installation's own origin
 * (`mgm login` saves under the origin of its code page), so `--url` given an
 * address that redirects there is resolved the way `mgm login` resolved it:
 * from the aliases login remembered, else, when there is no file for the
 * address as typed, by asking its discovery answer. When that cannot be
 * asked, the address is used as typed.
 */
async function installationFor(deps: Deps, url: string | undefined): Promise<{ installation: string; path: string }> {
  const typed = await typedInstallation(deps, url);
  const at = (installation: string) => ({ installation, path: tokenFilePath(deps.store.base, installation, "operator") });
  if (url === undefined) return at(typed);
  const alias = await deps.store.aliasOf(typed);
  if (alias) return at(alias);
  const asTyped = at(typed);
  if (await deps.store.readToken(asTyped.path)) return asTyped;
  let own: string;
  try {
    own = canonicalOrigin(await fetchDiscovery(deps.fetch, typed));
  } catch {
    return asTyped;
  }
  return own === typed ? asTyped : at(own);
}

function signedIn(file: TokenFile, path: string, identity: Identity): SignedIn {
  return {
    installation: file.installation,
    email: identity.email,
    user_id: identity.userId,
    client_id: file.client_id,
    client_kind: identity.kind,
    token_file: path,
    contract: { cli: CLI_CONTRACT, installation: identity.contract },
    contract_note: contractNote(identity.contract),
  };
}

/**
 * `mgm login --url <installation>`: reads the discovery answer, opens the
 * authorize address with PKCE (S256) and a fresh state, takes the pasted
 * `<state>.<code>`, refuses a state that is not its own, exchanges the code,
 * and saves the operator client's token file. Nothing is written before the
 * exchange succeeds.
 */
export async function login(deps: Deps, o: { url?: string }): Promise<SignedIn> {
  assertSupportedPlatform(deps.platform);
  const typed = await typedInstallation(deps, o.url);
  const discovery = await fetchDiscovery(deps.fetch, typed);
  const installation = canonicalOrigin(discovery);
  const clientId = operatorClient(discovery, installation);
  if (installation !== typed) deps.note(`${typed} leads to ${installation}; signing in there.`);

  const verifier = newVerifier();
  const state = newState();
  const address = authorizeAddress(discovery.authorize_url, {
    clientId,
    redirectUri: discovery.redirect_uri,
    state,
    challenge: challengeFor(verifier),
  });
  deps.note(`To sign in to ${installation}, open this address in a browser:`);
  deps.note("");
  deps.note(`  ${address}`);
  deps.note("");
  deps.note((await deps.openBrowser(address)) ? "Your browser should be showing it now." : "Open it on any device where you can sign in to MGM.");
  deps.note("Approve the sign-in only if you ran mgm login yourself just now. The page then shows a sign-in code.");

  const pasted = decodePastedCode(await deps.prompt("Paste the sign-in code: "));
  if (!pasted) {
    throw new CliError("bad_code", "That is not a sign-in code. Nothing was saved. Run mgm login again and paste the whole code the page shows.");
  }
  if (pasted.state !== state) {
    throw new CliError(
      "wrong_state",
      "That code belongs to another sign-in, not the one this command started. Nothing was saved. Run mgm login again and paste the code from the page it opens.",
    );
  }

  let tokens;
  try {
    tokens = await exchangeCode(
      deps.fetch,
      { tokenUrl: discovery.token_url, anonKey: discovery.supabase_anon_key, clientId, redirectUri: discovery.redirect_uri },
      { code: pasted.code, verifier },
      deps.now,
    );
  } catch (error) {
    if (error instanceof TokenRefused) {
      throw new CliError(
        "code_refused",
        `The sign-in server refused the code (${error.message}). A code works once, for 10 minutes. Run mgm login again.`,
      );
    }
    throw error;
  }

  const claims = claimsOf(tokens.accessToken) ?? {};
  const file: TokenFile = {
    v: 1,
    installation,
    supabase_url: discovery.supabase_url,
    anon_key: discovery.supabase_anon_key,
    token_url: discovery.token_url,
    client_id: clientId,
    kind: "operator",
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.expiresAt,
    user: { id: String(claims.sub ?? ""), email: typeof claims.email === "string" ? claims.email : null },
    saved_at: new Date(deps.now()).toISOString(),
  };

  // Who the new token is signed in as, to say so; the token's own claims
  // stand in when neither MGM nor Supabase Auth answers just now.
  let identity: Identity | null;
  try {
    identity = await whoIs(deps.fetch, file);
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error;
    identity = { userId: file.user.id, email: file.user.email, kind: String(claims.mgm_client_kind ?? "operator"), contract: null, source: "auth" };
  }
  if (!identity) throw new CliError("code_refused", "The new sign-in was refused at once. Run mgm login again.");
  file.user = { id: identity.userId, email: identity.email };

  const path = tokenFilePath(deps.store.base, installation, "operator");
  // The file this replaces, read and replaced under its lock, so no other
  // command refreshes with its refresh token from here on.
  const previous = await deps.store.withLock(
    path,
    async () => {
      const old = await deps.store.readToken(path).catch(() => null);
      await deps.store.writeToken(path, file);
      return old;
    },
    deps.lock,
  );
  await deps.store.setCurrentInstallation(installation, typed);
  if (previous) await endReplaced(deps, previous, installation);
  return signedIn(file, path, identity);
}

/**
 * Ends the session a new `mgm login` replaced, best effort, and says what
 * happened to it: its tokens are no longer in any file, so nothing else will.
 */
async function endReplaced(deps: Deps, old: TokenFile, installation: string): Promise<void> {
  const kept = `This terminal's earlier sign-in to ${installation} was replaced and may still be live until it expires. Revoking the MGM command line from Connected apps in MGM ends it, and this new sign-in too.`;
  if (old.installation !== installation) {
    deps.note(kept);
    return;
  }
  let current = old;
  try {
    if (old.expires_at - deps.now() <= REFRESH_MARGIN_MS) {
      const tokens = await refreshTokens(
        deps.fetch,
        { tokenUrl: old.token_url, anonKey: old.anon_key, clientId: old.client_id },
        old.refresh_token,
        deps.now,
      );
      current = { ...old, access_token: tokens.accessToken, refresh_token: tokens.refreshToken, expires_at: tokens.expiresAt };
    }
  } catch (error) {
    if (error instanceof TokenRefused) return; // It had ended already.
    deps.note(kept);
    return;
  }
  const outcome = await endSession(deps, current).catch((error: unknown) => ({ session: "not_confirmed" as const, why: messageOf(error) }));
  if (outcome.session === "ended") deps.note(`This terminal's earlier sign-in to ${installation} is ended.`);
  else if (outcome.session === "not_confirmed") deps.note(kept);
}

/** `mgm whoami`: the installation, the signed-in person, the client kind and the token file. */
export async function whoami(deps: Deps, o: { url?: string }): Promise<SignedIn> {
  assertSupportedPlatform(deps.platform);
  const { installation, path } = await installationFor(deps, o.url);
  const file = await freshTokenFile(deps, path, installation);
  const identity = await whoIs(deps.fetch, file);
  if (!identity) throw new SignedOut(installation, "the installation no longer accepts its token");
  return signedIn(file, path, identity);
}

export type LoggedOut = {
  installation: string;
  token_file: string;
  /**
   * `ended`: MGM ended the session. `already_ended`: it had ended before
   * (the refresh was refused, or MGM and Supabase Auth both refused the
   * token). `not_confirmed`: the session may still be live until it is
   * revoked or expires. `not_signed_in`: there was no file.
   */
  session: "ended" | "already_ended" | "not_confirmed" | "not_signed_in";
  /** What to do next, when the session may still be live. */
  advice: string | null;
};

const REVOKE_ADVICE =
  "To end that session now, open MGM in a browser and revoke the MGM command line from Connected apps.";

type Ending = { session: "ended" | "already_ended" } | { session: "not_confirmed"; why: string };

/**
 * Asks MGM to end the session of `file`'s token (POST /api/auth/logout),
 * sending the token only to the installation the file belongs to. A 401
 * from MGM is not taken as the session having ended until Supabase Auth
 * refuses the same token too (authUser): MGM also answers 401 while it
 * cannot reach Auth.
 */
async function endSession(deps: Deps, file: TokenFile): Promise<Ending> {
  let res: Response;
  try {
    res = await send(deps.fetch, `${file.installation}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${file.access_token}`, accept: "application/json" },
    });
  } catch (error) {
    if (error instanceof Unreachable) return { session: "not_confirmed", why: `MGM could not end the session (${error.message}).` };
    throw error;
  }
  if (res.status === 204) return { session: "ended" };
  const refusal = await readRefusal(res);
  if (res.status === 401) {
    try {
      if ((await authUser(deps.fetch, file)) === null) return { session: "already_ended" };
      return { session: "not_confirmed", why: "MGM did not accept the token, but Supabase Auth still does, so the session was not ended." };
    } catch (error) {
      if (error instanceof Unreachable) {
        return { session: "not_confirmed", why: `MGM did not accept the token, and Supabase Auth could not be asked whether the session had ended (${error.message}).` };
      }
      throw error;
    }
  }
  return { session: "not_confirmed", why: `MGM did not end the session (${res.status}${refusal.error ? `: ${refusal.error}` : ""}).` };
}

/**
 * `mgm logout`: under the token file's lock, refreshes the token if it is
 * about to expire, asks MGM to end this session (endSession), and deletes
 * the file. The file is deleted whatever MGM answers; unless the session is
 * known to have ended, it says to revoke the app from Connected apps.
 */
export async function logout(deps: Deps, o: { url?: string }): Promise<LoggedOut> {
  assertSupportedPlatform(deps.platform);
  const { installation, path } = await installationFor(deps, o.url);
  const answer = (session: LoggedOut["session"], advice: string | null = null): LoggedOut => ({
    installation,
    token_file: path,
    session,
    advice,
  });

  if (!(await deps.store.readToken(path))) return answer("not_signed_in");
  return deps.store.withLock(
    path,
    async () => {
      const stored = await deps.store.readToken(path);
      if (!stored) return answer("not_signed_in");
      if (stored.installation !== installation) {
        throw new CliError(
          "bad_token_file",
          `${path} holds a sign-in to ${stored.installation}, not ${installation}, so mgm will not send its token. Delete the file and run mgm login again.`,
        );
      }
      try {
        let file: TokenFile;
        try {
          file = await refreshedUnderLock(deps, path, stored);
        } catch (error) {
          if (error instanceof SignedOut) return answer("already_ended");
          if (error instanceof Unreachable) return answer("not_confirmed", `mgm could not reach the sign-in server (${error.message}). ${REVOKE_ADVICE}`);
          throw error;
        }
        const ending = await endSession(deps, file);
        return ending.session === "not_confirmed" ? answer("not_confirmed", `${ending.why} ${REVOKE_ADVICE}`) : answer(ending.session);
      } catch (error) {
        throw new CliError("logout_failed", `${messageOf(error)} The token file was deleted. ${REVOKE_ADVICE}`);
      } finally {
        await deps.store.remove(path);
      }
    },
    deps.lock,
  );
}
