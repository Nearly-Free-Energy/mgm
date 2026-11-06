import { afterEach, describe, expect, it, vi } from "vitest";

const { getMicrogridEmsConfig } = vi.hoisted(() => ({
  getMicrogridEmsConfig: vi.fn(async () => ({
    type: "direct_url" as const,
    url: "https://openems.example.test",
  })),
}));

vi.mock("@/lib/openems/config", () => ({ getMicrogridEmsConfig }));

import { MeteringError } from "../errors";
import { OpenEmsClient } from "@/lib/openems";
import { OpenEmsMeteringProvider } from "../openems-provider";
import type { SiteSamplesRequest, SiteSources } from "../types";

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

function clearPilotEnv() {
  for (const name of PILOT_ENV) delete process.env[name];
}

const response = (result: unknown) => new Response(JSON.stringify({
  jsonrpc: "2.0", result: { payload: { jsonrpc: "2.0", result } },
}), { status: 200, headers: { "content-type": "application/json" } });

const missing = () => new Response(JSON.stringify({
  error: { message: "Energy values are not available for query" },
}), { status: 400 });

type SentRpc = {
  method: string;
  edgeId: string;
  inner: { method: string; params: Record<string, unknown> & { channels: string[] } };
};

function sent(init: RequestInit | undefined): SentRpc {
  const body = JSON.parse(init?.body as string);
  return { method: body.method, edgeId: body.params.edgeId, inner: body.params.payload };
}

const device = (id: string, edgeOpenemsId: string, componentId: string) =>
  ({ id, edgeOpenemsId, componentId });

const NO_SOURCES: SiteSources = { battery: null, gridMeter: null, load: null, pv: null };

function siteRequest(sources: Partial<SiteSources>, overrides: Partial<SiteSamplesRequest> = {}) {
  return {
    microgridId: "microgrid-1",
    sources: { ...NO_SOURCES, ...sources },
    startDate: "2026-11-01",
    endDate: "2026-11-01",
    timezone: "Africa/Kampala",
    resolutionMinutes: 5,
    ...overrides,
  } satisfies SiteSamplesRequest;
}

// 2026-11-01 00:00 in Africa/Kampala (UTC+3).
const T0 = Date.UTC(2026, 9, 31, 21);
const FIVE_MIN = 5 * 60 * 1000;

