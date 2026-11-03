import "server-only";

/**
 * access.ts — server-only access helpers.
 *
 * Created in #76 (UX4a entity CRUD). Separate from `src/lib/roles.ts` — that
 * file is client-safe role CONSTANTS; this file is SERVER-ONLY role CHECKS that
 * hit Supabase. The `import 'server-only'` directive at the top causes any
 * accidental import from a client bundle to fail at build time.
 *
 * All helpers accept a Supabase server client (created by
 * `@/lib/supabase/server`) so the caller's session (cookies) is honored. RLS
 * remains the authoritative gate — these helpers are defense-in-depth for
 * producing actionable 403s before a Postgres 42501 surfaces from the DB.
 *
 * Round trips:
 *   - Each check reads the user (`auth.getUser()`) and their user_roles rows
 *     once. A caller that has already read them passes them on instead
 *     (`getCurrentUserRoles(supabase, user)`, `rolesCanAccessOrg`,
 *     `rolesCanAccessMicrogrid`), and
 *     Server Components share one read per render through
 *     `@/lib/auth/request-access`.
 *   - Parent IDs (community → org, microgrid → community → org) resolve in
 *     one RLS-scoped select, read alongside the role rows.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { UserRoleRecord } from "@/lib/types/domain";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";

/** The signed-in user (null when there is none) and their user_roles rows. */
export type CurrentUserAccess = {
  user: User | null;
  roles: UserRoleRecord[];
};

async function readUserRoles(
  supabase: SupabaseClient,
  userId: string
): Promise<UserRoleRecord[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("*")
    .eq("user_id", userId)
    .returns<UserRoleRecord[]>();

  if (error) return [];
  return data ?? [];
}

/**
 * The current user, verified by `auth.getUser()`, and all their user_roles
 * rows. `{ user: null, roles: [] }` if unauthenticated.
 */
export async function getCurrentUserAccess(
  supabase: SupabaseClient
): Promise<CurrentUserAccess> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, roles: [] };
  return { user, roles: await readUserRoles(supabase, user.id) };
}

/**
 * Returns all user_roles rows for the currently authenticated user.
 * Empty array if unauthenticated or the user has no role rows yet.
 *
 * Pass `user` when this request has already called `auth.getUser()` on the
 * same client, to skip a second call; omit it to have this helper call it.
 * Pass only the object `auth.getUser()` returned: its rows are read as the
 * caller's own, so an id from anywhere else would mislabel whose roles these
 * are.
 */
export async function getCurrentUserRoles(
  supabase: SupabaseClient,
  user?: User | null
): Promise<UserRoleRecord[]> {
  if (user === undefined) return (await getCurrentUserAccess(supabase)).roles;
  if (!user) return [];
  return readUserRoles(supabase, user.id);
}

/** True iff the rows include a role = 'super_admin' row. */
export function rolesIncludeSuperAdmin(roles: UserRoleRecord[]): boolean {
  return roles.some((r) => r.role === SUPER_ADMIN);
}

/**
 * True iff the rows include a super_admin row OR an org_manager row scoped
 * to the given org.
 */
export function rolesCanAccessOrg(
  roles: UserRoleRecord[],
  orgId: string
): boolean {
  if (rolesIncludeSuperAdmin(roles)) return true;
  return roles.some(
    (r) =>
      r.role === ORG_MANAGER &&
      r.scope_type === SCOPE_ORG &&
      r.scope_id === orgId
  );
}

/**
 * True iff the rows give access to a microgrid whose org is `orgId` (null
 * when the microgrid → community → org lookup found nothing): any
 * super_admin row, or an org_manager row scoped to that org.
 *
 * The one definition of microgrid access in this file:
 * `currentUserCanAccessMicrogrid`, `requestUserCanAccessMicrogrid` and
 * callers that already hold the org and the role rows all decide through it.
 * A role scoped to the microgrid itself would need the microgrid's ID here;
 * adding that parameter makes the compiler ask every caller for it.
 */
