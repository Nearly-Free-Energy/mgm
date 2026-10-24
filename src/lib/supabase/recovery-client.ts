import { createClient } from "@supabase/supabase-js";
import { getBrowserPublicRuntimeConfig } from "@/lib/config/browser-config-store";

/**
 * Recovery emails may be opened in a different browser (e.g. Gmail on a phone).
 * Request an implicit recovery link rather than a PKCE code bound to a cookie
 * in the requesting browser. The reset page validates the returned tokens and
 * installs the session with the ordinary SSR client. This request-only client
 * must neither read nor persist a session.
 *
 * URL and anon key come from the request-time public configuration (#46).
 */
export function createRecoveryRequestClient() {
  const config = getBrowserPublicRuntimeConfig();
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      flowType: "implicit",
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
