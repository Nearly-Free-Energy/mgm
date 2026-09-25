import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeMetering,
  type MeteringResult,
} from "@/lib/metering/compose";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapError(error: Extract<MeteringResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json(body, { status });
}

/**
 * GET /api/households/[id]/assignments — effective-dated meter assignment
 * history with gaps.
 *
 * Released metering reads route through the metering Cordis capability.
 * Reads stay available while the metering plugin is disabled — only the
 * organization scope applies. Gaps between consecutive links (and links
 * with missing replacement-boundary evidence) are returned explicitly
 * rather than papered over.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid household ID — expected UUID" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { data: household } = await supabase
    .from("households")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!household) {
    return NextResponse.json(
      { error: "Household not found" },
      { status: 404 }
    );
  }

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", household.microgrid_id)
    .maybeSingle<{ id: string; communities: { org_id: string } }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Household not found" },
      { status: 404 }
    );
  }

  const composed = await composeMetering({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result =
      await composed.data.metering.getAssignmentHistory(id);
    if (!result.ok) return mapError(result);
    return NextResponse.json(result.data, { status: 200 });
  } finally {
    await composed.data.dispose();
  }
}
