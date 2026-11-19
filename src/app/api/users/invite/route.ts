import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
  getCurrentUserRoles,
  rolesIncludeSuperAdmin,
  staffRoles,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";
import { buildInviteDataPayload, type InviteDataPayload } from "@/lib/auth/invite-data-payload";
import { invitationNotice } from "@/lib/auth/invitation-notice";
import { sendNotice } from "@/lib/email/notices";
import { getMgmRuntime } from "@/lib/runtime/root";
import type { UserRole } from "@/lib/types/domain";

/**
 * POST /api/users/invite — invite a new user (UX5 / #79).
 *
 * Two-client flow (canonical pattern — see src/lib/supabase/service.ts
 * for rationale):
 *
 *   userClient = createClient()         → user-bound, used for:
 *                                           1) defense-in-depth perm checks
 *                                           2) fn_finalize_user_invitation RPC,
 *                                              or fn_change_user_role for a
 *                                              tenant made staff (both are
 *                                              SECURITY DEFINER but still read
 *                                              auth.uid() from the caller's
 *                                              JWT — so the permission
 *                                              helpers inside them evaluate
 *                                              against the caller, not the
 *                                              function owner)
 *   svc        = createServiceClient()  → service-role, used ONLY for:
 *                                           svc.auth.admin.listUsers
 *                                           svc.auth.admin.createUser
 *                                           svc.auth.admin.deleteUser
 *                                           reading the target's user_roles
 *                                           and user_profiles rows
 *                                           sending the invitation notice
 *                                           (sendNotice reads and decrypts
 *                                           the org's mail sender)
 *
 * Steps:
 *   1. Validate body + defense-in-depth permission check.
 *   2. Look up an existing account for the email and read all of its
 *      user_roles rows. Decided by those rows, not by the profile: every
 *      auth.users row has a profile (trigger, 00017), so a profile says
 *      nothing about access.
 *        - Staff rows (staffRoles), one of them the requested access →
 *          409 `already_member`.
 *        - Other staff rows → 409 `other_access` (a role change).
 *        - Tenant rows only (RFC mgm#197): a person who rents a unit.
 *          Making them staff is a role change too, so only a super admin
 *          does it here, through fn_change_user_role as
 *          PATCH /api/users/[id]/role does; its DELETE takes org-scoped
 *          rows only, so a tenant made staff keeps their home. Their profile
 *          is kept as it is, and the notice goes as for any existing
 *          account (step 5). Anyone else gets the `other_access` answer, word
 *          for word, and nothing is written: it says no more about the
 *          address than that answer says for any account that holds access.
 *          fn_finalize_user_invitation is never called for an account that
 *          holds any user_roles row.
 *        - No rows (access removed, or an invitation that did not finish)
 *          → reuse the account. Profile fields the person already has are
 *          kept.
 *      No account: svc.auth.admin.createUser(email) creates one with no
 *      password and email_confirmed_at = NULL, and sends nothing.
 *   3. userClient.rpc('fn_finalize_user_invitation', ...) — inserts the
 *      user_profiles + user_roles rows atomically under the caller's
 *      session, for a new account or one with no rows.
 *   4. Cleanup on RPC failure: svc.auth.admin.deleteUser(userId), only for
 *      an account step 2 created. Best effort — log if cleanup also fails.
 *   5. Only once the access is saved, the invitation notice (RFC #186 § 5)
 *      through the organization's mail sender, or the deployment's for a
 *      super admin or an organization without one. It carries no token:
 *      the person signs in by email link, which also confirms the address.
 *      A notice that cannot be sent leaves the access in place and answers
 *      email_sent: false, so the inviter can tell the person directly.
 *
 * Response: 201 { user_id, existing_account, email_sent }.
 * Error contract: { error: string, field?: string, code?: string }
 *   403 — not authorized (either at the defense-in-depth check or at
 *         the RPC ERRCODE 42501).
 *   409 — the email's account already has access (see step 2), or, for a
 *         tenant made staff, fn_change_user_role's 40000.
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

  // Who invited them, to what and as what, for the notice; also kept on
  // auth.users.raw_user_meta_data as before. Alongside it, whether the
  // caller is a super admin, which only an address whose rows are all
  // tenant rows needs (step 2). It is read here, for every invitation, so
  // the `other_access` answer for such an address follows the same reads
  // as the one for an address with staff rows.
  const [inviteData, callerRoles] = await Promise.all([
    buildInviteDataPayload({
      caller,
      targetRole: role,
      targetOrgId: scopeId,
      supabase: userClient,
    }),
    getCurrentUserRoles(userClient, caller),
  ]);
  const callerIsSuperAdmin = rolesIncludeSuperAdmin(callerRoles);

  const svc = createServiceClient();

  // ── Step 2: does this email already have an account? ─────────────────
  //
  // Looked up first: an existing account is reused, and only an account
  // this request created may be deleted when step 3 fails.
  const lookup = await findAuthUserByEmail(svc, email);
  if (!lookup.ok) {
    return NextResponse.json(
      { error: "Could not check for an existing account. Please retry." },
      { status: 500 }
    );
  }

  let targetUserId: string;
  let createdByThisRequest = false;
  let profileValues = {
    first_name: firstName || null,
    last_name: lastName || null,
    phone: phone || null,
  };

  if (lookup.user) {
    const existing = lookup.user;
    const rows = await roleRowsOf(svc, existing.id);
    if (rows === null) {
      return NextResponse.json(
        { error: "Could not check the account's access. Please retry." },
        { status: 500 }
      );
    }
    const roles = staffRoles(rows);

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
      // A user may hold several role rows; any other staff access means
      // this is a role change, which has its own flow and permission rules.
      return otherAccess(email);
    }

    if (rows.length > 0) {
      // Tenant rows only: staffRoles keeps every row but a tenant row, and
      // kept none.
      // Making a tenant staff is a role change: a super admin's, through
      // fn_change_user_role, and anyone else gets the answer above.
      if (!callerIsSuperAdmin) return otherAccess(email);
      return makeTenantStaff({ userClient, svc, userId: existing.id, email, role, scopeId, inviteData });
    }

    // An account with no rows: someone whose access was removed
    // (DELETE /api/users/[id] keeps the account and profile so they can be
    // invited again), or one left behind by an invitation that did not
    // finish.
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
  } else {
    // ── Step 2b: no account — create one, with no password ─────────────
    const inviteRes = await svc.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: inviteData,
    });
    if (inviteRes.error) {
      if (isEmailExistsError(inviteRes.error)) {
        // Created between the lookup and this call.
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

  // ── Step 5: the invitation notice, once the access is saved ──────────
  const emailSent = await sendInvitationNotice({ svc, email, role, scopeId, inviteData });

  return NextResponse.json(
    {
      user_id: targetUserId,
      existing_account: !createdByThisRequest,
      email_sent: emailSent,
    },
    { status: 201 }
  );
}

/**
 * Step 2 for an account whose rows are all tenant rows, once the caller is
 * known to be a super admin: the requested staff role through
 * fn_change_user_role, called and its errors mapped as
 * PATCH /api/users/[id]/role does. Its DELETE is limited to org-scoped rows,
 * so the person's tenant rows stay; if that changes, revisit. The profile is
 * not written: what the person has is kept, and the form's fields are not
 * filled in, because the only write this route makes to a profile is
 * fn_finalize_user_invitation's. Then the notice, as for any existing
 * account.
 */
