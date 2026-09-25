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
 * POST /api/meter-readings/opening — record an explicit opening register.
 *
 * Released metering mutations route through the metering Cordis capability.
 * The operator supplies the meter's register for its first billable period;
 * the server validates the value, timestamp, device scope, and duplicate
 * evidence before writing. Imports and live reads never invent this row —
 * without it, the billing engine reports the household as needing a seed
 * reading rather than billing zero.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const deviceId = typeof body.device_id === "string" ? body.device_id : "";
  const supabase = await createClient();
  const { data: device } = await supabase
    .from("devices")
    .select("id, edges!inner(microgrid_id)")
    .eq("id", deviceId)
    .maybeSingle<{ id: string; edges: { microgrid_id: string } }>();
  if (!device) {
    return NextResponse.json(
      { error: "Meter not found." },
      { status: 404 }
    );
  }

  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", device.edges.microgrid_id)
    .maybeSingle<{ id: string; communities: { org_id: string } }>();
  if (!microgrid) {
    return NextResponse.json(
      { error: "Meter not found." },
      { status: 404 }
    );
  }

  const composed = await composeMetering({
    supabase,
    organizationId: microgrid.communities.org_id,
  });
  if (!composed.ok) return mapError(composed);

  try {
    const result = await composed.data.metering.recordOpeningRegister({
      deviceId,
      readingKwh: body.reading_kwh,
      readAt: body.read_at,
    });
    if (!result.ok) return mapError(result);
    return NextResponse.json({ reading: result.data }, { status: 201 });
  } finally {
    await composed.data.dispose();
  }
}
