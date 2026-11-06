import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { isCalendarDateKey } from "@/lib/timezone/day-key";
import type { MicrogridSavingsSettings } from "@/lib/types/domain";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SettingsBody = {
  solar_savings_from: string | null;
  arbitrage_from: string | null;
  round_trip_efficiency: number;
};

type Invalid = { error: string; field: keyof SettingsBody };

/**
 * Reads the full settings from a request body. All three keys are required
 * (PUT replaces the row); a start date may be null, which means that saving
 * is not counted. The efficiency is rounded to the column's three decimals
 * (`numeric(4,3)`) before the (0, 1] check, so a value the database would
 * round to 0 is refused here rather than by its CHECK.
 */
function parseSettings(body: Record<string, unknown>): SettingsBody | Invalid {
  for (const field of ["solar_savings_from", "arbitrage_from"] as const) {
    const value = body[field];
    if (value === null) continue;
    if (typeof value !== "string" || !isCalendarDateKey(value)) {
      return { error: `${field} must be a date (YYYY-MM-DD) or null`, field };
    }
  }
  const efficiency = body.round_trip_efficiency;
  const rounded =
    typeof efficiency === "number" && Number.isFinite(efficiency)
      ? Math.round(efficiency * 1000) / 1000
      : NaN;
  if (!(rounded > 0 && rounded <= 1)) {
    return {
      error: "round_trip_efficiency must be a number greater than 0 and at most 1",
      field: "round_trip_efficiency",
    };
  }
  return {
    solar_savings_from: body.solar_savings_from as string | null,
    arbitrage_from: body.arbitrage_from as string | null,
    round_trip_efficiency: rounded,
  };
}

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }
  const settings = parseSettings(body as Record<string, unknown>);
  if ("error" in settings) {
    return NextResponse.json(settings, { status: 400 });
  }

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
