import { describe, expect, it } from "vitest";
import { createSyntheticMeteringProvider, SyntheticMeteringProvider } from "../synthetic-provider";
import { DEMO_PERIOD, SYNTHETIC_EDGE_ID, SYNTHETIC_METERS } from "../synthetic/dataset";
import { periodUsage, DEFAULT_SYNTHETIC_SEED } from "../synthetic/generator";

const devices = SYNTHETIC_METERS.map((meter, i) => ({
  id: `device-${i + 1}`,
  edgeOpenemsId: SYNTHETIC_EDGE_ID,
  componentId: meter.componentId,
}));
const request = { microgridId: "synthetic-microgrid", devices, ...DEMO_PERIOD };

describe("SyntheticMeteringProvider", () => {
  it("serves deterministic readings through the fixture path", async () => {
    const provider = new SyntheticMeteringProvider();
    const first = await provider.getReadings(request);
    expect(first).toEqual(await new SyntheticMeteringProvider().getReadings(request));
    expect(first).toHaveLength(devices.length);
    expect(first[0]).toEqual({
      deviceId: "device-1",
      usageKwh: periodUsage(DEFAULT_SYNTHETIC_SEED, SYNTHETIC_METERS[0], DEMO_PERIOD.startDate, DEMO_PERIOD.endDate).usageKwh,
      startDate: DEMO_PERIOD.startDate,
      endDate: DEMO_PERIOD.endDate,
    });
  });

  it("reports missing data as null, never zero", async () => {
    const readings = await new SyntheticMeteringProvider().getReadings(request);
    const usage = Object.fromEntries(
      readings.map((r, i) => [SYNTHETIC_METERS[i].profile, r.usageKwh])
    );
    expect(usage["boundary-gap"]).toBeNull();
    expect(usage["no-data"]).toBeNull();
    expect(usage["interior-gap"]).toBeGreaterThan(0);
    expect(readings.filter((r) => r.usageKwh === 0)).toHaveLength(0);
  });

  it("honours the seed", async () => {
    const a = await createSyntheticMeteringProvider("seed-a").getReadings(request);
    const b = await createSyntheticMeteringProvider("seed-b").getReadings(request);
    expect(a[0].usageKwh).not.toBe(b[0].usageKwh);
    expect(await createSyntheticMeteringProvider("  ").getReadings(request)).toEqual(
      await new SyntheticMeteringProvider().getReadings(request)
    );
  });

  it("refuses devices that are not synthetic demonstration meters", async () => {
    const provider = new SyntheticMeteringProvider();
    const real = { id: "d", edgeOpenemsId: "edge-real", componentId: "meter-real" };
    await expect(provider.getReadings({ ...request, devices: [real] })).rejects.toMatchObject({
      code: "METERING_INVALID_DATA",
    });
    // Synthetic component on a non-synthetic edge is also refused.
    await expect(
      provider.getReadings({ ...request, devices: [{ ...devices[0], edgeOpenemsId: "edge-real" }] })
    ).rejects.toMatchObject({ code: "METERING_INVALID_DATA" });
  });

  it("rejects an invalid window", async () => {
    await expect(
      new SyntheticMeteringProvider().getReadings({ ...request, startDate: "2026-09-30", endDate: "2026-09-01" })
    ).rejects.toMatchObject({ code: "METERING_INVALID_DATA" });
  });
});
