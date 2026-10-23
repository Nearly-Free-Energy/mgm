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
