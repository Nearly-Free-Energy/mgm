import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { CreateRateScheduleBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import type { TierConfig } from "@/lib/types/domain";

/**
 * POST /api/rate-schedules
 *
 * Creates a new rate schedule for a microgrid.
 *
 * Request body:
 * {
 *   microgrid_id: string;    // UUID
 *   tiers: TierConfig[];     // at least one tier, contiguous
 *   service_charge: number;  // >= 0
 *   tax_rate: number;        // [0, 1]
 * }
 *
 * Parsed with `CreateRateScheduleBody` (`@/lib/billing/schemas`); unknown
 * top-level keys are refused, and each tier is stored as sent. The body is
 * checked before the plugin gate, so a malformed body answers 400 whatever
 * the caller's access.
 *
 * RLS: rate_schedules FOR ALL policy (00002_rls.sql:161) enforces microgrid access
 * via user_can_access_microgrid(). No additional handler-side check needed.
 *
 * Returns the inserted RateSchedule row on success (200).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJsonBody(request, CreateRateScheduleBody);
  if (!parsed.ok) return parsed.response;
  const { microgrid_id, service_charge, tax_rate } = parsed.data;
  // CreateRateScheduleBody has checked each tier's numbers and contiguity.
  const tiers = parsed.data.tiers as TierConfig[];

  const supabase = await createClient();

  // Release 3 (issue #5): tariff writes fail closed while billing is disabled.
  const gate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "microgrid", id: microgrid_id },
    method: "POST",
  });
  if (gate) return gate;

  const { data, error } = await supabase
    .from("rate_schedules")
    .insert({
      microgrid_id,
      tiers,
      service_charge,
      tax_rate,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to create a rate schedule for this microgrid" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to create rate schedule: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(data, { status: 200 });
}
