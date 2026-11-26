import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  composeCommunityManagement,
  type CommunityManagementError,
} from "@/lib/community-management";
import {
  CREATE_MICROGRID_REFUSALS,
  CreateMicrogridBody,
} from "@/lib/community-management/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

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

/**
 * POST /api/microgrids — create a new microgrid under a parent community
 * (#76), as `community.create-microgrid`.
 *
 * Released mutations route through the community-management Cordis
 * capability. The route resolves the parent organization needed for the
 * request-scoped composition; the capability re-validates scope, plugin
 * state, and organization access before writing.
 *
 * Validation: the body is CreateMicrogridBody
 * (src/lib/community-management/schemas.ts), refused with this route's own
 * answers (CREATE_MICROGRID_REFUSALS) before anything is read:
 *   - `name` required (422 with field='name').
 *   - `community_id` required UUID (400 malformed; 403 if not accessible).
 *   - `currency` required + validated via Intl.NumberFormat RangeError (422).
 *
 * Duplicate-name handling: Postgres UNIQUE constraint
 * `microgrids_community_name_unique` (00008 migration) surfaces as 23505.
 * We translate that into 409 with exact copy:
 *   "A microgrid named '{name}' already exists in this community."
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJsonBody(request, CreateMicrogridBody, { refusals: CREATE_MICROGRID_REFUSALS });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const communityId = body.community_id;

  const supabase = await createClient();
  const { data: parent } = await supabase
    .from("communities")
    .select("org_id")
    .eq("id", communityId)
    .maybeSingle<{ org_id: string }>();
  if (!parent) {
    return NextResponse.json(
      { error: "Not authorized to add microgrids to this community." },
      { status: 403 }
    );
  }

  const composed = await composeCommunityManagement({
    supabase,
    organizationId: parent.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result =
      await composed.data.communityManagement.createMicrogrid(body);
    if (!result.ok) return mapError(result);

    revalidatePath("/microgrids", "layout");
    revalidatePath(`/communities/${communityId}`, "layout");

    return NextResponse.json({ microgrid: result.data }, { status: 201 });
  } finally {
    await composed.data.dispose();
  }
}

