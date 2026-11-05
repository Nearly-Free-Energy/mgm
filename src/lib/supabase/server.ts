import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getServerSupabaseSettings } from "@/lib/config/public-runtime-config";
import { cookieOptionsFor } from "@/lib/config/cookie-options";

export async function createClient() {
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
