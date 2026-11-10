import { describe, expect, it, vi } from "vitest";
import {
  FixtureMeteringProvider,
  SYNTHETIC_EDGE_ID_PREFIX,
  isSyntheticEdgeId,
} from "../fixture-provider";
import { generateSiteSamples } from "../fixture/site-samples";
import type { SiteSamplesRequest } from "../types";

const request = {
  microgridId: "microgrid-1",
  devices: [
    { id: "device-1", edgeOpenemsId: "edge-1", componentId: "meter-1" },
  ],
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  timezone: "Africa/Kampala",
};

describe("FixtureMeteringProvider", () => {
  it("returns deterministic device readings for the exact period window", async () => {
    const provider = new FixtureMeteringProvider([
      { ...request, deviceId: "device-1", usageKwh: 12.345 },
    ]);

    await expect(provider.getReadings(request)).resolves.toEqual([
      {
        deviceId: "device-1",
        usageKwh: 12.345,
        startDate: request.startDate,
        endDate: request.endDate,
      },
    ]);
  });

  it("fails explicitly for an omitted reading instead of returning zero", async () => {
    const provider = new FixtureMeteringProvider([]);
    await expect(provider.getReadings(request)).rejects.toMatchObject({
      code: "METERING_INVALID_DATA",
      statusCode: 400,
    });
  });

  it("marks itself synthetic", () => {
    expect(new FixtureMeteringProvider([]).synthetic).toBe(true);
  });
});

describe("the reserved edge id prefix", () => {
  it("is SYNTHETIC-EDGE-, matched exactly and at the start", () => {
    expect(SYNTHETIC_EDGE_ID_PREFIX).toBe("SYNTHETIC-EDGE-");
    expect(isSyntheticEdgeId("SYNTHETIC-EDGE-1")).toBe(true);
    for (const id of ["SYNTHETIC-1", "SYNTHETIC-EDGEX1", "synthetic-edge-1", "X-SYNTHETIC-EDGE-1", "edge0"]) {
      expect(isSyntheticEdgeId(id), id).toBe(false);
    }
  });
});

describe("FixtureMeteringProvider.getSiteSamples", () => {
  const synthetic = (id: string) => ({
    id,
    edgeOpenemsId: `${SYNTHETIC_EDGE_ID_PREFIX}001`,
    componentId: id,
  });
  const siteRequest = (overrides: Partial<SiteSamplesRequest["sources"]> = {}): SiteSamplesRequest => ({
    microgridId: "microgrid-1",
    sources: {
      battery: synthetic("battery"),
      gridMeter: synthetic("grid"),
      load: null,
      pv: null,
      houseMeters: [synthetic("house")],
      houseMetersUnreadable: 0,
      ...overrides,
    },
    startDate: "2026-09-01",
    endDate: "2026-09-02",
    timezone: "Africa/Kampala",
    resolutionMinutes: 5,
  });
  const generating = new FixtureMeteringProvider([], {
    siteSamples: (r) => generateSiteSamples(r),
  });

  it("generates samples for devices on synthetic edges", async () => {
    const samples = await generating.getSiteSamples(siteRequest());
    expect(samples).toEqual(generateSiteSamples(siteRequest()));
    expect(samples.timestamps).toHaveLength(2 * 288);
  });

  it.each([
    ["the battery", { battery: { id: "battery", edgeOpenemsId: "edge0", componentId: "ess0" } }],
    ["the grid meter", { gridMeter: { id: "grid", edgeOpenemsId: "synthetic-edge-1", componentId: "meter0" } }],
    ["a house meter", { houseMeters: [{ id: "house", edgeOpenemsId: "X-SYNTHETIC-EDGE-1", componentId: "meter1" }] }],
    ["the solar source", { pv: { id: "pv", edgeOpenemsId: "edge0", componentId: "meter3" } }],
    [
      "a house meter after the first",
      { houseMeters: [synthetic("house"), { id: "house-2", edgeOpenemsId: "SYNTHETIC-1", componentId: "meter4" }] },
    ],
  ])("refuses when %s is not on a synthetic edge", async (_, sources) => {
    const generator = vi.fn();
    const provider = new FixtureMeteringProvider([], { siteSamples: generator });
    await expect(provider.getSiteSamples(siteRequest(sources))).rejects.toMatchObject({
      code: "METERING_INVALID_DATA",
      statusCode: 400,
    });
    expect(generator).not.toHaveBeenCalled();
  });

  it("answers 503 without a generator", async () => {
    await expect(new FixtureMeteringProvider([]).getSiteSamples(siteRequest())).rejects.toMatchObject({
      code: "METERING_CONFIGURATION",
      statusCode: 503,
    });
  });

  it("checks the prefix before reporting a missing generator", async () => {
    await expect(
      new FixtureMeteringProvider([]).getSiteSamples(
        siteRequest({ load: { id: "load", edgeOpenemsId: "edge0", componentId: "meter2" } })
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
