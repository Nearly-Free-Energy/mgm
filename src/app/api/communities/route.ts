import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";
import {
  CREATE_COMMUNITY_REFUSALS,
  CreateCommunityBody,
} from "@/lib/community-management/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * POST /api/communities — create a new community under a parent org (#76),
 * as `community.create-community`.
 *
 * Released mutations route through the community-management Cordis
 * capability: the route parses the HTTP body, composes one authenticated,
 * organization-scoped context, invokes the typed capability, then disposes
 * the composition. Authorization remains defense-in-depth; RLS is the
 * backstop.
 *
 * Validation: the body is CreateCommunityBody
 * (src/lib/community-management/schemas.ts), refused with this route's own
 * answers (CREATE_COMMUNITY_REFUSALS) before anything is read:
 *   - `name` (required, 422 with field='name').
 *   - `org_id` (required UUID, 400 on malformed; 403 if not accessible).
 *   - Address fields are all optional at the DB layer; UI may require city
 *     but we do not enforce that at the server for communities (Org is the
 *     stricter invariant — see POST /api/organizations).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJsonBody(request, CreateCommunityBody, { refusals: CREATE_COMMUNITY_REFUSALS });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = await createClient();
  const composed = await composeCommunityManagement({
    supabase,
    organizationId: body.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result =
      await composed.data.communityManagement.createCommunity(body);
    if (!result.ok) return mapError(result);

    revalidatePath("/communities", "layout");
    revalidatePath("/microgrids", "layout");
    revalidatePath(`/organizations/${result.data.org_id}`, "layout");

    return NextResponse.json({ community: result.data }, { status: 201 });
  } finally {
    await composed.data.dispose();
  }
}

function mapError(error: CommunityManagementError): NextResponse {
  const { ok, status, code, message, field, reason } = error;
  void ok;
  return NextResponse.json(
    {
      error: message,
      code,
      ...(field !== undefined ? { field } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
    { status }
  );
}
