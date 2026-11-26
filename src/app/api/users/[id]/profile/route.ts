import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserAccess, rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { UPDATE_PROFILE_REFUSALS, UpdateProfileBody } from "@/lib/organization-directory/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/users/[id]/profile — partial profile update (UX5 / #79).
 *
 * Dirty-fields semantics: only keys present in the body are updated.
 *
 * Authorization: the user_profiles UPDATE RLS policy is the authoritative
 * gate — "self edits self OR super_admin edits anyone". Org_managers
 * cannot edit other people's profiles. The policy filters rather than
 * raises, so such an UPDATE affects 0 rows with no error; the route then
 * asks who the caller is and answers 403 to anyone who is neither the
 * person nor a super admin, whether or not the profile exists, so the
 * answer tells them nothing about it.
 *
 * Uses the user-bound server client (never the service-role client).
 *
 * Described as `org.update-profile`: the body is UpdateProfileBody
 * (src/lib/organization-directory/schemas.ts), refused with this route's own
 * answers (UPDATE_PROFILE_REFUSALS).
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

  const parsed = await parseJsonBody(request, UpdateProfileBody, { refusals: UPDATE_PROFILE_REFUSALS });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = await createClient();

  // Build PATCH payload from present keys only. The schema has refused any
  // value that is neither text nor null.
  const updates: Record<string, string | null> = {};
  for (const field of ["first_name", "last_name", "phone"] as const) {
    if (field in body) {
      const v = body[field];
      const trimmed = typeof v === "string" ? v.trim() : "";
      updates[field] = trimmed === "" ? null : trimmed;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No updatable fields in request body." },
      { status: 422 }
    );
  }

  const { data, error } = await supabase
    .from("user_profiles")
    .update(updates)
    .eq("user_id", id)
    .select("*");

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this profile." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update profile: ${error.message}` },
      { status: 500 }
    );
  }

  // 0 rows: the UPDATE policy filtered the row out (the caller may not edit
  // it), or there is no profile row. Tell the two apart by the caller, as
  // the policy does (self, or a super admin), never by reading the profile.
  //
  // Migration 00017 adds a backfill + AFTER INSERT trigger that guarantees a
  // user_profiles row exists for every auth.users row. For a caller the
  // policy lets through, reaching this branch indicates a genuine data
  // integrity problem (trigger failure, manual deletion, etc.) — return a
  // generic 500 rather than a misleading re-invite message.
  if (!data || data.length === 0) {
    const { user, roles } = await getCurrentUserAccess(supabase);
    const mayEdit = !!user && (user.id.toLowerCase() === id.toLowerCase() || rolesIncludeSuperAdmin(roles));
    if (!mayEdit) {
      return NextResponse.json(
        { error: "Not authorized to update this profile." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: "Internal error. Please contact an administrator." },
      { status: 500 }
    );
  }

  return NextResponse.json({ profile: data[0] }, { status: 200 });
}
