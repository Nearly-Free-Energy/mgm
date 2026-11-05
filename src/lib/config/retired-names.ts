import "server-only";

/**
 * Configuration names that MGM v0.0.1 and v0.0.2 still accepted in place of
 * their MGM_ replacements, and that later releases no longer read (#79;
 * ADR-003, amendment of 2026-10-24). Nothing uses their values.
 *
 * An installation upgraded without renaming one would otherwise see only
 * "Missing required runtime configuration: MGM_…". At server start
 * (src/instrumentation.ts) each retired name that is set while its
 * replacement is not gets one warning naming both variables, never the
 * value. A retired name set next to its replacement is ignored silently.
 */
import type { RuntimeEnv } from "./public-runtime-config";

type RetiredName = {
  name: string;
  replacement: string;
  /** What to set, when the replacement is not a plain rename. */
  hint?: string;
};

export const RETIRED_NAMES: readonly RetiredName[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", replacement: "MGM_PUBLIC_SUPABASE_URL" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", replacement: "MGM_PUBLIC_SUPABASE_ANON_KEY" },
  { name: "NEXT_PUBLIC_SUPABASE_COOKIE_NAME", replacement: "MGM_PUBLIC_SUPABASE_COOKIE_NAME" },
  { name: "NEXT_PUBLIC_APP_URL", replacement: "MGM_APP_URL", hint: "the application origin only" },
  {
    name: "NEXT_PUBLIC_PAYMENT_CALLBACK_URL",
    replacement: "MGM_APP_URL",
    hint: "the application origin only; the payment return URL is that origin plus /payment/callback",
  },
];

function isSet(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * One line per retired name that is set while its replacement is not.
 *
 * The default reads `process.env` with a non-literal key (`env[name]`, the
 * name taken from the list above), never `process.env.NEXT_PUBLIC_…`:
 * Next.js replaces literal `process.env.NEXT_PUBLIC_*` reads with their
 * build-time values in server bundles as well as browser ones, so a literal
 * read would report the build machine's variables in every installation
 * running that build. What keeps the build's values out is the non-literal
 * key, not the `env` alias. If Next.js starts inlining computed
 * `process.env` reads, revisit.
 */
export function retiredNameWarnings(env: RuntimeEnv = process.env): string[] {
  return RETIRED_NAMES.filter(
    ({ name, replacement }) => isSet(env[name]) && !isSet(env[replacement])
  ).map(
    ({ name, replacement, hint }) =>
      `[mgm] ${name} is set but no longer read; set ${replacement}` +
      `${hint ? ` (${hint})` : ""} instead. ` +
      'See docs/setup.md, "Upgrading from v0.0.1 or v0.0.2".'
  );
}

/** Server-start hint for retired names (src/instrumentation.ts). Never throws. */
export function warnAboutRetiredNames(env: RuntimeEnv = process.env): void {
  for (const line of retiredNameWarnings(env)) console.warn(line);
}
