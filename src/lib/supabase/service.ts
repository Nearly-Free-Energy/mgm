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
 *   - URL: prefers SUPABASE_INTERNAL_URL (Docker mode) over
 *     NEXT_PUBLIC_SUPABASE_URL — mirrors `server.ts:10`.
 *   - Throws when a privileged operation requests a client if the service
 *     key is unset. MGM's pilot build has no service-role key because its
 *     deployed route surface contains no privileged auth operations.
 *
 * Two-client pattern — see ../../app/api/users/invite/route.ts for the
 * canonical caller shape. Reserved for: admin auth operations, future
 * tenant-API privileged writes.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createServiceClient(): SupabaseClient {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set for privileged auth operations.");
  }
  const supabaseUrl = process.env.SUPABASE_INTERNAL_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("Supabase URL is not set for privileged auth operations.");
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