async function makeTenantStaff(input: {
  userClient: SupabaseClient;
  svc: SupabaseClient;
  userId: string;
  email: string;
  role: UserRole;
  scopeId: string | null;
  inviteData: InviteDataPayload;
}): Promise<NextResponse> {
  const { error } = await input.userClient.rpc("fn_change_user_role", {
    p_user_id: input.userId,
    p_role: input.role,
    p_scope_id: input.scopeId ?? undefined,
  });
  if (error) {
    const pgCode = (error as { code?: string }).code;
    let status = 500;
    if (pgCode === "42501") status = 403;
    else if (pgCode === "22023") status = 422;
    else if (pgCode === "40000") status = 409;
    return NextResponse.json({ error: `Invite failed: ${error.message}` }, { status });
  }

  const emailSent = await sendInvitationNotice(input);
  return NextResponse.json(
    { user_id: input.userId, existing_account: true, email_sent: emailSent },
    { status: 201 }
  );
}

/**
 * The invitation notice (step 5), through the invited organization's mail
 * sender, or the deployment's for a super admin. True iff it was sent; a
 * notice that cannot be sent leaves the access in place.
 */
async function sendInvitationNotice(input: {
  svc: SupabaseClient;
  email: string;
  role: UserRole;
  scopeId: string | null;
  inviteData: InviteDataPayload;
}): Promise<boolean> {
  try {
    const runtime = await getMgmRuntime();
    const notice = await sendNotice({
      service: input.svc,
      transports: runtime.mailTransports,
      orgId: input.role === ORG_MANAGER ? input.scopeId : null,
      message: invitationNotice({ to: input.email, data: input.inviteData }),
    });
    return notice.ok;
  } catch (noticeErr) {
    console.error("[invite] The invitation notice failed:", (noticeErr as Error).name);
    return false;
  }
}

/** The 409 for an account that already holds access other than the one requested. */
function otherAccess(email: string): NextResponse {
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

/** All of the account's user_roles rows, tenant rows (RFC mgm#197) included; null when they cannot be read. */
async function roleRowsOf(
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
