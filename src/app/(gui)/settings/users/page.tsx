import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
  rolesIncludeStaff,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import type { UserVisibleRow, UserRoleRecord } from "@/lib/types/domain";
import { UsersPageClient } from "./users-page-client";
import { keepTenantOnlyToTenantPages } from "@/lib/gui/host/server/tenant-pages";

/**
 * /settings/users — admin view of all users visible to the caller.
 *
 * Server component: calls the `fn_list_visible_users` RPC (migration
 * 00046) which enforces the `user_can_see_user_profile(user_id)`
 * visibility predicate body-side. The RPC supersedes the old
 * `user_directory` view (dropped in #269 to clear two CRITICAL
 * Supabase linter ERRORs: auth_users_exposed + security_definer_view).
 *
 * Also fetches the org list (for the Invite dialog) scoped to the
 * caller's role:
 *   - super_admin → all orgs (limited by organizations RLS, which
 *     grants super_admin full access).
 *   - org_manager → only the orgs the caller can access.
 *
 * Status is derived from email_confirmed_at: NULL = "Invited", else
 * "Active". DO NOT use last_sign_in_at — it is NULL for any logged-out
 * confirmed user.
 *
 * A staff page: a person whose rows are all tenant rows (RFC mgm#197)
 * manages no one, so it is not found for them, before the list is read.
 * Their tenant rows count for nothing here, so a caller who is not a super
 * admin is an org manager by their org-scoped rows alone.
 */
export default async function SettingsUsersPage() {
  await keepTenantOnlyToTenantPages();
  const supabase = await createClient();

  const roles: UserRoleRecord[] = await getCurrentUserRoles(supabase);
  if (!rolesIncludeStaff(roles)) notFound();
  const isSuperAdmin = await currentUserIsSuperAdmin(supabase);

  // Caller's org scopes (for the Invite dialog and revoke gating).
  const callerOrgIds: string[] = Array.from(
    new Set(
      roles
        .filter((r) => r.role === ORG_MANAGER && r.scope_id != null)
        .map((r) => r.scope_id as string)
    )
  );

  // Fetch rows. No args → list all visible users (per the RPC contract).
  // An error is not an empty list: render the load-failure state rather
  // than "No users yet", and log the PostgREST error for the operator.
  const { data: rowsData, error: rowsError } = await supabase.rpc(
    "fn_list_visible_users"
  );
  if (rowsError) {
    console.error(
      JSON.stringify({
        event: "settings_users.list_error",
        code: rowsError.code,
        message: rowsError.message,
        details: rowsError.details,
        hint: rowsError.hint,
        at: new Date().toISOString(),
      })
    );
  }
  const rows: UserVisibleRow[] = ((rowsData ?? []) as UserVisibleRow[]).filter(
    (r) => r.user_id != null
  );

  // Fetch orgs for the invite/edit dialogs.
  // RLS on organizations filters this appropriately for the caller.
  const { data: orgsData } = await supabase
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });
  const orgs = (orgsData ?? []).map((o) => ({ id: o.id, name: o.name }));

  // Current user id (for "own row" / revoke-self guards on the client).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const currentUserId = user?.id ?? "";
  const callerRole: "super_admin" | "org_manager" = isSuperAdmin
    ? SUPER_ADMIN
    : ORG_MANAGER;

  return (
    <UsersPageClient
      rows={rows}
      loadFailed={rowsError != null}
      orgs={orgs}
      callerRole={callerRole}
      callerOrgIds={callerOrgIds}
      currentUserId={currentUserId}
    />
  );
}
