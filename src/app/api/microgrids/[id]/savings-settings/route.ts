import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { SaveSavingsSettingsBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import type { MicrogridSavingsSettings } from "@/lib/types/domain";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PUT /api/microgrids/[id]/savings-settings
 *
 * Creates or replaces the microgrid's savings settings: from which day solar
 * savings and battery arbitrage are counted, and the battery's round-trip
 * efficiency.
 *
 * Request body:
 * {
 *   solar_savings_from: string | null;  // YYYY-MM-DD; null = not counted
 *   arbitrage_from: string | null;      // YYYY-MM-DD; null = not counted
 *   round_trip_efficiency: number;      // (0, 1]
 * }
 *
 * Parsed with `SaveSavingsSettingsBody` (`@/lib/billing/schemas`): all three
 * keys are required and unknown keys are refused.
 *
 * `updated_at` is set here because the table has no update trigger.
 *
 * Access: the user's own RLS client only. The `microgrid_savings_settings`
 * FOR ALL policy chains through `user_can_access_microgrid`, covering both
 * the insert and the update half of the upsert.
 *
 * 200 with the row; 400 bad input; 401 no session; 404 microgrid not visible.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: microgridId } = await params;
  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json({ error: "Invalid microgrid id — expected UUID." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = await parseJsonBody(request, SaveSavingsSettingsBody);
  if (!parsed.ok) return parsed.response;
  // Built field by field, so the write targets the gated microgrid whatever
  // the schema does with unknown keys.
  const settings = {
    solar_savings_from: parsed.data.solar_savings_from,
    arbitrage_from: parsed.data.arbitrage_from,
    // Store what numeric(4,3) keeps; the schema refused values that round to 0.
    round_trip_efficiency: Math.round(parsed.data.round_trip_efficiency * 1000) / 1000,
  };

  const gate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "microgrid", id: microgridId },
    method: "PUT",
    access: "write",
  });
  if (gate) return gate;

  const { data: microgrid, error: lookupError } = await supabase
    .from("microgrids")
    .select("id")
    .eq("id", microgridId)
    .maybeSingle<{ id: string }>();
  if (lookupError) {
    return NextResponse.json({ error: "Could not load microgrid" }, { status: 503 });
  }
  if (!microgrid) {
    return NextResponse.json({ error: "Microgrid not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("microgrid_savings_settings")
    .upsert(
      {
        microgrid_id: microgridId,
        ...settings,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "microgrid_id" }
    )
    .select("*")
    .single<MicrogridSavingsSettings>();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to change savings settings for this microgrid" },
        { status: 403 }
      );
    }
    if (error.code === "23514") {
      return NextResponse.json(
        { error: "round_trip_efficiency is out of range", field: "round_trip_efficiency" },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Failed to save savings settings" }, { status: 500 });
  }

  return NextResponse.json(data, { status: 200 });
}
