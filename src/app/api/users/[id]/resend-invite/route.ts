import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG, TENANT } from "@/lib/roles";
import { buildInviteDataPayload } from "@/lib/auth/invite-data-payload";
import { invitationNotice } from "@/lib/auth/invitation-notice";
import { sendNotice } from "@/lib/email/notices";
import { getMgmRuntime } from "@/lib/runtime/root";
import { checkRateLimit } from "@/lib/rate-limit/in-memory";
import type { UserRole, RoleScopeType } from "@/lib/types/domain";
import { ResendInviteBody } from "@/lib/organization-directory/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * POST /api/users/[id]/resend-invite — send the invitation notice again
 * to someone who has not signed in yet (UX5b / #184, RFC #186 § 5).
 *
 * Two-client pattern (mirrors POST /api/users/invite):
 *   userClient = createClient()         → permission checks (RLS-honoring).
 *   svc        = createServiceClient()  → svc.auth.admin.* ops, and the
 *                                         notice (sendNotice reads and
 *                                         decrypts the org's mail sender).
 *
 * Security ordering — permission BEFORE target lookup. Probing UUIDs
 * via this endpoint must produce uniform 403 for invisible rows so
 * an attacker cannot distinguish "exists but you can't resend" from
 * "doesn't exist":
 *
 *   Step A — caller authentication.
 *           userClient.auth.getUser() → 401 if no session.
 *
 *   Step B — resolve target's CURRENT role row via the
 *           `fn_list_visible_users` RPC (user-bound client). The RPC's
 *           body filter calls `user_can_see_user_profile(user_id)` so
 *           RLS-equivalent visibility is enforced uniformly: invisible
 *           row → uniform 403, never "not found". Reading directly from
 *           `user_roles` would NOT work for org_manager →
 *           org_manager-in-same-org because no `user_roles` SELECT
 *           policy grants cross-user reads (only "own row" +
 *           super_admin FOR ALL).
 *
 *           Orphans surface as a row whose `role` column is NULL (LEFT
 *           JOIN miss). The visibility helper still gates them: an
 *           orphan is only visible to the orphan-target itself OR a
 *           super_admin. Caller-side we still require super_admin to
 *           proceed on a NULL-role row.
 *
 *           A call that fails → 500 "Please retry", for every caller,
 *           never read as no row.
 *
 *   Step C — caller permission against TARGET's role row.
 *           no row → 403, or for a super_admin caller the 404 of an
 *             account that does not exist: the RPC lists every staff
 *             account to a super_admin, and no tenant's (RFC mgm#197).
 *           super_admin target → caller must be super_admin.
 *           org_manager target → caller must pass currentUserCanAccessOrg.
 *
 *   Step D — target user lookup via svc.auth.admin.getUserById.
 *           Both error.code === 'user_not_found' AND !data.user → 404.
 *
 *   Step E — pre-check email_confirmed_at IS NOT NULL → 409
 *           "User has already accepted their invitation." The first
 *           sign-in by email link confirms the address.
 *
 *   Step F — build the data payload (shared helper) reflecting the
 *           target's CURRENT role/scope (architect decision: invite
 *           reflects current state, not the original).
 *
 *   Step G — the invitation notice, through the target's organization's
 *           mail sender, or the deployment's (super admin, or an
 *           organization without one). It carries no token.
 *           - more than 3 resends for one person in 10 minutes → 429;
 *             Supabase no longer sends, so it no longer limits this;
 *           - a notice that cannot be sent → 502.
 *
 * Returns 200 { resent: true } on success.
 *
 * Described as `org.resend-invite`. The body is optional: the Users page
 * sends none, and the GUI host sends `{}`. One that is not ResendInviteBody
 * (src/lib/organization-directory/schemas.ts), which takes no field, answers
 * 400 `invalid_body`, before Step A.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CurrentRoleRow {
  role: UserRole | null;
  scope_type: RoleScopeType | null;
  scope_id: string | null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: targetId } = await params;

  if (!UUID_RE.test(targetId)) {
    return NextResponse.json(
      { error: "Invalid user id — expected UUID." },
      { status: 400 }
    );
  }
  // The page sends no body; the host sends `{}`. Both are read as `{}`.
  const parsed = await parseJsonBody(request, ResendInviteBody, { whenEmpty: {} });
  if (!parsed.ok) return parsed.response;

  const userClient = await createClient();

  // ── Step A: authenticate caller ────────────────────────────────────
  const {
    data: { user: caller },
  } = await userClient.auth.getUser();
  if (!caller) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  // ── Step B: resolve target's CURRENT role row via fn_list_visible_users
  //
  // fn_list_visible_users is an RPC (00046_replace_user_directory_with_rpc.sql)
  // that returns rows joining auth.users LEFT user_profiles LEFT user_roles,
  // gated body-side by `WHERE user_can_see_user_profile(au.id)`. The helper
  // is SECURITY DEFINER and reads `auth.uid()` from the caller's JWT — it
  // returns true iff the caller is the target, is a super_admin, OR shares
  // an org-scoped manager role with the target. So a row returned here is
  // guaranteed visible to the caller; an empty result means "doesn't exist
  // OR you can't see it" — uniform 403 (the enumeration-defense rule the
  // route docstring describes).
  //
  // We deliberately do NOT read `user_roles` directly: that table's SELECT
  // policies only grant "own row" + super_admin FOR ALL, so an org_manager
  // B trying to resend an org_manager C in the SAME org would get a NULL
  // row and be 403'd — even though both the RLS helper and the rest of the
  // app correctly consider C visible to B. The RPC is the single source of
  // truth for "can A see B".
  //
  // The RPC replaces the prior `user_directory` view (#269) which leaked
  // auth.users to anon via PostgREST and ran with SECURITY DEFINER on the
  // view itself; the new RPC denies anon at the grant layer (REVOKE EXECUTE
  // FROM anon) and applies the visibility predicate body-side.
  //
  // Only staff access counts here. The RPC's role columns come from the
  // person's `scope_type = 'org'` row, and for any caller it leaves out
  // anyone who holds tenant rows and no staff row now, whatever they held
  // before, and a former tenant with no rows who was never staff (RFC
  // mgm#197, 20261118140000). Such an account therefore gets the answers an
  // account that does not exist gets (Step C), and nothing says it is a
  // tenant's. A tenant role in those columns, which the RPC does not
  // return today, is read as no listing at all, so that stays true if the RPC
  // changes.
  const { data: visibleRows, error: visibleError } = await userClient.rpc(
    "fn_list_visible_users",
    { _target_user_ids: [targetId] }
  );
  if (visibleError) {
    // A failed call is not an empty result: answered 500 for every caller,
    // before Step C, so it never reads as "not found" or "no permission".
    console.error(
      JSON.stringify({
        event: "resend_invite.visibility_error",
        code: visibleError.code,
        message: visibleError.message,
        at: new Date().toISOString(),
      })
    );
    return NextResponse.json(
      { error: "Could not check the user's access. Please retry." },
      { status: 500 }
    );
  }
  const visible = visibleRows?.[0];
  const targetRoleRow: CurrentRoleRow | null =
    visible && visible.role !== TENANT
      ? {
          role: visible.role,
          scope_type: visible.scope_type,
          scope_id: visible.scope_id,
        }
      : null;

  // ── Step C: caller permission against TARGET's role ────────────────
  const callerIsSuper = await currentUserIsSuperAdmin(userClient);

  if (!targetRoleRow) {
    // The target doesn't exist, is invisible to this caller, or is an
    // account the RPC lists for no one (one holding tenant rows and no
    // staff row, or a former tenant with no rows who was never staff).
    // Uniform 403 (existence-leak hardening).
    if (!callerIsSuper) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
    // A super admin is listed every account the RPC keeps
    // (user_can_see_user_profile is true for them), staff orphans
    // included, so nothing left out of a call that succeeded (a failed one
    // was answered 500 above) is a staff invitee: answer as for
    // an account that does not exist, without looking it up or sending a
    // notice, so the answer does not say which it is. This holds while
    // fn_list_visible_users leaves out only accounts that hold no staff row
    // now (staff as @/lib/roles defines it); if it ever leaves out an
    // account holding one, a super admin gets 404 for it here too, so
    // revisit this branch with it.
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  } else if (targetRoleRow.role == null) {
    // Visible row with NULL role = orphan (LEFT JOIN miss on user_roles).
    // Only a super_admin can recover an orphan — everyone else 403.
    if (!callerIsSuper) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
  } else if (targetRoleRow.role === SUPER_ADMIN) {
    if (!callerIsSuper) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
  } else if (targetRoleRow.role === ORG_MANAGER) {
    if (
      targetRoleRow.scope_type !== SCOPE_ORG ||
      !targetRoleRow.scope_id ||
      !(await currentUserCanAccessOrg(userClient, targetRoleRow.scope_id))
    ) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
  } else {
    // Unknown role enum value (future-proofing). Reject conservatively.
    return NextResponse.json(
      { error: "You do not have permission to resend this invitation." },
      { status: 403 }
    );
  }

  // ── Step D: target user lookup (after permission has passed) ───────
  const svc = createServiceClient();
  const lookup = await svc.auth.admin.getUserById(targetId);
  const lookupErrCode = (lookup.error as { code?: string } | null)?.code;
  if (lookupErrCode === "user_not_found" || !lookup.data?.user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }
  const targetUser = lookup.data.user;
  const targetEmail = targetUser.email;
  if (!targetEmail) {
    // Defensive — auth.users rows always have email for invite-flow
    // users, but the SDK type permits undefined.
    return NextResponse.json(
      { error: "Target user has no email on record." },
      { status: 422 }
    );
  }

  // ── Step E: pre-check already-confirmed ────────────────────────────
  if (targetUser.email_confirmed_at != null) {
    return NextResponse.json(
      { error: "User has already accepted their invitation." },
      { status: 409 }
    );
  }

  // ── Step F: build data payload reflecting CURRENT role/scope ──────
  //
  // For orphans (no role row), we still pass app_name + a generic role
  // label so the template renders consistently. invited_by_name and
  // org_name are populated when applicable.
  const data = await buildInviteDataPayload({
    caller,
    targetRole: targetRoleRow?.role ?? ORG_MANAGER, // orphan fallback
    targetOrgId: targetRoleRow?.scope_id ?? null,
    supabase: userClient,
  });

  // ── Step G: send the notice again ──────────────────────────────────
  // Per process, like the payment-link limiter; enough to stop a stuck
  // button from flooding someone's inbox.
  if (!checkRateLimit(`resend-invite:${targetId}`, 3, 10 * 60_000).ok) {
    return NextResponse.json(
      {
        error: "Too many invitations sent recently. Try again in a few minutes.",
        code: "rate_limited",
      },
      { status: 429 }
    );
  }
  const runtime = await getMgmRuntime();
  const notice = await sendNotice({
    service: svc,
    transports: runtime.mailTransports,
    orgId: targetRoleRow?.role === ORG_MANAGER ? targetRoleRow.scope_id : null,
    message: invitationNotice({ to: targetEmail, data }),
  });
  if (!notice.ok) {
    return NextResponse.json(
      { error: "The invitation email could not be sent. Check the organization's email settings, or tell them to sign in at MGM with this address." },
      { status: 502 }
    );
  }

  return NextResponse.json({ resent: true }, { status: 200 });
}
