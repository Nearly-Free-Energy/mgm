import { describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MeteringProviderFactories } from "@/lib/runtime/services";
import { MeteringProvidersPlugin } from "@/lib/runtime/root";
import { SyntheticMeteringPlugin, syntheticSupports } from "../synthetic-plugin";
import { DEMO_PERIOD, SYNTHETIC_EDGE_ID, SYNTHETIC_METERS } from "../synthetic/dataset";

vi.mock("@/lib/metering/openems-provider", () => ({
  createOpenEmsMeteringProvider: () => ({ getReadings: async () => [] }),
}));

const ORG_A = "550e8400-e29b-41d4-a716-44665544000a";
const ORG_B = "550e8400-e29b-41d4-a716-44665544000b";

/**
 * A caller-scoped Supabase stub. `edges` maps microgrid id -> owning org for
 * microgrids holding a synthetic edge the CALLER can see (RLS); `enabled`
 * maps org id -> plugin state for the synthetic plugin.
 */
function client(opts: {
  edges: Record<string, string>;
  enabled: Record<string, boolean>;
  rpcError?: boolean;
  queryError?: boolean;
}) {
  const rpc = vi.fn(async (_fn: string, args: { _org_id: string; _plugin_name: string }) =>
    opts.rpcError
      ? { data: null, error: { message: "boom" } }
      : { data: opts.enabled[args._org_id] ?? false, error: null }
  );
  const from = vi.fn((_table: string) => {
    let microgridId = "";
    const builder = {
      select: () => builder,
      eq: (_col: string, value: string) => ((microgridId = value), builder),
      like: () => builder,
      limit: async () => {
        if (opts.queryError) return { data: null, error: { message: "boom" } };
        const org = opts.edges[microgridId];
        return {
          data: org ? [{ id: "e", microgrids: { communities: { org_id: org } } }] : [],
          error: null,
        };
      },
    };
    return builder;
  });
  return { supabase: { from, rpc } as unknown as SupabaseClient, rpc, from };
}

describe("synthetic metering plugin gate", () => {
  it("does not apply to microgrids without a synthetic edge (and checks no plugin state)", async () => {
    const { supabase, rpc } = client({ edges: {}, enabled: { [ORG_A]: true } });
    await expect(syntheticSupports(supabase, "real-microgrid")).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("applies when the owning organization enabled the plugin", async () => {
    const { supabase, rpc } = client({ edges: { mg: ORG_A }, enabled: { [ORG_A]: true } });
    await expect(syntheticSupports(supabase, "mg")).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("mgm_plugin_enabled_for_org", {
      _org_id: ORG_A,
      _plugin_name: "synthetic-metering",
    });
  });

  it("is off by default: a missing/false state fails closed with 409, no fallback", async () => {
    const { supabase } = client({ edges: { mg: ORG_A }, enabled: {} });
    await expect(syntheticSupports(supabase, "mg")).rejects.toMatchObject({
      code: "METERING_CONFIGURATION",
      statusCode: 409,
    });
  });

  it("isolates organizations: org B enabling it does not enable org A", async () => {
    const { supabase } = client({
      edges: { mgA: ORG_A, mgB: ORG_B },
      enabled: { [ORG_B]: true },
    });
    await expect(syntheticSupports(supabase, "mgB")).resolves.toBe(true);
    await expect(syntheticSupports(supabase, "mgA")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a microgrid the caller cannot see (RLS) is simply not synthetic for them", async () => {
    const { supabase } = client({ edges: {}, enabled: { [ORG_A]: true } });
    await expect(syntheticSupports(supabase, "someone-elses")).resolves.toBe(false);
  });

  it("re-reads state each call, so disable/enable takes effect immediately", async () => {
    const enabled: Record<string, boolean> = { [ORG_A]: true };
    const { supabase } = client({ edges: { mg: ORG_A }, enabled });
    await expect(syntheticSupports(supabase, "mg")).resolves.toBe(true);
    enabled[ORG_A] = false;
    await expect(syntheticSupports(supabase, "mg")).rejects.toMatchObject({ statusCode: 409 });
    enabled[ORG_A] = true;
    await expect(syntheticSupports(supabase, "mg")).resolves.toBe(true);
  });

  it("fails closed when configuration or plugin state cannot be read", async () => {
    await expect(
      syntheticSupports(client({ edges: {}, enabled: {}, queryError: true }).supabase, "mg")
    ).rejects.toMatchObject({ code: "METERING_UNAVAILABLE", statusCode: 503 });
    await expect(
      syntheticSupports(client({ edges: { mg: ORG_A }, enabled: {}, rpcError: true }).supabase, "mg")
    ).rejects.toMatchObject({ code: "METERING_UNAVAILABLE", statusCode: 503 });
  });
});

async function runtime() {
  const root = new Context();
  await root.plugin(MeteringProvidersPlugin);
  const openems = vi.fn(() => ({ getReadings: async () => [] }));
  const registry = root.get("meteringProviders") as MeteringProviderFactories;
  registry.register("openems", openems, { fallback: true });
  const fiber = root.plugin(SyntheticMeteringPlugin);
  await fiber;
  return { root, registry, fiber, openems };
}

const devices = SYNTHETIC_METERS.map((m, i) => ({
  id: `d${i}`,
  edgeOpenemsId: SYNTHETIC_EDGE_ID,
  componentId: m.componentId,
}));

describe("synthetic metering through the provider registry", () => {
  it("registers beside OpenEMS and is selected for an enabled synthetic microgrid", async () => {
    const { registry, openems } = await runtime();
    expect(registry.names()).toEqual(["openems", "synthetic"]);
    const { supabase } = client({ edges: { mg: ORG_A }, enabled: { [ORG_A]: true } });
    const readings = await registry
      .forRequest(supabase)
      .getReadings({ microgridId: "mg", devices, ...DEMO_PERIOD });
    expect(readings).toHaveLength(devices.length);
    expect(openems).not.toHaveBeenCalled();
  });

  it("leaves ordinary microgrids on the OpenEMS fallback", async () => {
    const { registry, openems } = await runtime();
    const { supabase } = client({ edges: {}, enabled: {} });
    await registry
      .forRequest(supabase)
      .getReadings({ microgridId: "real", devices: [], ...DEMO_PERIOD });
    expect(openems).toHaveBeenCalledTimes(1);
  });

  it("a disabled synthetic microgrid never falls back to OpenEMS", async () => {
    const { registry, openems } = await runtime();
    const { supabase } = client({ edges: { mg: ORG_A }, enabled: {} });
    await expect(
      registry.forRequest(supabase).getReadings({ microgridId: "mg", devices, ...DEMO_PERIOD })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(openems).not.toHaveBeenCalled();
  });

  it("unregisters when the plugin unloads", async () => {
    const { registry, fiber } = await runtime();
    await fiber.dispose();
    expect(registry.names()).toEqual(["openems"]);
  });
});
