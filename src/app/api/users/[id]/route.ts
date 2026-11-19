import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TENANT } from "@/lib/roles";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/users/[id] — soft-delete a user (UX5 / #79).
 *
 * IMPORTANT: uses the user-bound server client, NOT the service-role
 * client. Rationale:
 *
 *   - The BEFORE DELETE trigger on `user_roles`
 *     (fn_user_roles_before_delete_guard) checks `auth.uid()` for the
 *     self-revocation guard, and the last-super_admin guard relies on
 *     RLS-filtered counts. The service-role client has `auth.uid()`
 *     = NULL and bypasses RLS — both guards would misbehave (the
 *     self-revoke guard would be skipped, and the last-super_admin
 *     count would read ALL rows regardless of caller).
 *
 *   - Additionally, user_roles RLS enforces "super_admin may manage
 *     all" — org_managers cannot `DELETE FROM user_roles WHERE ...`
 *     unless the existing policy changes. The route's user-bound
 *     DELETE naturally produces zero rows affected for an org_manager
 *     targeting rows they don't own; we convert that to 403.
 *
 * Soft-delete semantics: removes the target user's staff `user_roles`
 * rows, every row whose role is not `tenant`. Does NOT touch `auth.users`
 * or `user_profiles` — this preserves the audit trail and allows
 * re-invitation later. A tenant row (RFC mgm#197) is the person's access to
 * a unit they rent, given and removed from the tenant record
 * (`fn_tenant_access_grant` / `fn_tenant_access_revoke`), never from the
 * Users page, so it stays: removing someone's staff access leaves their
 * home. Afterwards the person is a tenant like any other if they hold
 * tenant rows (given further units, off the Users page, kept to tenant
 * pages by the (gui) layout). "Not tenant" is staff as `staffRoles` (@/lib/auth/access) counts
 * it; if a second role that is not staff is added, revisit both.
 *
 * Errors:
 *   204 — success (no body).
 *   400 — invalid id.
 *   403 — not authorized (self-revoke trigger / RLS filtered).
 *   409 — last super_admin (trigger 40000).
 *   500 — unexpected.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid user id — expected UUID." },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  const { error, count } = await supabase
    .from("user_roles")
    .delete({ count: "exact" })
    .eq("user_id", id)
    .neq("role", TENANT);

  if (error) {
    // Trigger RAISEs surface here with a pg code.
    const pgCode = (error as { code?: string }).code;
    let status = 500;
    if (pgCode === "42501") status = 403;
    else if (pgCode === "40000") status = 409;
    return NextResponse.json({ error: error.message }, { status });
  }

  if ((count ?? 0) === 0) {
    // Either the user had no staff rows to begin with (none at all, or only
    // tenant rows), or RLS filtered them out. Either way the caller cannot
    // revoke — 403, the same answer whichever, so it never tells a caller
    // that an account holds tenant access.
    return NextResponse.json(
      { error: "No roles revoked (not authorized, or user has no roles)." },
      { status: 403 }
    );
  }

  return new NextResponse(null, { status: 204 });
}
