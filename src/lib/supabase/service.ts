import "server-only";

/**
 * service.ts — Supabase service-role client factory (canonical pattern).
 *
 * Introduced in UX5 (#79). Privileged routes that need to perform
 * `auth.admin.*` operations (invite, delete auth users, list users) use
 * this factory. Application code NEVER uses the service-role client for
 * tenant data reads/writes — that goes through the user-bound client
 * from `@/lib/supabase/server` so RLS evaluates against the caller.
 *
 * Guardrails:
 *   - `import "server-only"` (first line) causes Next.js to fail the
 *     build if any file with `"use client"` imports this module.
 *   - Uses `@supabase/supabase-js` `createClient()` — NOT `@supabase/ssr`.
 *     No cookies to propagate; this is a pure HTTP client with a
 *     static service-role JWT.
 *   - URL: `getServerSupabaseUrl()` — the server-only SUPABASE_INTERNAL_URL
 *     override when set, otherwise the validated public runtime URL
 *     (MGM_PUBLIC_SUPABASE_URL; see src/lib/config/public-runtime-config.ts).
 *   - Throws from `createServiceClient()` (not at module load) when
 *     SUPABASE_SERVICE_ROLE_KEY is unset. Module-load throws would fail
 *     `next build` page-data collection for every route that imports this
 *     module — including inherited surfaces a deployment may never call.
 *     Fail fast at first privileged use instead, with the same message.
 *
 * Two-client pattern — see ../../app/api/users/invite/route.ts for the
 * canonical caller shape. Reserved for: admin auth operations, future
 * tenant-API privileged writes.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getServerSupabaseUrl,
  RuntimeConfigError,
} from "@/lib/config/public-runtime-config";

export function createServiceClient(): SupabaseClient {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. This key is required for " +
        "privileged auth operations (invite, admin deletions). Set it in " +
        ".env.local for local dev and in the Vercel project env vars for " +
        "Production / Preview / Development."
    );
  }
  let supabaseUrl: string;
  try {
    supabaseUrl = getServerSupabaseUrl();
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      throw new Error(
        `Supabase URL is not configured: ${error.message} ` +
          "Set MGM_PUBLIC_SUPABASE_URL (or SUPABASE_INTERNAL_URL for container networking)."
      );
    }
    throw error;
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
