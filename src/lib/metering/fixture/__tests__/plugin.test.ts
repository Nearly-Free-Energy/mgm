import { afterEach, describe, expect, it, vi } from "vitest";
import { Context, type Fiber } from "cordis";
import { loadPlatformPlugins, MeteringProvidersPlugin } from "@/lib/runtime/root";
import { OpenEmsMeteringPlugin } from "../../providers-plugin";
import type { MeteringProviderFactories } from "@/lib/runtime/services";
import { MeteringError } from "../../errors";
import type { SiteSamplesRequest } from "../../types";
import { generateSiteSamples } from "../site-samples";
import {
  FixtureMeteringPlugin,
  SYNTHETIC_EDGE_ID_PREFIX,
  SYNTHETIC_PROVIDER_NAME,
  syntheticSupports,
} from "../plugin";

const MICROGRID = "660e8400-e29b-41d4-a716-446655440000";

let fibers: Fiber[] = [];

async function load(): Promise<{ providers: MeteringProviderFactories; fixture: Fiber }> {
  const root = new Context();
  fibers = await loadPlatformPlugins(root, [MeteringProvidersPlugin, FixtureMeteringPlugin]);
  return { providers: root.get("meteringProviders") as MeteringProviderFactories, fixture: fibers[1] };
}

/** A client whose edges read answers `result`, recording the microgrid asked for. */
function edgesClient(result: { data: { openems_edge_id: string }[] | null; error: unknown }) {
  const eq = vi.fn(async () => result);
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as never, from, select, eq };
}

const rows = (...ids: string[]) => ({ data: ids.map((openems_edge_id) => ({ openems_edge_id })), error: null });

afterEach(async () => {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  fibers = [];
  vi.unstubAllEnvs();
});

describe("FixtureMeteringPlugin", () => {
  it.each([["unset", undefined], ["0", "0"], ["off", "off"], ["an invalid value", "maybe"]])(
    "registers nothing when MGM_METERING_FIXTURES is %s",
    async (_label, value) => {
      vi.stubEnv("MGM_METERING_FIXTURES", value);
      const { providers } = await load();
      expect(providers.names()).toEqual([]);
    }
  );

  it("registers the synthetic provider, with its selector, when the setting is on", async () => {
    vi.stubEnv("MGM_METERING_FIXTURES", "on");
    const { providers } = await load();
    expect(providers.names()).toEqual([SYNTHETIC_PROVIDER_NAME]);
    expect(SYNTHETIC_PROVIDER_NAME).toBe("synthetic");

    const { client } = edgesClient(rows(`${SYNTHETIC_EDGE_ID_PREFIX}001`));
    expect(await providers.select(client, MICROGRID)).toBe("synthetic");
  });

  it("builds a synthetic provider that generates the seeded samples", async () => {
    vi.stubEnv("MGM_METERING_FIXTURES", "1");
    const { providers } = await load();
    const provider = providers.create("synthetic", {} as never);
    expect(provider.synthetic).toBe(true);
    const device = { id: "battery", edgeOpenemsId: `${SYNTHETIC_EDGE_ID_PREFIX}001`, componentId: "ess0" };
    const request: SiteSamplesRequest = {
      microgridId: MICROGRID,
      sources: { battery: device, gridMeter: null, load: null, pv: null, houseMeters: [], houseMetersUnreadable: 0 },
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      timezone: "Africa/Kampala",
      resolutionMinutes: 5,
    };
    expect(await provider.getSiteSamples?.(request)).toEqual(generateSiteSamples(request));
    // Billing has no generated readings: a missing reading is an error, never zero.
    await expect(
      provider.getReadings({ microgridId: MICROGRID, devices: [{ id: "m1" }] as never, startDate: "2026-11-01", endDate: "2026-11-30", timezone: "Africa/Kampala" })
    ).rejects.toThrow("Fixture reading is missing");
  });

  it("is selected by a microgrid's edges beside the OpenEMS fallback", async () => {
    vi.stubEnv("MGM_METERING_FIXTURES", "on");
    const root = new Context();
    fibers = await loadPlatformPlugins(root, [MeteringProvidersPlugin, OpenEmsMeteringPlugin, FixtureMeteringPlugin]);
    const providers = root.get("meteringProviders") as MeteringProviderFactories;
    const select = (result: ReturnType<typeof rows>) => providers.select(edgesClient(result).client, MICROGRID);

    expect(await select(rows("SYNTHETIC-EDGE-001"))).toBe("synthetic");
    expect(await select(rows("edge0"))).toBe("openems");
    expect(await select(rows())).toBe("openems");
    await expect(select(rows("SYNTHETIC-EDGE-001", "edge0"))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("removes the registration when its fiber unloads", async () => {
    vi.stubEnv("MGM_METERING_FIXTURES", "on");
    const { providers, fixture } = await load();
    await fixture.dispose();
    expect(providers.names()).toEqual([]);
  });
});

describe("syntheticSupports", () => {
  it("reads the microgrid's edge ids through the caller's client", async () => {
    const { client, from, select, eq } = edgesClient(rows());
    await syntheticSupports(client, MICROGRID);
    expect(from).toHaveBeenCalledWith("edges");
    expect(select).toHaveBeenCalledWith("openems_edge_id");
    expect(eq).toHaveBeenCalledWith("microgrid_id", MICROGRID);
  });

  it("serves a microgrid whose edges are all synthetic", async () => {
    const { client } = edgesClient(rows("SYNTHETIC-EDGE-001", "SYNTHETIC-EDGE-002"));
    expect(await syntheticSupports(client, MICROGRID)).toBe(true);
  });

  it.each([
    ["no edges", rows()],
    ["only real edges", rows("edge0", "edge1")],
    ["a lower-case look-alike", rows("synthetic-edge-001")],
  ])("leaves a microgrid with %s to its own provider", async (_label, result) => {
    const { client } = edgesClient(result);
    expect(await syntheticSupports(client, MICROGRID)).toBe(false);
  });

  it("refuses a microgrid that mixes synthetic and real edges with 409", async () => {
    const { client } = edgesClient(rows("SYNTHETIC-EDGE-001", "edge0"));
    const error = await syntheticSupports(client, MICROGRID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ code: "METERING_CONFIGURATION", statusCode: 409 });
    expect((error as Error).message).toMatch(/mixes synthetic and real edges/);
  });

  it("answers 503 when the edges cannot be read", async () => {
    const { client } = edgesClient({ data: null, error: { message: "boom" } });
    const error = await syntheticSupports(client, MICROGRID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeteringError);
    // A transient code, so the Operations page offers another try rather than OpenEMS setup.
    expect(error).toMatchObject({ code: "METERING_UNAVAILABLE", statusCode: 503 });
    expect((error as Error).message).not.toContain("boom");
  });
});
