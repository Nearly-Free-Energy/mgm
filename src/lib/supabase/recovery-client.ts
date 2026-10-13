import { createClient } from "@supabase/supabase-js";

/**
 * Recovery emails may be opened in a different browser (e.g. Gmail on a phone).
 * Request an implicit recovery link rather than a PKCE code bound to a cookie
 * in the requesting browser. The reset page validates the returned tokens and
 * installs the session with the ordinary SSR client. This request-only client
 * must neither read nor persist a session.
 */
export function createRecoveryRequestClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        flowType: "implicit",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  );
}
