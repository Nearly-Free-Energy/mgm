/**
 * The platform plugin that registers the fixture provider as the `synthetic`
 * metering source (docs/cordis-runtime.md), only while MGM_METERING_FIXTURES
 * is on. It serves microgrids whose edges all carry reserved
 * `SYNTHETIC-EDGE-` ids; every other microgrid keeps its own provider.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { meteringFixturesEnabled } from "@/lib/config/metering-fixtures";
import "@/lib/runtime/services";
import { MeteringError } from "../errors";
import { FixtureMeteringProvider, isSyntheticEdgeId } from "../fixture-provider";
import { generateSiteSamples } from "./site-samples";

export { SYNTHETIC_EDGE_ID_PREFIX } from "../fixture-provider";

export const SYNTHETIC_PROVIDER_NAME = "synthetic";

/**
 * Whether the synthetic provider serves this microgrid, read through the
 * caller's RLS client: true when every edge is synthetic, false when none is
 * (or there are none). Synthetic and real edges in one microgrid are refused
 * (409), so generated figures never sit beside real ones.
 */
export async function syntheticSupports(
  supabase: SupabaseClient,
  microgridId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("edges")
    .select("openems_edge_id")
    .eq("microgrid_id", microgridId);
  if (error) {
    throw new MeteringError(
      "This microgrid's edges could not be read. Try again shortly.",
      "METERING_UNAVAILABLE",
      503,
      { microgridId }
    );
  }
  const ids = ((data ?? []) as { openems_edge_id: string }[]).map((row) => row.openems_edge_id);
  const synthetic = ids.filter(isSyntheticEdgeId).length;
  if (synthetic === 0) return false;
  if (synthetic === ids.length) return true;
  throw new MeteringError(
    "This microgrid mixes synthetic and real edges; keep synthetic data in its own microgrid.",
    "METERING_CONFIGURATION",
    409,
    { microgridId }
  );
}

export const FixtureMeteringPlugin = {
  name: "fixture-metering",
  inject: ["meteringProviders"],
  apply(ctx: Context) {
    // Read once, when the root loads its platform plugins.
    if (!meteringFixturesEnabled()) return;
    // Registration is undone when this fiber unloads.
    ctx.effect(() =>
      ctx.meteringProviders.register(
        SYNTHETIC_PROVIDER_NAME,
        () => new FixtureMeteringProvider([], { siteSamples: (request) => generateSiteSamples(request) }),
        { supports: syntheticSupports }
      )
    );
  },
} satisfies Plugin.Object<void>;
