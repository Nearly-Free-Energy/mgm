import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { getServerSupabaseSettings } from "@/lib/config/public-runtime-config";
import { cookieOptionsFor } from "@/lib/config/cookie-options";
import { bearerClientFor } from "@/lib/runtime/request-session";

/**
 * The caller's own client for this request, under row-level security: a
 * client on the request's bearer token when middleware accepted one (an
 * `/api` request from the CLI, RFC #259 § 2), else the cookie session's.
 * See bearerClientFor (@/lib/runtime/request-session) for the bearer side.
 */
export async function createClient() {
  const bearer = bearerClientFor(await headers());
  if (bearer) return bearer;

  const cookieStore = await cookies();

  // Request-time, validated (#46): server-only SUPABASE_INTERNAL_URL
  // override, public anon key, and the same cookie name as the browser.
  const settings = getServerSupabaseSettings();

  return createServerClient(
    settings.url,
    settings.anonKey,
    {
      ...cookieOptionsFor(settings.publicConfig),
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );
}