describe("OpenEmsMeteringProvider.getSiteSamples", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getMicrogridEmsConfig.mockClear();
    resetPilotEnv();
  });

  it("sends one queryHistoricTimeseriesData edgeRpc per edge with every source channel", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ timestamps: [], data: {} })
    );

    await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
      gridMeter: device("grid-id", "edge-1", "meter0"),
      load: device("load-id", "edge-1", "meter1"),
      pv: device("pv-id", "edge-1", "pvInverter0"),
    }, { startDate: "2026-11-01", endDate: "2026-11-02" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://openems.example.test/jsonrpc");
    const rpc = sent(fetchSpy.mock.calls[0][1]);
    expect(rpc.method).toBe("edgeRpc");
    expect(rpc.edgeId).toBe("edge-1");
    expect(rpc.inner.method).toBe("queryHistoricTimeseriesData");
    expect(rpc.inner.params).toEqual({
      fromDate: "2026-11-01",
      toDate: "2026-11-02",
      timezone: "Africa/Kampala",
      resolution: { value: 5, unit: "Minutes" },
      channels: [
        "ess0/Soc",
        "ess0/ActivePower",
        "meter0/ActivePower",
        "meter0/VoltageL1",
        "meter0/VoltageL2",
        "meter0/VoltageL3",
        "meter1/ActivePower",
        "pvInverter0/ActivePower",
      ],
    });
    expect(getMicrogridEmsConfig).toHaveBeenCalledWith({}, "microgrid-1");
  });

  it("maps each source's channels onto its own series", async () => {
    clearPilotEnv();
    const timestamps = [T0, T0 + FIVE_MIN];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps,
      data: {
        "ess0/Soc": [80, 79],
        "ess0/ActivePower": [1_200, -300],
        "meter0/ActivePower": [-450, 600],
        "meter0/VoltageL1": [230_000, 231_000],
        "meter0/VoltageL2": [null, null],
        "meter0/VoltageL3": [null, null],
        "meter1/ActivePower": [900, 950],
        "pvInverter0/ActivePower": [2_000, 0],
      },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
      gridMeter: device("grid-id", "edge-1", "meter0"),
      load: device("load-id", "edge-1", "meter1"),
      pv: device("pv-id", "edge-1", "pvInverter0"),
    }));

    expect(samples).toEqual({
      timestamps,
      batterySocPct: [80, 79],
      batteryPowerW: [1_200, -300],
      gridPowerW: [-450, 600],
      gridVoltageV: [230, 231],
      loadPowerW: [900, 950],
      pvPowerW: [2_000, 0],
    });
  });

  it("converts grid voltage from mV to V and takes the highest phase, ignoring missing phases", async () => {
    clearPilotEnv();
    const timestamps = [T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN, T0 + 3 * FIVE_MIN];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps,
      data: {
        "meter0/ActivePower": [100, 100, 100, 100],
        "meter0/VoltageL1": [229_800, null, null, 231_500],
        "meter0/VoltageL2": [232_400, 228_000, null, null],
        "meter0/VoltageL3": [231_000, null, null, 240_100],
      },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      gridMeter: device("grid-id", "edge-1", "meter0"),
    }));

    expect(samples.gridVoltageV).toHaveLength(4);
    expect(samples.gridVoltageV[0]).toBeCloseTo(232.4, 9);
    expect(samples.gridVoltageV[1]).toBeCloseTo(228, 9);
    // Every phase missing: no value, never a substituted zero.
    expect(samples.gridVoltageV[2]).toBeNull();
    expect(samples.gridVoltageV[3]).toBeCloseTo(240.1, 9);
  });

  it("keeps null and non-numeric bins as null rather than zero", async () => {
    clearPilotEnv();
    const timestamps = [T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps,
      data: {
        "ess0/Soc": [null, 50, "n/a"],
        "ess0/ActivePower": [0, null, 10],
      },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }));

    expect(samples.timestamps).toEqual(timestamps);
    expect(samples.batterySocPct).toEqual([null, 50, null]);
    expect(samples.batteryPowerW).toEqual([0, null, 10]);
  });

  it("reads ISO-string, epoch-millisecond and epoch-second timestamps as epoch milliseconds", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [
        new Date(T0).toISOString(),
        "2026-11-01T00:05:00+03:00",
        T0 + 2 * FIVE_MIN,
        String((T0 + 3 * FIVE_MIN) / 1000),
        (T0 + 4 * FIVE_MIN) / 1000,
        String(T0 + 5 * FIVE_MIN),
      ],
      data: { "ess0/Soc": [10, 11, 12, 13, 14, 15] },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }));

    expect(samples.timestamps).toEqual(
      [0, 1, 2, 3, 4, 5].map((index) => T0 + index * FIVE_MIN)
    );
    expect(samples.batterySocPct).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it("drops unparseable timestamps instead of inventing an instant", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [T0, "not-a-date", T0 + 2 * FIVE_MIN],
      data: { "ess0/Soc": [10, 11, 12] },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }));

    expect(samples.timestamps).toEqual([T0, T0 + 2 * FIVE_MIN]);
    expect(samples.batterySocPct).toEqual([10, 12]);
  });

  it("merges two devices on two edges by timestamp, each edge queried for its own channels", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const rpc = sent(init);
      if (rpc.edgeId === "edge-a") {
        // Epoch milliseconds, bins 0 and 1, sent out of order.
        return response({
          timestamps: [T0 + FIVE_MIN, T0],
          data: { "ess0/Soc": [61, 60], "ess0/ActivePower": [-200, -100] },
        });
      }
      // ISO strings for the same instants, bins 1 and 2.
      return response({
        timestamps: [
          new Date(T0 + FIVE_MIN).toISOString(),
          new Date(T0 + 2 * FIVE_MIN).toISOString(),
        ],
        data: {
          "meter0/ActivePower": [500, 700],
          "meter0/VoltageL1": [230_000, 233_000],
          "meter0/VoltageL2": [231_000, null],
          "meter0/VoltageL3": [229_000, null],
        },
      });
    });

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-a", "ess0"),
      gridMeter: device("grid-id", "edge-b", "meter0"),
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const byEdge = Object.fromEntries(
      fetchSpy.mock.calls.map(([, init]) => {
        const rpc = sent(init);
        return [rpc.edgeId, rpc.inner.params.channels];
      })
    );
    expect(byEdge).toEqual({
      "edge-a": ["ess0/Soc", "ess0/ActivePower"],
      "edge-b": [
        "meter0/ActivePower",
        "meter0/VoltageL1",
        "meter0/VoltageL2",
        "meter0/VoltageL3",
      ],
    });

    expect(samples.timestamps).toEqual([T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN]);
    expect(samples.batterySocPct).toEqual([60, 61, null]);
    expect(samples.batteryPowerW).toEqual([-100, -200, null]);
    expect(samples.gridPowerW).toEqual([null, 500, 700]);
    expect(samples.gridVoltageV[0]).toBeNull();
    expect(samples.gridVoltageV[1]).toBeCloseTo(231, 9);
    expect(samples.gridVoltageV[2]).toBeCloseTo(233, 9);
  });

  it("requests a channel shared by two sources once and fills both series from it", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [T0],
      data: {
        "meter0/ActivePower": [420],
        "meter0/VoltageL1": [230_000],
        "meter0/VoltageL2": [null],
        "meter0/VoltageL3": [null],
      },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      gridMeter: device("grid-id", "edge-1", "meter0"),
      load: device("grid-id", "edge-1", "meter0"),
    }));

    const channels = sent(fetchSpy.mock.calls[0][1]).inner.params.channels;
    expect(channels.filter((channel) => channel === "meter0/ActivePower")).toHaveLength(1);
    expect(samples.gridPowerW).toEqual([420]);
    expect(samples.loadPowerW).toEqual([420]);
  });

  it("returns an all-null series, as long as the timestamps, for each missing source", async () => {
    clearPilotEnv();
    const timestamps = [T0, T0 + FIVE_MIN, T0 + 2 * FIVE_MIN];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps,
      data: { "ess0/Soc": [50, 51, 52], "ess0/ActivePower": [10, 20, 30] },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }));

    const channels = sent(fetchSpy.mock.calls[0][1]).inner.params.channels;
    expect(channels).toEqual(["ess0/Soc", "ess0/ActivePower"]);
    expect(samples.gridPowerW).toEqual([null, null, null]);
    expect(samples.gridVoltageV).toEqual([null, null, null]);
    expect(samples.loadPowerW).toEqual([null, null, null]);
    expect(samples.pvPowerW).toEqual([null, null, null]);
  });

  it("skips a source without an edge or component id instead of querying it", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [T0],
      data: { "ess0/Soc": [70], "ess0/ActivePower": [0] },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
      gridMeter: device("grid-id", "edge-1", ""),
      pv: device("pv-id", "", "pv0"),
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sent(fetchSpy.mock.calls[0][1]).inner.params.channels).toEqual([
      "ess0/Soc",
      "ess0/ActivePower",
    ]);
    expect(samples.gridPowerW).toEqual([null]);
    expect(samples.pvPowerW).toEqual([null]);
  });

  it("returns empty series without contacting OpenEMS when no source is assigned", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({}));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(samples).toEqual({
      timestamps: [],
      batterySocPct: [],
      batteryPowerW: [],
      gridPowerW: [],
      gridVoltageV: [],
      loadPowerW: [],
      pvPowerW: [],
    });
  });

  it("retries channel by channel when the batch has no history and leaves the missing channel null", async () => {
    clearPilotEnv();
    const timestamps = [T0, T0 + FIVE_MIN];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { channels } = sent(init).inner.params;
      if (channels.length > 1) return missing();
      const [channel] = channels;
      if (channel === "meter0/VoltageL3") return missing();
      const values: Record<string, number[]> = {
        "ess0/Soc": [40, 41],
        "ess0/ActivePower": [500, 400],
        "meter0/ActivePower": [-50, -60],
        "meter0/VoltageL1": [230_000, 230_000],
        "meter0/VoltageL2": [231_000, 229_000],
      };
      return response({ timestamps, data: { [channel]: values[channel] } });
    });

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
      gridMeter: device("grid-id", "edge-1", "meter0"),
    }));

    // One failed batch, then one request per channel.
    expect(fetchSpy).toHaveBeenCalledTimes(1 + 6);
    const retried = fetchSpy.mock.calls.slice(1).map(([, init]) => sent(init).inner.params.channels);
    expect(retried.every((channels) => channels.length === 1)).toBe(true);
    expect(retried.flat().sort()).toEqual([
      "ess0/ActivePower",
      "ess0/Soc",
      "meter0/ActivePower",
      "meter0/VoltageL1",
      "meter0/VoltageL2",
      "meter0/VoltageL3",
    ]);
    for (const [, init] of fetchSpy.mock.calls.slice(1)) {
      expect(sent(init).inner.params.resolution).toEqual({ value: 5, unit: "Minutes" });
    }

    expect(samples.timestamps).toEqual(timestamps);
    expect(samples.batterySocPct).toEqual([40, 41]);
    expect(samples.batteryPowerW).toEqual([500, 400]);
    expect(samples.gridPowerW).toEqual([-50, -60]);
    // L3 has no history; the other phases still answer.
    expect(samples.gridVoltageV[0]).toBeCloseTo(231, 9);
    expect(samples.gridVoltageV[1]).toBeCloseTo(230, 9);
  });

  it("returns all-null series when every channel of an edge has no history", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const rpc = sent(init);
      if (rpc.edgeId === "edge-a") return missing();
      return response({ timestamps: [T0], data: { "pv0/ActivePower": [1_500] } });
    });

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-a", "ess0"),
      pv: device("pv-id", "edge-b", "pv0"),
    }));

    expect(samples.timestamps).toEqual([T0]);
    expect(samples.pvPowerW).toEqual([1_500]);
    expect(samples.batterySocPct).toEqual([null]);
    expect(samples.batteryPowerW).toEqual([null]);
  });

  it("translates an OpenEMS authentication failure into METERING_UNAUTHORIZED", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 401 })
    );

    const error = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ code: "METERING_UNAUTHORIZED", statusCode: 401 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("translates other OpenEMS HTTP errors into METERING_UNAVAILABLE without a per-channel retry", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", { status: 502 })
    );

    const error = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ code: "METERING_UNAVAILABLE", statusCode: 502 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("translates a different HTTP 400 into METERING_UNAVAILABLE without a per-channel retry", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Edge is not connected" } }), { status: 400 })
    );

    await expect(new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }))).rejects.toMatchObject({ code: "METERING_UNAVAILABLE" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("translates an error raised during the per-channel retry", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { channels } = sent(init).inner.params;
      if (channels.length > 1) return missing();
      if (channels[0] === "ess0/ActivePower") return new Response("", { status: 403 });
      return response({ timestamps: [T0], data: { [channels[0]]: [1] } });
    });

    await expect(new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }))).rejects.toMatchObject({ code: "METERING_UNAUTHORIZED", statusCode: 403 });
  });

  it("reads with the page read timeout: every fetch carries an abort signal", async () => {
    clearPilotEnv();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { channels } = sent(init).inner.params;
      // Batch has no history: the per-channel retry must also be bounded.
      if (channels.length > 1) return missing();
      return response({ timestamps: [T0], data: { [channels[0]]: [1] } });
    });

    await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    for (const call of timeoutSpy.mock.calls) {
      expect(call).toEqual([OpenEmsClient.PAGE_READ_TIMEOUT_MS]);
    }
  });

  it.each([
    ["a DOMException", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["an Error", () => Object.assign(new Error("signal timed out"), { name: "TimeoutError" })],
  ])("translates a read timeout (%s) into METERING_UNAVAILABLE 503 without a per-channel retry", async (_label, make) => {
    clearPilotEnv();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(make());

    const error = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
      gridMeter: device("grid-id", "edge-1", "meter0"),
    })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ code: "METERING_UNAVAILABLE", statusCode: 503 });
    expect((error as MeteringError).message).toBe(
      "OpenEMS at https://openems.example.test did not answer within 20 s"
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // A known OpenEMS failure, not an unexpected one.
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("reports an unexpected response shape as METERING_UNAVAILABLE 503", async () => {
    clearPilotEnv();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 })
    );

    await expect(new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }))).rejects.toMatchObject({ code: "METERING_UNAVAILABLE", statusCode: 503 });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("fails with 503 METERING_CONFIGURATION when the microgrid has no OpenEMS configuration", async () => {
    clearPilotEnv();
    getMicrogridEmsConfig.mockResolvedValueOnce(null as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }))).rejects.toMatchObject({ code: "METERING_CONFIGURATION", statusCode: 503 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the pilot environment configuration for its bound microgrid", async () => {
    process.env.MGM_OPENEMS_MICROGRID_ID = "pilot-microgrid";
    process.env.MGM_OPENEMS_URL = "https://pilot-openems.example.test";
    process.env.MGM_OPENEMS_USERNAME = "readonly-user";
    process.env.MGM_OPENEMS_PASSWORD = "readonly-password";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [T0], data: { "ess0/Soc": [90], "ess0/ActivePower": [0] },
    }));

    const samples = await new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }, { microgridId: "pilot-microgrid" }));

    expect(samples.batterySocPct).toEqual([90]);
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][0]).toBe("https://pilot-openems.example.test/jsonrpc");
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("readonly-user:readonly-password").toString("base64")}`,
    });
  });

  it("refuses another microgrid with 403 METERING_CONFIGURATION under the pilot environment", async () => {
    process.env.MGM_OPENEMS_MICROGRID_ID = "pilot-microgrid";
    process.env.MGM_OPENEMS_URL = "https://pilot-openems.example.test";
    delete process.env.MGM_OPENEMS_USERNAME;
    delete process.env.MGM_OPENEMS_PASSWORD;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }, { microgridId: "other-microgrid" }))).rejects.toMatchObject({
      code: "METERING_CONFIGURATION",
      statusCode: 403,
    });
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed with 503 METERING_CONFIGURATION for an incomplete pilot environment", async () => {
    clearPilotEnv();
    process.env.MGM_OPENEMS_URL = "https://pilot-openems.example.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(new OpenEmsMeteringProvider({} as never).getSiteSamples(siteRequest({
      battery: device("battery-id", "edge-1", "ess0"),
    }))).rejects.toMatchObject({ code: "METERING_CONFIGURATION", statusCode: 503 });
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
