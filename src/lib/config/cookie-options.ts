import type { PublicRuntimeConfig } from "./public-runtime-config";

/**
 * `@supabase/ssr` cookie options shared by the browser, server and
 * middleware clients, so all three use the same session cookie name.
 * Client-safe: imports only a type.
 */
export function cookieOptionsFor(
  config: PublicRuntimeConfig
): { cookieOptions?: { name: string } } {
  return config.cookieName ? { cookieOptions: { name: config.cookieName } } : {};
}

/**
 * The name of the session cookie the server and middleware clients read:
 * the configured name, else the one supabase-js derives from the URL the
 * client is given (`sb-<first host label>-auth-token`). Middleware uses it
 * to see whether a request carries a session cookie at all. If supabase-js
 * changes how it derives the default, revisit (getServerSupabaseSettings
 * relies on the same derivation).
 */
export function sessionCookieKey(settings: { url: string; publicConfig: PublicRuntimeConfig }): string {
  return settings.publicConfig.cookieName ?? `sb-${new URL(settings.url).hostname.split(".")[0]}-auth-token`;
}
