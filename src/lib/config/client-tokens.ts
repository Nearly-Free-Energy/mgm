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
 * It is logged at server start (validateClientTokensAtStartup).
 *
 * Read per request, like the other settings (ADR-003), so a change takes
 * effect without a rebuild. Tokens already issued keep working at the
 * database API until they expire; docs/setup.md says what else to do.
 */
export const CLIENT_TOKENS_VARIABLE = "MGM_CLIENT_TOKENS";

const ON = new Set(["", "1", "true", "on"]);
const OFF = new Set(["0", "false", "off"]);

/** "on" for unset, blank, 1, true, on; "off" for 0, false, off (any case); "invalid" otherwise, which refuses as off does. */
export function readClientTokens(env: RuntimeEnv = process.env): "on" | "off" | "invalid" {
  const value = (env[CLIENT_TOKENS_VARIABLE] ?? "").trim().toLowerCase();
  if (ON.has(value)) return "on";
  if (OFF.has(value)) return "off";
  return "invalid";
}

/** True only when client tokens are on; an unknown value is off. */
export function clientTokensAccepted(env: RuntimeEnv = process.env): boolean {
  return readClientTokens(env) === "on";
}

/**
 * The start-up check (src/instrumentation.ts): logs a value that is neither
 * on nor off as an error, naming the variable and never the value, so an
 * operator learns at start why every client is refused. Never throws.
 */
export function validateClientTokensAtStartup(env: RuntimeEnv = process.env): void {
  if (readClientTokens(env) === "invalid") {
    console.error(`[mgm] ${CLIENT_TOKENS_VARIABLE} must be on or off; client tokens are refused until it is.`);
  }
}
