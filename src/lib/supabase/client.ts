import { createBrowserClient } from "@supabase/ssr";
import { getBrowserPublicRuntimeConfig } from "@/lib/config/browser-config-store";
import { cookieOptionsFor } from "@/lib/config/cookie-options";

/**
 * Browser Supabase client. URL, anon key and cookie name come from the
 * request-time configuration the root layout passed to
 * `PublicRuntimeConfigProvider` (#46), never from `process.env` in the
 * bundle. The cookie name matches the server and middleware clients so both
 * sides find the session even when the server uses SUPABASE_INTERNAL_URL.
 */
export function createClient() {
  const config = getBrowserPublicRuntimeConfig();
  return createBrowserClient(config.supabaseUrl, config.supabaseAnonKey, {
    ...cookieOptionsFor(config),
  });
}
