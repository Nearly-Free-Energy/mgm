import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TENANT } from "@/lib/roles";
import { RemoveUserBody } from "@/lib/organization-directory/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import { typedNameMatches } from "@/lib/validation/typed-name";

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
 *   - An org_manager's delete removes nothing today. A DELETE reaches only
 *     rows a SELECT policy also shows, and the user_roles SELECT policies
 *     show an org_manager only their own rows ("Users can view their own
 *     roles", 00002_rls.sql; the FOR ALL policy is super_admin's). So the
 *     org-manager DELETE policy ("Org managers can delete user_roles in
 *     their orgs", 00013) matches no colleague's row, the user-bound DELETE
 *     affects zero rows, and we convert that to 403. org.remove-user's
 *     prepare refuses an org_manager with the same 403 for this reason
 *     (prepareRemoveUser, src/lib/organization-directory/surface/users.ts).
 *     If org_managers are ever given a SELECT policy on colleagues' rows,
 *     their deletes start to succeed: revisit that refusal.
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
 * Confirmation: `org.remove-user` is a typed action, and the route requires
 * the person's email address, typed (RemoveUserBody,
 * src/lib/organization-directory/schemas.ts; an empty body is read as `{}`).
 * The person is read first, with the caller's own client, through
 * fn_list_visible_users, the Users page's own list. Anyone it does not list
 * to this caller (no such account, one row-level security hides, or one
 * holding tenant rows only, whom it lists for no one) gets the 403 below at
 * once, whatever confirmation the body carries, as the delete gave them
 * before: such a person has no staff row this caller may delete, since the
 * function lists
 * everyone holding an org-scoped row the caller can reach
 * (user_can_see_user_profile, which covers the rows the org-manager delete
 * policy names) and, to a super admin, everyone holding any staff row. So
 * the 428 names an address only to a caller the list already shows it to.
 * If the function stops listing someone whose staff rows the caller may
 * delete, this refuses that removal instead of making it: revisit. The
 * triggers' refusals (removing yourself, the last super admin) come after
 * the confirmation.
 *   - no `confirmation`: 428 `user_remove_confirmation_required`, naming
 *     the address to type. Nothing is deleted.
 *   - an address that is not theirs, or none typed: 428
 *     `user_remove_email_mismatch`.
 * The Users page's revoke dialog (EditUserDialog) sends the address it asked
 * for, and the GUI host the address typed in its step.
 *
 * Errors:
 *   204 — success (no body).
 *   400 — invalid id, or a body that is not RemoveUserBody.
 *   403 — not authorized (self-revoke trigger / RLS filtered).
 *   409 — last super_admin (trigger 40000).
 *   428 — the confirmation is missing or names another address.
 *   500 — unexpected, or the list could not be read.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid user id — expected UUID." },
      { status: 400 }
    );
  }

  // A DELETE often has no body; an empty one is read as `{}`, which asks for the address.
  const empty = (await request.clone().text()).trim() === "";
  const parsed = empty
    ? ({ ok: true, data: RemoveUserBody.parse({}) } as const)
    : await parseJsonBody(request, RemoveUserBody);
  if (!parsed.ok) return parsed.response;

  const supabase = await createClient();

  // The person as the Users page lists them to this caller; nobody else's
  // address is read. A tenant role in the listing, which the function does
  // not return, is read as no listing, as the resend route reads it.
  const { data: listed, error: listError } = await supabase.rpc(
    "fn_list_visible_users",
    { _target_user_ids: [id] }
  );
  if (listError) {
    return NextResponse.json(
      { error: "Could not check the user's access. Please retry." },
      { status: 500 }
    );
  }
  const person = listed?.[0];
  if (!person || person.role === TENANT || !person.email) return notRevoked();
  const { confirmation } = parsed.data;
  const typeTheAddress = `Type the person's email address, ${person.email}, to remove their access.`;
  if (!confirmation) {
    return NextResponse.json(
      { error: typeTheAddress, code: "user_remove_confirmation_required" },
      { status: 428 }
    );
  }
  if (!typedNameMatches(confirmation.typed, person.email)) {
    return NextResponse.json(
      { error: typeTheAddress, code: "user_remove_email_mismatch", field: "confirmation" },
      { status: 428 }
    );
  }

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
    return notRevoked();
  }

  return new NextResponse(null, { status: 204 });
}

/** The one answer for a person whose staff access this caller cannot remove, whatever the reason. */
function notRevoked(): NextResponse {
  return NextResponse.json(
    { error: "No roles revoked (not authorized, or user has no roles)." },
    { status: 403 }
  );
}
