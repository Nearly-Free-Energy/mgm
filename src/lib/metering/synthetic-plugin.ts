/**
 * Platform plugin that registers the synthetic metering source into the root
 * `meteringProviders` registry (docs/cordis-runtime.md, ADR-005). Same shape
 * as `OpenEmsMeteringPlugin`; billing and the routes do not change.
 *
 * Selection is explicit on two counts, both read through the caller's
 * RLS-scoped client:
 *  1. the microgrid holds a synthetic demonstration edge (SYNTHETIC-EDGE-*),
 *  2. the `synthetic-metering` plugin is enabled for that microgrid's
 *     organization (off unless an organization enables it).
 * A synthetic microgrid in an organization where the plugin is off fails
 * closed; it never falls back to another provider.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import "@/lib/runtime/services";
import { SYNTHETIC_METERING_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { MeteringError } from "./errors";
import { createSyntheticMeteringProvider, SYNTHETIC_PROVIDER_NAME } from "./synthetic-provider";
import { SYNTHETIC_EDGE_ID_PREFIX } from "./synthetic/dataset";

type Embedded<T> = T | T[] | null | undefined;
const one = <T,>(value: Embedded<T>): T | null =>
  Array.isArray(value) ? value[0] ?? null : value ?? null;

type EdgeRow = {
  microgrids: Embedded<{ communities: Embedded<{ org_id: string }> }>;
};

export async function syntheticSupports(
  supabase: SupabaseClient,
  microgridId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("edges")
    .select("id, microgrids!inner(communities!inner(org_id))")
    .eq("microgrid_id", microgridId)
    .like("openems_edge_id", `${SYNTHETIC_EDGE_ID_PREFIX}%`)
    .limit(1);
  if (error) {
    throw new MeteringError("Could not read metering configuration", "METERING_UNAVAILABLE", 503);
  }
  const edge = (data as unknown as EdgeRow[] | null)?.[0];
  if (!edge) return false;

  const orgId = one(one(edge.microgrids)?.communities)?.org_id;
  if (!orgId) return false;
  const { data: enabled, error: stateError } = await supabase.rpc(
    "mgm_plugin_enabled_for_org",
    { _org_id: orgId, _plugin_name: SYNTHETIC_METERING_PLUGIN_NAME }
  );
  if (stateError) {
    throw new MeteringError("Could not read plugin state", "METERING_UNAVAILABLE", 503);
  }
  if (enabled !== true) {
    throw new MeteringError(
      "Synthetic metering is disabled for this organization. Enable it in Settings → Plugins; stored data is preserved.",
      "METERING_CONFIGURATION",
      409,
      { microgridId }
    );
  }
  return true;
}

export const SyntheticMeteringPlugin = {
  name: "synthetic-metering",
  inject: ["meteringProviders"],
  apply(ctx: Context) {
    // Registration is undone when this fiber unloads.
    ctx.effect(() =>
      ctx.meteringProviders.register(
        SYNTHETIC_PROVIDER_NAME,
        () => createSyntheticMeteringProvider(process.env.MGM_SYNTHETIC_METERING_SEED),
        { supports: syntheticSupports }
      )
    );
  },
} satisfies Plugin.Object<void>;
