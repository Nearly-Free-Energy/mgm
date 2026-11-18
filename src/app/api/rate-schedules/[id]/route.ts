import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { ReviseRateScheduleBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import type { TierConfig } from "@/lib/types/domain";

/**
 * PUT /api/rate-schedules/[id]
 *
 * Creates a new tariff version from an existing schedule. Existing versions
 * remain unchanged for periods that have already selected them.
 *
 * Request body:
 * {
 *   tiers: TierConfig[];     // at least one tier, contiguous
 *   service_charge: number;  // >= 0
 *   tax_rate: number;        // [0, 1]
 * }
 *
 * Parsed with `ReviseRateScheduleBody` (`@/lib/billing/schemas`); unknown
 * top-level keys, a microgrid_id among them, are refused. The microgrid is the
 * existing schedule's. The body is checked before the plugin gate and the
 * lookup, so a malformed body answers 400 whatever the caller's access.
 *
 * RLS: rate_schedules FOR ALL policy (00002_rls.sql:161) enforces microgrid access
 * via user_can_access_microgrid(). No additional handler-side check needed.
 *
 * Returns the new RateSchedule row on success (200).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  const parsed = await parseJsonBody(request, ReviseRateScheduleBody);
  if (!parsed.ok) return parsed.response;
  const { service_charge, tax_rate } = parsed.data;
  // ReviseRateScheduleBody has checked each tier's numbers and contiguity.
  const tiers = parsed.data.tiers as TierConfig[];

  const supabase = await createClient();

  // Release 3 (issue #5): tariff writes fail closed while billing is disabled.
  const gate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "rateSchedule", id },
    method: "PUT",
  });
  if (gate) return gate;

  const { data: existing, error: lookupError } = await supabase
    .from("rate_schedules")
    .select("id, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; microgrid_id: string }>();

  if (lookupError) {
    return NextResponse.json({ error: "Could not load rate schedule" }, { status: 503 });
  }
  if (!existing) {
    return NextResponse.json({ error: "Rate schedule not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("rate_schedules")
    .insert({
      microgrid_id: existing.microgrid_id,
      tiers,
      service_charge,
      tax_rate,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to create a new rate schedule version" },
        { status: 403 }
      );
    }
    if (error.code === "PGRST116") {
      // PostgREST: no rows returned by .single()
      return NextResponse.json(
        { error: "Rate schedule not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update rate schedule: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(data, { status: 200 });
}
