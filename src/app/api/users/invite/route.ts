import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";
import { buildInviteDataPayload } from "@/lib/auth/invite-data-payload";
import { resolveOrigin } from "@/lib/auth/resolve-origin";
import type { UserRole } from "@/lib/types/domain";

/**
 * POST /api/users/invite — invite a new user (UX5 / #79).
 *
 * Two-client flow (canonical pattern — see src/lib/supabase/service.ts
 * for rationale):
 *
 *   userClient = createClient()         → user-bound, used for:
 *                                           1) defense-in-depth perm checks
 *                                           2) fn_finalize_user_invitation RPC
 *                                              (the RPC is SECURITY DEFINER
 *                                              but still reads auth.uid()
 *                                              from the caller's JWT — so
 *                                              the permission helpers inside
 *                                              the RPC evaluate against the
 *                                              caller, not the function owner)
 *   svc        = createServiceClient()  → service-role, used ONLY for:
 *                                           svc.auth.admin.listUsers
 *                                           svc.auth.admin.inviteUserByEmail
 *                                           svc.auth.admin.deleteUser
 *                                           reading the target's user_roles
 *                                           and user_profiles rows
 *
 * Steps:
 *   1. Validate body + defense-in-depth permission check.
 *   2. Look up an existing account for the email. Decided by role rows,
 *      not by the profile: every auth.users row has a profile (trigger,
 *      00017), so a profile says nothing about access.
 *        - Already holds the requested access → 409 `already_member`.
 *        - Holds other access → 409 `other_access` (a role change).
 *        - Holds none (access removed, or an unfinished invitation) →
 *          reuse the account. Unconfirmed: re-send the invitation email.
 *          Confirmed: no email; they sign in as before. Profile fields the
 *          person already has are kept.
 *      No account: svc.auth.admin.inviteUserByEmail(email) creates one
 *      with email_confirmed_at = NULL and sends the magic-link email.
 *   3. userClient.rpc('fn_finalize_user_invitation', ...) — inserts the
 *      user_profiles + user_roles rows atomically under the caller's
 *      session.
 *   4. Cleanup on RPC failure: svc.auth.admin.deleteUser(userId), only for
 *      an account step 2 created. Best effort — log if cleanup also fails.
 *
 * Response: 201 { user_id, existing_account, email_sent }.
 * Error contract: { error: string, field?: string, code?: string }
 *   403 — not authorized (either at the defense-in-depth check or at
 *         the RPC ERRCODE 42501).
 *   409 — the email's account already has access (see step 2).
 *   422 — validation error.
 *   500 — unexpected.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InviteBody {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  role?: UserRole;
  scope_id?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: InviteBody;
  try {
    body = (await request.json()) as InviteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validate shape ────────────────────────────────────────────────────
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "A valid email is required.", field: "email" },
      { status: 422 }
    );
  }

  const role = body.role;
  if (role !== SUPER_ADMIN && role !== ORG_MANAGER) {
    return NextResponse.json(
      {
        error: `Role must be one of '${SUPER_ADMIN}' or '${ORG_MANAGER}'.`,
        field: "role",
      },
      { status: 422 }
    );
  }

  let scopeId: string | null;
  if (role === SUPER_ADMIN) {
    // super_admin scope MUST be null.
    scopeId = null;
  } else {
    // org_manager scope MUST be a UUID.
    scopeId = typeof body.scope_id === "string" ? body.scope_id : "";
    if (!scopeId || !UUID_RE.test(scopeId)) {
      return NextResponse.json(
        {
          error: "org_manager invitations require a scope_id (org).",
          field: "scope_id",
        },
        { status: 422 }
      );
    }
  }

  const firstName =
    typeof body.first_name === "string" ? body.first_name.trim() : "";
  const lastName =
    typeof body.last_name === "string" ? body.last_name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";

  const userClient = await createClient();

  // ── Defense-in-depth permission check ────────────────────────────────
  // RLS + RPC permission checks are the authoritative gates, but we
  // surface a clean 403 before any mutation.
  if (role === SUPER_ADMIN) {
    if (!(await currentUserIsSuperAdmin(userClient))) {
      return NextResponse.json(
        { error: "Only super admins can invite super admins." },
        { status: 403 }
      );
    }
  } else {
    // org_manager invite: caller must have access to the target org.
    if (!scopeId || !(await currentUserCanAccessOrg(userClient, scopeId))) {
      return NextResponse.json(
        {
          error: "You do not have permission to invite into this organization.",
        },
        { status: 403 }
      );
    }
  }

  // ── Invitation email payload ─────────────────────────────────────────
  //
  // The `data` payload (UX5b / #184) is forwarded to the email template
  // so the rendered invitation includes the inviter name, org name, and
  // a humanized role label. GoTrue persists this on
  // auth.users.raw_user_meta_data — see invite-data-payload.ts.
  const {
    data: { user: caller },
  } = await userClient.auth.getUser();
  if (!caller) {
    // Should not happen — RLS in the perm checks above already requires
    // an authenticated session — but guard for type-narrowing.
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  const inviteData = await buildInviteDataPayload({
    caller,
    targetRole: role,
    targetOrgId: scopeId,
    supabase: userClient,
  });

  const svc = createServiceClient();

  // Per-call redirectTo: lands GoTrue's verify redirect on the MGM
  // accept-invite landing page, which calls verifyOtp + renders the
  // set-password form (UX5c / #189). Deliberately not hardcoded —
  // resolveOrigin honours x-forwarded-* so previews + local dev work.
  const origin = resolveOrigin(request);
  const inviteOptions = {
    data: inviteData,
    redirectTo: `${origin}/accept-invite`,
  };

  // ── Step 2: does this email already have an account? ─────────────────
  //
  // Looked up BEFORE inviting, because GoTrue's invite does not say which
  // case it handled: for an email with an unconfirmed account it re-sends
  // the invitation to that account instead of creating one, and returns it
  // exactly as it returns a new user. Only an account this request created
  // may be deleted when step 3 fails.
  const lookup = await findAuthUserByEmail(svc, email);
  if (!lookup.ok) {
    return NextResponse.json(
      { error: "Could not check for an existing account. Please retry." },
      { status: 500 }
    );
  }

  let targetUserId: string;
  let createdByThisRequest = false;
  let emailSent = true;
  let profileValues = {
    first_name: firstName || null,
    last_name: lastName || null,
    phone: phone || null,
  };

  if (lookup.user) {
    const existing = lookup.user;
    const roles = await rolesOf(svc, existing.id);
    if (roles === null) {
      return NextResponse.json(
        { error: "Could not check the account's access. Please retry." },
        { status: 500 }
      );
    }

    if (roles.some((r) => grantsRequestedAccess(r, role, scopeId))) {
      return NextResponse.json(
        {
          error:
            role === SUPER_ADMIN
              ? `${email} is already a super admin.`
              : `${email} already has access to this organization.`,
          field: "email",
          code: "already_member",
        },
        { status: 409 }
      );
    }

    if (roles.length > 0) {
      // A user may hold several role rows; any other access means this is
      // a role change, which has its own flow and permission rules.
      return NextResponse.json(
        {
          error:
            `${email} already has an MGM account with a different role. ` +
            "A super admin can change it from the Users list.",
          field: "email",
          code: "other_access",
        },
        { status: 409 }
      );
    }

    // An account with no access: someone whose access was removed (DELETE
    // /api/users/[id] keeps the account and profile so they can be invited
    // again) or one left behind by an invitation that did not finish.
    targetUserId = existing.id;

    // Keep what the person already has on their profile; the form only
    // fills fields that are empty, because the user_profiles UPDATE policy
    // (00012) lets only the person or a super admin edit a profile — if
    // that policy changes, revisit.
    const profileRead = await profileOf(svc, existing.id);
    if (!profileRead.ok) {
      // Stop rather than treat a failed read as an empty profile: step 3
      // writes all three fields, so guessing would overwrite what they have.
      return NextResponse.json(
        { error: "Could not read the account's profile. Please retry." },
        { status: 500 }
      );
    }
    const current = profileRead.profile;
    profileValues = {
      first_name: current?.first_name || profileValues.first_name,
      last_name: current?.last_name || profileValues.last_name,
      phone: current?.phone || profileValues.phone,
    };

    if (existing.email_confirmed_at) {
      // They already have a password and can sign in; an invitation link
      // would be refused for a confirmed account.
      emailSent = false;
    } else {
      const resend = await svc.auth.admin.inviteUserByEmail(
        email,
        inviteOptions
      );
      if (resend.error) {
        if (!isEmailExistsError(resend.error)) {
          return NextResponse.json(
            { error: `Invite failed: ${resend.error.message}` },
            { status: 422 }
          );
        }
        // Confirmed since the lookup: they can sign in already.
        emailSent = false;
      }
    }
  } else {
    // ── Step 2b: no account — invite creates one ───────────────────────
    const inviteRes = await svc.auth.admin.inviteUserByEmail(
      email,
      inviteOptions
    );
    if (inviteRes.error) {
      if (isEmailExistsError(inviteRes.error)) {
        // Created between the lookup and the invite.
        return NextResponse.json(
          {
            error: `${email} was just registered. Retry to see its status.`,
            field: "email",
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: `Invite failed: ${inviteRes.error.message}` },
        { status: 422 }
      );
    }
    const newId = inviteRes.data.user?.id ?? null;
    if (!newId) {
      return NextResponse.json(
        { error: "Invite succeeded but no user ID was returned." },
        { status: 500 }
      );
    }
    targetUserId = newId;
    createdByThisRequest = true;
  }

  // ── Step 3: finalize via user-bound RPC (permission-checked inside) ──
  const { error: rpcError } = await userClient.rpc(
    "fn_finalize_user_invitation",
    {
      p_user_id: targetUserId,
      p_first_name: profileValues.first_name,
      p_last_name: profileValues.last_name,
      p_phone: profileValues.phone,
      p_role: role,
      p_scope_id: scopeId ?? undefined,
    }
  );

  if (rpcError) {
    // Step 4: remove the account this request created so the caller can
    // retry. An account that existed before the request is left alone.
    if (createdByThisRequest) {
      try {
        await svc.auth.admin.deleteUser(targetUserId);
      } catch (cleanupErr) {
        console.error(
          "[invite] Failed to clean up auth.users after RPC failure:",
          cleanupErr
        );
      }
    }

    // Map Postgres errcode to HTTP.
    //   42501 → 403 (permission denied by RPC's SECURITY INVOKER check)
    //   22023 → 422 (invalid parameter — e.g. scope_id missing)
    const pgCode = (rpcError as { code?: string }).code;
    const status = pgCode === "42501" ? 403 : pgCode === "22023" ? 422 : 500;
    return NextResponse.json(
      { error: `Invite failed: ${rpcError.message}` },
      { status }
    );
  }

  return NextResponse.json(
    {
      user_id: targetUserId,
      existing_account: !createdByThisRequest,
      email_sent: emailSent,
    },
    { status: 201 }
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isEmailExistsError(error: { message?: string }): boolean {
  // Defensive email_exists detection across SDK versions — check
  // error.code AND a message-text fallback.
  const code = (error as { code?: string }).code;
  const msg = error.message?.toLowerCase() ?? "";
  return (
    code === "email_exists" ||
    msg.includes("already registered") ||
    msg.includes("already been registered") ||
    msg.includes("user already exists") ||
    msg.includes("already in use")
  );
}

async function findAuthUserByEmail(
  svc: SupabaseClient,
  email: string
): Promise<{ ok: true; user: User | null } | { ok: false }> {
  const lower = email.toLowerCase();
  // MVP uses a single page; pagination is deferred. 1000 is far above
  // any plausible MGM user count at pilot scale.
  const { data, error } = await svc.auth.admin.listUsers({ perPage: 1000 });
  if (error || !data) return { ok: false };
  if (data.users.length === 1000) {
    console.warn(
      "[invite] listUsers returned exactly 1000 users — cap reached. " +
        "Some existing accounts may be invisible to the lookup. " +
        "Implement pagination when user count approaches 1000."
    );
  }
  return {
    ok: true,
    user: data.users.find((u) => u.email?.toLowerCase() === lower) ?? null,
  };
}

interface RoleRow {
  role: UserRole;
  scope_type: string | null;
  scope_id: string | null;
}

async function rolesOf(
  svc: SupabaseClient,
  userId: string
): Promise<RoleRow[] | null> {
  const { data, error } = await svc
    .from("user_roles")
    .select("role, scope_type, scope_id")
    .eq("user_id", userId);
  if (error) return null;
  return (data ?? []) as RoleRow[];
}

function grantsRequestedAccess(
  row: RoleRow,
  role: UserRole,
  scopeId: string | null
): boolean {
  if (role === SUPER_ADMIN) return row.role === SUPER_ADMIN;
  return (
    row.role === role &&
    row.scope_type === SCOPE_ORG &&
    row.scope_id === scopeId
  );
}

async function profileOf(
  svc: SupabaseClient,
  userId: string
): Promise<
  | {
      ok: true;
      profile: {
        first_name: string | null;
        last_name: string | null;
        phone: string | null;
      } | null;
    }
  | { ok: false }
> {
  const { data, error } = await svc
    .from("user_profiles")
    .select("first_name, last_name, phone")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, profile: data ?? null };
}
