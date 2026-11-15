import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { AddGridTariffBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
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
 * Parsed with `AddGridTariffBody` (`@/lib/billing/schemas`); unknown keys,
 * at the top level or in a band, are refused.
 *
 * The database checks only that `bands` has 1 to 24 entries;
 * `AddGridTariffBody` checks 0-24 coverage, so anything else that writes
 * `grid_tariffs` must parse with it too.
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

  const parsed = await parseJsonBody(request, AddGridTariffBody);
  if (!parsed.ok) return parsed.response;
  const { effective_from } = parsed.data;
  // AddGridTariffBody has checked 0-24 coverage; store the bands in hour order.
  const bands = [...parsed.data.bands].sort((a, b) => a.from_hour - b.from_hour);

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
      bands,
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
