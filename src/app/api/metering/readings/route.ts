import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeMetering,
  type MeteringResult,
} from "@/lib/metering/compose";

function mapError(error: Extract<MeteringResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/metering/readings — per-meter consumption for a date range.
 *
 * Released metering reads route through the metering Cordis capability.
 * The provider is always OpenEMS on this route — callers cannot switch
 * providers (the fixture provider stays available to capability-level
 * consumers such as tests). Each row carries its source and read
 * timestamp; unavailable registers stay null, never zero-filled.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const microgridId =
    typeof body.microgrid_id === "string" ? body.microgrid_id : "";
  const supabase = await createClient();
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", microgridId)
    .maybeSingle<{ id: string; communities: { org_id: string } }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Microgrid not found." },
      { status: 404 }
    );
  }

  const composed = await composeMetering({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.metering.getConsumption({
      microgrid_id: microgridId,
      device_ids: body.device_ids,
      household_ids: body.household_ids,
      start_date: body.start_date,
      end_date: body.end_date,
      timezone: body.timezone,
      provider: "openems",
    });
    if (!result.ok) return mapError(result);
    return NextResponse.json({ readings: result.data }, { status: 200 });
  } finally {
    await composed.data.dispose();
  }
}
