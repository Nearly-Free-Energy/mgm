/**
 * guard.ts — fail-closed billing write gates for API routes (issue #5).
 *
 * Reads stay available while the billing plugin is disabled (operators can
 * still inspect tariffs, bills, PDFs, and CSV exports). Every WRITE route
 * resolves the target organization and returns 409 `billing_disabled` when
 * the plugin is off — mirroring the metering capability's own gate, but for
 * the pre-Cordis MBE routes whose internals Release 3 does not rewrite.
 *
 * New MGM routes (period create/close) go through `composeBilling` instead
 * and never touch this module.
 *
 * Test-mock note: mocked Supabase clients in route unit tests typically stub
 * only `from`/`auth`. If organization resolution throws (e.g. an unstubbed
 * chain), the guard returns `null` and the route's own 404/403 logic runs —
 * so existing tests keep their semantics. In production the client is real
 * and a disabled plugin always yields 409.
 */
import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isBillingEnabled } from "@/lib/plugins/state";

export function billingDisabledResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.",
      code: "billing_disabled",
    },
    { status: 409 }
  );
}

async function isEnabled(supabase: SupabaseClient, orgId: string): Promise<boolean | null> {
  try {
    return await isBillingEnabled(supabase, orgId);
  } catch {
    // Unstubbed/throwing client (unit-test mocks) — let the route decide.
    return null;
  }
}

type OrgJoin = { communities: { org_id: string } | { org_id: string }[] | null } | null;

/**
 * Gate for microgrid-scoped writes (tariffs, generation, invoice config).
 * Returns a 409 response when billing is disabled, else `null`.
 * Returns `null` when the organization cannot be resolved — the route's own
 * 404/403 handling then applies.
 */
export async function billingWriteGateForMicrogrid(
  supabase: SupabaseClient,
  microgridId: string
): Promise<NextResponse | null> {
  let orgId: string | null = null;
  try {
    const { data } = await supabase
      .from("microgrids")
      .select("id, communities!inner(org_id)")
      .eq("id", microgridId)
      .maybeSingle<OrgJoin & { id: string }>();
    const communities = data?.communities;
    orgId = Array.isArray(communities) ? communities[0]?.org_id ?? null : communities?.org_id ?? null;
  } catch {
    return null;
  }
  if (!orgId) return null;
  const enabled = await isEnabled(supabase, orgId);
  if (enabled === false) return billingDisabledResponse();
  return null;
}

/**
 * Gate for billing-period-scoped writes (generate, preview, close).
 */
export async function billingWriteGateForPeriod(
  supabase: SupabaseClient,
  periodId: string
): Promise<NextResponse | null> {
  let microgridId: string | null = null;
  try {
    const { data } = await supabase
      .from("billing_periods")
      .select("id, microgrid_id")
      .eq("id", periodId)
      .maybeSingle<{ id: string; microgrid_id: string }>();
    microgridId = data?.microgrid_id ?? null;
  } catch {
    return null;
  }
  if (!microgridId) return null;
  return billingWriteGateForMicrogrid(supabase, microgridId);
}

/**
 * Gate for line-item-scoped writes (manual payments, usage corrections).
 */
export async function billingWriteGateForLineItem(
  supabase: SupabaseClient,
  lineItemId: string
): Promise<NextResponse | null> {
  let periodId: string | null = null;
  try {
    const { data } = await supabase
      .from("billing_line_items")
      .select("id, billing_period_id")
      .eq("id", lineItemId)
      .maybeSingle<{ id: string; billing_period_id: string }>();
    periodId = data?.billing_period_id ?? null;
  } catch {
    return null;
  }
  if (!periodId) return null;
  return billingWriteGateForPeriod(supabase, periodId);
}

/**
 * Gate for tariff-schedule-scoped writes (rate schedule updates).
 */
export async function billingWriteGateForRateSchedule(
  supabase: SupabaseClient,
  scheduleId: string
): Promise<NextResponse | null> {
  let microgridId: string | null = null;
  try {
    const { data } = await supabase
      .from("rate_schedules")
      .select("id, microgrid_id")
      .eq("id", scheduleId)
      .maybeSingle<{ id: string; microgrid_id: string }>();
    microgridId = data?.microgrid_id ?? null;
  } catch {
    return null;
  }
  if (!microgridId) return null;
  return billingWriteGateForMicrogrid(supabase, microgridId);
}

/**
 * Gate for community-scoped writes (invoice branding).
 */
export async function billingWriteGateForCommunity(
  supabase: SupabaseClient,
  communityId: string
): Promise<NextResponse | null> {
  let orgId: string | null = null;
  try {
    const { data } = await supabase
      .from("communities")
      .select("id, org_id")
      .eq("id", communityId)
      .maybeSingle<{ id: string; org_id: string }>();
    orgId = data?.org_id ?? null;
  } catch {
    return null;
  }
  if (!orgId) return null;
  const enabled = await isEnabled(supabase, orgId);
  if (enabled === false) return billingDisabledResponse();
  return null;
}
