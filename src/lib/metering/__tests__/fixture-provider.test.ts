import { describe, expect, it } from "vitest";
import { FixtureMeteringProvider } from "../fixture-provider";

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
});
