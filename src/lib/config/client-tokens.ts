import type { RuntimeEnv } from "./public-runtime-config";

/**
 * `MGM_CLIENT_TOKENS`: whether MGM's routes accept a client's bearer token
 * (RFC #259 § 2, ADR-008 decision 9's way out of the OAuth server's beta).
 * On when unset or blank, or set to on, 1 or true; `off`, 0 or false makes
 * middleware refuse every bearer token with 403 `client_tokens_off`, before
 * any route runs. Browser sessions are unaffected.
 *
 * Any other value also refuses: this is the switch an operator reaches for
 * when client tokens must stop, so a mistyped value must not leave them on.
 *
 * Read per request, like the other settings (ADR-003), so a change takes
 * effect without a rebuild. Tokens already issued keep working at the
 * database API until they expire; docs/setup.md says what else to do.
 */
export const CLIENT_TOKENS_VARIABLE = "MGM_CLIENT_TOKENS";

const ON = new Set(["", "1", "true", "on"]);

/** True only when client tokens are on; an unknown value is off. */
export function clientTokensAccepted(env: RuntimeEnv = process.env): boolean {
  return ON.has((env[CLIENT_TOKENS_VARIABLE] ?? "").trim().toLowerCase());
}
