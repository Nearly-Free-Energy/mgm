import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { validateGridTariffBands } from "@/lib/billing/site-savings";
import { isCalendarDateKey } from "@/lib/timezone/day-key";
import type { GridTariff } from "@/lib/types/domain";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/microgrids/[id]/grid-tariffs
 *
 * Adds a version of what the microgrid pays the grid utility per kWh, by
 * local hour. The version applies from `effective_from` until the next one.
 *
 * Request body:
 * {
 *   effective_from: string;  // YYYY-MM-DD, a day that exists
 *   bands: { from_hour: number; to_hour: number; rate: number }[];
 * }
 *
 * The database checks only that `bands` is an array of 1 to 24 entries; the
 * full 0–24 coverage is validated here by `validateGridTariffBands`, so every
 * write path must call it.
 *
 * Access: the user's own RLS client only. The `grid_tariffs` FOR ALL policy
 * chains through `user_can_access_microgrid`, so the insert succeeds only for
 * a microgrid the caller may manage.
 *
 * 201 with the row; 400 bad input; 401 no session; 404 microgrid not
 * visible; 409 a version already starts that day (or billing is disabled).
 */
export async function POST(
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
  const { effective_from, bands } = body as Record<string, unknown>;

  if (typeof effective_from !== "string" || !isCalendarDateKey(effective_from)) {
    return NextResponse.json(
      { error: "effective_from must be a date (YYYY-MM-DD)", field: "effective_from" },
      { status: 400 }
    );
  }
  const validated = validateGridTariffBands(bands);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.message, field: "bands" }, { status: 400 });
  }

  const gate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "microgrid", id: microgridId },
    method: "POST",
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
    .from("grid_tariffs")
    .insert({
      microgrid_id: microgridId,
      effective_from,
      bands: validated.bands,
    })
    .select("*")
    .single<GridTariff>();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        {
          error: `A grid tariff already starts on ${effective_from}. Delete it first or pick another date.`,
          field: "effective_from",
        },
        { status: 409 }
      );
    }
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to add a grid tariff for this microgrid" },
        { status: 403 }
      );
    }
    if (error.code === "23514") {
      return NextResponse.json({ error: "Invalid grid tariff bands", field: "bands" }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to save grid tariff" }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
