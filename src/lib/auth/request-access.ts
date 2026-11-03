import "server-only";

/**
 * request-access.ts — the signed-in user and their role rows, read once per
 * Server Component render.
 *
 * React `cache()` scopes the memo to one render of one request: the dashboard
 * layout, SidebarNav and the page in the same render share a single
 * `auth.getUser()` + user_roles read, and the next request starts empty.
 * Outside a render (route handlers, tests) `cache()` memoizes nothing and
 * every call reads again, so route handlers use `@/lib/auth/access` and pass
 * on what they have already read.
 *
 * The read runs on a Supabase client of its own. supabase-js holds a
 * client's auth lock for the whole `getUser()` network call, and every query
 * on that client waits for the lock to fetch its token, so reading the user
 * on the page's client would hold the page's queries back by one round trip.
 * If supabase-js stops queueing queries behind `getUser()`, the separate
 * client buys nothing and can go.
 */
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  getCurrentUserAccess,
  readMicrogridOrgId,
  rolesCanAccessMicrogrid,
  rolesIncludeSuperAdmin,
  type CurrentUserAccess,
} from "./access";

/** `getCurrentUserAccess` for this request, read at most once per render. */
export const getRequestUserAccess = cache(
  async (): Promise<CurrentUserAccess> =>
    getCurrentUserAccess(await createClient())
);

/** `currentUserIsSuperAdmin`, from this render's role read. */
export async function requestUserIsSuperAdmin(): Promise<boolean> {
  return rolesIncludeSuperAdmin((await getRequestUserAccess()).roles);
}

/**
 * `currentUserCanAccessMicrogrid`, from this render's role read. The
 * microgrid's org is looked up on `supabase` alongside it.
 */
export async function requestUserCanAccessMicrogrid(
  supabase: SupabaseClient,
  microgridId: string
): Promise<boolean> {
  const [{ user, roles }, orgId] = await Promise.all([
    getRequestUserAccess(),
    readMicrogridOrgId(supabase, microgridId),
  ]);
  if (!user) return false;
  return rolesCanAccessMicrogrid(roles, orgId);
}
