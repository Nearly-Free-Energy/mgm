import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/** Resolve the owning organization for a line item (RLS-aware). */
export async function resolveOrgForLineItem(
  supabase: SupabaseClient,
  lineItemId: string
): Promise<{ orgId: string; communityId: string; microgridId: string } | null> {
  const { data: item } = await supabase
    .from("billing_line_items")
    .select("id, billing_period_id")
    .eq("id", lineItemId)
    .maybeSingle<{ id: string; billing_period_id: string }>();
  if (!item) return null;
  const { data: period } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id")
    .eq("id", item.billing_period_id)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!period) return null;
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, community_id")
    .eq("id", period.microgrid_id)
    .maybeSingle<{ id: string; community_id: string }>();
  if (!microgrid) return null;
  const { data: community } = await supabase
    .from("communities")
    .select("id, org_id")
    .eq("id", microgrid.community_id)
    .maybeSingle<{ id: string; org_id: string }>();
  if (!community) return null;
  return {
    orgId: community.org_id,
    communityId: microgrid.community_id,
    microgridId: period.microgrid_id,
  };
}
