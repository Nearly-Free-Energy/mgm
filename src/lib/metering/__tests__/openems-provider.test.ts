import { afterEach, describe, expect, it, vi } from "vitest";

const { getMicrogridEmsConfig } = vi.hoisted(() => ({
  getMicrogridEmsConfig: vi.fn(async () => ({
    type: "direct_url" as const,
    url: "https://openems.example.test",
  })),
}));

vi.mock("@/lib/openems/config", () => ({ getMicrogridEmsConfig }));

import { OpenEmsMeteringProvider } from "../openems-provider";

const PILOT_ENV = [
  "MGM_OPENEMS_MICROGRID_ID",
  "MGM_OPENEMS_URL",
  "MGM_OPENEMS_USERNAME",
  "MGM_OPENEMS_PASSWORD",
] as const;
const initialEnv = Object.fromEntries(PILOT_ENV.map((name) => [name, process.env[name]]));

function resetPilotEnv() {
  for (const name of PILOT_ENV) {
    const value = initialEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe("OpenEmsMeteringProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getMicrogridEmsConfig.mockClear();
    resetPilotEnv();
  });

  it("reads each meter ActiveConsumptionEnergy channel and never requests _sum", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "outer",
          result: {
            payload: {
              jsonrpc: "2.0",
              id: "inner",
              result: {
                data: {
                  "meter-one/ActiveConsumptionEnergy": 12_345,
                  "meter-two/ActiveConsumptionEnergy": 67_890,
                  "_sum/ConsumptionActiveEnergy": 0,
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const provider = new OpenEmsMeteringProvider({} as never);

    const readings = await provider.getReadings({
      microgridId: "microgrid-1",
      devices: [
        { id: "device-1", edgeOpenemsId: "edge-1", componentId: "meter-one" },
        { id: "device-2", edgeOpenemsId: "edge-1", componentId: "meter-two" },
      ],
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      timezone: "Africa/Kampala",
    });

    expect(readings.map((reading) => reading.usageKwh)).toEqual([12.345, 67.89]);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.params.payload.params.channels).toEqual([
      "meter-one/ActiveConsumptionEnergy",
      "meter-two/ActiveConsumptionEnergy",
    ]);
    expect(body.params.payload.params.channels).not.toContain("_sum/ConsumptionActiveEnergy");
  });

  it("uses complete pilot environment configuration only for its bound microgrid", async () => {
    process.env.MGM_OPENEMS_MICROGRID_ID = "pilot-microgrid";
    process.env.MGM_OPENEMS_URL = "https://pilot-openems.example.test";
    process.env.MGM_OPENEMS_USERNAME = "readonly-user";
    process.env.MGM_OPENEMS_PASSWORD = "readonly-password";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: { payload: { result: { data: { "meter/ActiveConsumptionEnergy": 1_000 } } } },
        }),
        { status: 200 }
      )
    );

    const readings = await new OpenEmsMeteringProvider({} as never).getReadings({
      microgridId: "pilot-microgrid",
      devices: [{ id: "device", edgeOpenemsId: "edge", componentId: "meter" }],
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      timezone: "Africa/Kampala",
    });

    expect(readings[0].usageKwh).toBe(1);
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][0]).toBe("https://pilot-openems.example.test/jsonrpc");
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("readonly-user:readonly-password").toString("base64")}`,
    });
  });

  it("fails closed for incomplete or mismatched pilot environment configuration", async () => {
    const provider = new OpenEmsMeteringProvider({} as never);
    const request = {
      microgridId: "requested-microgrid",
      devices: [],
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      timezone: "Africa/Kampala",
    };

    process.env.MGM_OPENEMS_URL = "https://pilot-openems.example.test";
    await expect(provider.getReadings(request)).rejects.toMatchObject({
      code: "METERING_CONFIGURATION",
      statusCode: 503,
    });
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();

    process.env.MGM_OPENEMS_MICROGRID_ID = "other-microgrid";
    await expect(provider.getReadings(request)).rejects.toMatchObject({
      code: "METERING_CONFIGURATION",
      statusCode: 403,
    });
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
  });
});
