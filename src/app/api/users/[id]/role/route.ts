import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ORG_MANAGER } from "@/lib/roles";
import { CHANGE_ROLE_REFUSALS, ChangeRoleBody } from "@/lib/organization-directory/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/users/[id]/role — change a user's role (UX5 / #79).
 *
 * Delegates to `fn_change_user_role(p_user_id, p_role, p_scope_id)`,
 * invoked via the user-bound server client so the helpers
 * (`is_super_admin()`, `user_can_access_org()`) see the caller's
 * `auth.uid()`. The RPC enforces:
 *   - the caller is a super_admin (20261119150000), as the Users page
 *     offers role changes only to super admins;
 *   - super_admin-target → scope_id NULL.
 *   - org_manager-target → scope_id required.
 * Errors surface as Postgres ERRCODE 42501 / 22023; the BEFORE DELETE
 * trigger also fires during the RPC's internal DELETE → can raise
 * 40000 (last super_admin) or 42501 (self).
 *
 * Described as `org.change-role`, a ceremony: the body is ChangeRoleBody
 * (src/lib/organization-directory/schemas.ts), refused with this route's own
 * answers (CHANGE_ROLE_REFUSALS). Its `confirmation` carries nothing to
 * check. What a change does is fn_change_user_role's alone: the route calls
 * it for every send, including one asking for the role the person holds.
 *
 * Error contract: { error: string }
 *   403 — not authorized (42501 or self-revoke)
 *   409 — last super_admin (40000)
 *   422 — invalid parameter (22023)
 *   500 — unexpected
 */
export async function PATCH(
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

  const parsed = await parseJsonBody(request, ChangeRoleBody, { refusals: CHANGE_ROLE_REFUSALS });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const role = body.role;

  let scopeId: string | null = null;
  if (role === ORG_MANAGER) {
    scopeId = typeof body.scope_id === "string" ? body.scope_id : "";
    if (!scopeId || !UUID_RE.test(scopeId)) {
      return NextResponse.json(
        {
          error: "org_manager requires a scope_id (org).",
          field: "scope_id",
        },
        { status: 422 }
      );
    }
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("fn_change_user_role", {
    p_user_id: id,
    p_role: role,
    p_scope_id: scopeId ?? undefined,
  });

  if (error) {
    const pgCode = (error as { code?: string }).code;
    let status = 500;
    if (pgCode === "42501") status = 403;
    else if (pgCode === "22023") status = 422;
    else if (pgCode === "40000") status = 409;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