export function rolesCanAccessMicrogrid(
  roles: UserRoleRecord[],
  orgId: string | null
): boolean {
  if (rolesIncludeSuperAdmin(roles)) return true;
  return orgId !== null && rolesCanAccessOrg(roles, orgId);
}

/**
 * The org a community belongs to, or null if the community is not found (or
 * RLS hides it).
 */
async function readCommunityOrgId(
  supabase: SupabaseClient,
  communityId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("communities")
    .select("org_id")
    .eq("id", communityId)
    .maybeSingle<{ org_id: string }>();

  if (error || !data) return null;
  return data.org_id;
}

/**
 * The org a microgrid belongs to (microgrid → community → org, one embedded
 * select), or null if the microgrid or its community is not found (or RLS
 * hides it).
 */
export async function readMicrogridOrgId(
  supabase: SupabaseClient,
  microgridId: string
): Promise<string | null> {
  type Row = { communities: { org_id: string } | { org_id: string }[] | null };
  const { data, error } = await supabase
    .from("microgrids")
    .select("communities(org_id)")
    .eq("id", microgridId)
    .maybeSingle<Row>();

  if (error || !data) return null;
  // PostgREST returns a to-one embed as an object; tolerate a 1-element array.
  const community = Array.isArray(data.communities)
    ? data.communities[0]
    : data.communities;
  return community?.org_id ?? null;
}

/**
 * True iff the current user has any role row with role = 'super_admin'.
 */
export async function currentUserIsSuperAdmin(
  supabase: SupabaseClient
): Promise<boolean> {
  return rolesIncludeSuperAdmin(await getCurrentUserRoles(supabase));
}

/**
 * True iff the current user is a super_admin OR holds an org_manager row
 * scoped to the given org.
 */
export async function currentUserCanAccessOrg(
  supabase: SupabaseClient,
  orgId: string
): Promise<boolean> {
  return rolesCanAccessOrg(await getCurrentUserRoles(supabase), orgId);
}

/**
 * True iff the current user can access the org that the given community
 * belongs to. Returns false if the community is not found (or RLS hides it).
 */
export async function currentUserCanAccessCommunity(
  supabase: SupabaseClient,
  communityId: string
): Promise<boolean> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  // The role rows and the community's org are independent reads. A
  // super_admin can always access, whatever the lookup found.
  const [roles, orgId] = await Promise.all([
    readUserRoles(supabase, user.id),
    readCommunityOrgId(supabase, communityId),
  ]);
  if (rolesIncludeSuperAdmin(roles)) return true;
  return orgId !== null && rolesCanAccessOrg(roles, orgId);
}

/**
 * True iff the current user can access the org for the given microgrid
 * (microgrid → community → org chain). Returns false if not found.
 */
export async function currentUserCanAccessMicrogrid(
  supabase: SupabaseClient,
  microgridId: string
): Promise<boolean> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  // The role rows and the microgrid's org are independent reads. A
  // super_admin can always access, whatever the lookup found.
  const [roles, orgId] = await Promise.all([
    readUserRoles(supabase, user.id),
    readMicrogridOrgId(supabase, microgridId),
  ]);
  return rolesCanAccessMicrogrid(roles, orgId);
}

/*
 * #321 removed `currentUserCanConfigureEms`. Configuring OpenEMS on a
 * microgrid is now the same permission as reaching the microgrid at all — an
 * org manager configures any microgrid in their own org and nothing else — so
 * `currentUserCanAccessMicrogrid` above is the check, and the BEFORE UPDATE
 * trigger on `microgrids.ems_*` (migration 00053) chains through the matching
 * database helper `user_can_access_microgrid`.
 *
 * Do not reintroduce a separate configuration predicate here without changing
 * that trigger in the same wave: a second definition of "may configure" is the
 * drift the two were merged to remove.
 */
