/**
 * The sign-in code a person pastes into the terminal (RFC #259 § 1,
 * ADR-008 decision 3).
 *
 * `mgm login` opens the browser at Supabase Auth's authorize endpoint with a
 * `state` of its own. After the person approves on MGM's consent page,
 * Supabase Auth sends the browser to MGM's code page (/oauth/code) with the
 * authorization code and that state in the query. The page shows both as one
 * string, which the person pastes into the terminal; the CLI decodes it,
 * refuses a state that is not its own, and exchanges the code with its PKCE
 * verifier.
 *
 * The string is `<state>.<code>`:
 *   - state: base64url, 16 to 512 characters. The CLI makes it (C1, which
 *     reuses this module), so a state of any other shape did not come from
 *     MGM's CLI and is refused.
 *   - code: the authorization code, a UUID in Supabase Auth v2.198.0
 *     (models.OAuthServerAuthorization.GenerateAuthorizationCode). If a later
 *     version issues codes of another shape, every code is refused here and
 *     the code page says the link is incomplete: revisit CODE_PATTERN.
 *
 * Neither part contains a dot, so the string splits at its one dot.
 *
 * Dependency-free, so the CLI can import it without the app.
 */

const STATE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const CODE_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type PastedCode = { state: string; code: string };

/** True when `state` has the shape MGM's CLI gives it. */
export function isPastedState(state: string): boolean {
  return STATE_PATTERN.test(state);
}

/** True when `code` has the shape of a Supabase Auth authorization code. */
export function isAuthorizationCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/** The string to paste, or null when either part has the wrong shape. */
export function encodePastedCode({ state, code }: PastedCode): string | null {
  if (!isPastedState(state) || !isAuthorizationCode(code)) return null;
  return `${state}.${code}`;
}

/**
 * The state and code in a pasted string, or null when it is not one. Spaces
 * and line breaks around it, which a terminal paste can add, are ignored.
 */
export function decodePastedCode(text: string): PastedCode | null {
  const parts = text.trim().split(".");
  if (parts.length !== 2) return null;
  const [state, code] = parts;
  if (!isPastedState(state) || !isAuthorizationCode(code)) return null;
  return { state, code };
}
