import { afterEach, describe, expect, it, vi } from "vitest";

const { getMicrogridEmsConfig } = vi.hoisted(() => ({
  getMicrogridEmsConfig: vi.fn(async () => ({
    type: "direct_url" as const,
    url: "https://openems.example.test",
  })),
}));

vi.mock("@/lib/openems/config", () => ({ getMicrogridEmsConfig }));

import { OpenEmsClient } from "@/lib/openems";
import { localHourStarts } from "@/lib/timezone/day-key";
import { MeteringError } from "../errors";
import { OpenEmsMeteringProvider } from "../openems-provider";
import type { DeviceEnergySeriesRequest } from "../types";

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

const METER0 = "meter0/ActiveConsumptionEnergy";
const METER1 = "meter1/ActiveConsumptionEnergy";

function seriesRequest(overrides: Partial<DeviceEnergySeriesRequest> = {}): DeviceEnergySeriesRequest {
  return {
    microgridId: "microgrid-1",
    devices: [device("dev-1", "edge-1", "meter0")],
    startDate: "2026-11-05",
    endDate: "2026-11-05",
    resolution: "hour",
    timezone: "Africa/Kampala",
    ...overrides,
  };
}

const provider = () => new OpenEmsMeteringProvider({} as never);
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;
// 2026-11-05 00:00 in Africa/Kampala (UTC+3), and the lead day's midnight.
const K0 = Date.UTC(2026, 10, 4, 21);
const LEAD = K0 - 24 * HOUR;

/** Wh the fake meter counted in each hour of the requested day: distinct per hour. */
const dayWh = (hour: number) => 10 * hour + 1;

describe("OpenEmsMeteringProvider.getDeviceEnergySeries: hours", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getMicrogridEmsConfig.mockClear();
    resetPilotEnv();
  });

  it("reads from the day before, drops the lead day's buckets and keeps a null inside the range", async () => {
    clearPilotEnv();
    // Spike, 17 Nov 2026: the first two hourly buckets of any range are null.
    const timestamps = Array.from({ length: 48 }, (_, i) => LEAD + i * HOUR);
    const values = timestamps.map((_, i) =>
      i < 2 ? null : i < 24 ? 999 : i - 24 === 10 ? null : dayWh(i - 24)
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ timestamps, data: { [METER0]: values } })
    );

    const series = await provider().getDeviceEnergySeries(seriesRequest());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://openems.example.test/jsonrpc");
    const rpc = sent(fetchSpy.mock.calls[0][1]);
    expect(rpc.method).toBe("edgeRpc");
    expect(rpc.edgeId).toBe("edge-1");
    expect(rpc.inner.method).toBe("queryHistoricTimeseriesEnergyPerPeriod");
    expect(rpc.inner.params).toEqual({
      fromDate: "2026-11-04",
      toDate: "2026-11-05",
      channels: [METER0],
      timezone: "Africa/Kampala",
      resolution: { value: 1, unit: "Hours" },
    });
    expect(getMicrogridEmsConfig).toHaveBeenCalledWith({}, "microgrid-1");

    expect(series.buckets).toHaveLength(24);
    expect(series.buckets[0]).toBe(K0);
    expect(series.buckets.every((start, i) => start === K0 + i * HOUR)).toBe(true);
    expect(series.kwh).toEqual({
      "dev-1": Array.from({ length: 24 }, (_, hour) => (hour === 10 ? null : dayWh(hour) / 1000)),
    });
  });

  it("returns no bucket of the lead day even when the backend fills it", async () => {
    clearPilotEnv();
    const timestamps = Array.from({ length: 48 }, (_, i) => LEAD + i * HOUR);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ timestamps, data: { [METER0]: timestamps.map((_, i) => (i < 24 ? 5_000 : 0)) } })
    );

    const series = await provider().getDeviceEnergySeries(seriesRequest());

    expect(series.buckets[0]).toBe(K0);
    expect(series.kwh["dev-1"]).toEqual(Array(24).fill(0));
  });

  it("leaves a bucket the response left out null, and every later bucket keeps its own value", async () => {
    clearPilotEnv();
    const timestamps = Array.from({ length: 48 }, (_, i) => LEAD + i * HOUR)
      .filter((time) => time !== K0 + 12 * HOUR);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps,
      data: { [METER0]: timestamps.map((time) => (time < K0 ? 0 : dayWh((time - K0) / HOUR))) },
    }));

    const series = await provider().getDeviceEnergySeries(seriesRequest());

    expect(series.kwh["dev-1"]).toEqual(
      Array.from({ length: 24 }, (_, hour) => (hour === 12 ? null : dayWh(hour) / 1000))
    );
  });

  describe("matches buckets by instant, not by position, where days are not all 24 hours", () => {
    const NEW_YORK = "America/New_York";

    function hoursOf(dates: string[]) {
      return dates.flatMap((date) => localHourStarts(date, NEW_YORK).map((start, hour) => ({ date, start, hour })));
    }

    it("gives the 25 hours of a fall-back day, the two 01:00 hours each with its own value", async () => {
      clearPilotEnv();
      const hours = hoursOf(["2026-10-31", "2026-11-01"]);
      expect(hours).toHaveLength(24 + 25);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
        timestamps: hours.map(({ start }) => start),
        data: { [METER0]: hours.map(({ date, hour }) => (date === "2026-10-31" ? 999 : 100 + hour)) },
      }));

      const series = await provider().getDeviceEnergySeries(seriesRequest({
        timezone: NEW_YORK, startDate: "2026-11-01", endDate: "2026-11-01",
      }));

      expect(sent(fetchSpy.mock.calls[0][1]).inner.params).toMatchObject({
        fromDate: "2026-10-31", toDate: "2026-11-01", timezone: NEW_YORK,
      });
      expect(series.buckets).toHaveLength(25);
      expect(iso(series.buckets[0])).toBe("2026-11-01T04:00:00.000Z");
      // 01:00 -04:00 and 01:00 -05:00.
      expect(iso(series.buckets[1])).toBe("2026-11-01T05:00:00.000Z");
      expect(iso(series.buckets[2])).toBe("2026-11-01T06:00:00.000Z");
      expect(series.kwh["dev-1"]).toEqual(Array.from({ length: 25 }, (_, hour) => (100 + hour) / 1000));
    });

    it("gives the 24 hours of the day after a fall-back day, whose lead day had 25", async () => {
      clearPilotEnv();
      const hours = hoursOf(["2026-11-01", "2026-11-02"]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
        timestamps: hours.map(({ start }) => start),
        data: { [METER0]: hours.map(({ date, hour }) => (date === "2026-11-01" ? 999 : 100 + hour)) },
      }));

      const series = await provider().getDeviceEnergySeries(seriesRequest({
        timezone: NEW_YORK, startDate: "2026-11-02", endDate: "2026-11-02",
      }));

      expect(series.buckets).toHaveLength(24);
      expect(iso(series.buckets[0])).toBe("2026-11-02T05:00:00.000Z");
      expect(series.kwh["dev-1"]).toEqual(Array.from({ length: 24 }, (_, hour) => (100 + hour) / 1000));
    });

    it("gives the 23 hours of a spring-forward day, with no 02:00", async () => {
      clearPilotEnv();
      const hours = hoursOf(["2026-03-07", "2026-03-08"]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
        timestamps: hours.map(({ start }) => start),
        data: { [METER0]: hours.map(({ date, hour }) => (date === "2026-03-07" ? 999 : 100 + hour)) },
      }));

      const series = await provider().getDeviceEnergySeries(seriesRequest({
        timezone: NEW_YORK, startDate: "2026-03-08", endDate: "2026-03-08",
      }));

      expect(series.buckets).toHaveLength(23);
      // 00:00 -05:00, 01:00 -05:00, then 03:00 -04:00.
      expect(series.buckets.slice(0, 3).map(iso)).toEqual([
        "2026-03-08T05:00:00.000Z",
        "2026-03-08T06:00:00.000Z",
        "2026-03-08T07:00:00.000Z",
      ]);
      expect(series.kwh["dev-1"]).toEqual(Array.from({ length: 23 }, (_, hour) => (100 + hour) / 1000));
    });
  });
});

describe("OpenEmsMeteringProvider.getDeviceEnergySeries: days", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getMicrogridEmsConfig.mockClear();
    resetPilotEnv();
  });

  const dayRequest = (overrides: Partial<DeviceEnergySeriesRequest> = {}) => seriesRequest({
    resolution: "day", startDate: "2026-11-01", endDate: "2026-11-03", ...overrides,
  });

  it("reads from the day before as well, and the lead day's value never appears", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [
        "2026-10-31T00:00+03:00[Africa/Kampala]",
        "2026-11-01T00:00+03:00[Africa/Kampala]",
        "2026-11-02T00:00+03:00[Africa/Kampala]",
        "2026-11-03T00:00+03:00[Africa/Kampala]",
      ],
      data: { [METER0]: [5_000, 1_200, null, 3_400] },
    }));

    const series = await provider().getDeviceEnergySeries(dayRequest());

    expect(sent(fetchSpy.mock.calls[0][1]).inner.params).toEqual({
      fromDate: "2026-10-31",
      toDate: "2026-11-03",
      channels: [METER0],
      timezone: "Africa/Kampala",
      resolution: { value: 1, unit: "Days" },
    });
    expect(series.buckets.map(iso)).toEqual([
      "2026-10-31T21:00:00.000Z",
      "2026-11-01T21:00:00.000Z",
      "2026-11-02T21:00:00.000Z",
    ]);
    expect(series.kwh).toEqual({ "dev-1": [1.2, null, 3.4] });
  });

  it("leaves a day the response left out null, without shifting the next day", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [
        Date.parse("2026-10-31T00:00+03:00"),
        Date.parse("2026-11-01T00:00+03:00"),
        Date.parse("2026-11-03T00:00+03:00"),
      ],
      data: { [METER0]: [5_000, 1_200, 3_400] },
    }));

    const series = await provider().getDeviceEnergySeries(dayRequest());

    expect(series.kwh["dev-1"]).toEqual([1.2, null, 3.4]);
  });

  it("refuses two values for one day of one edge's channel with 502 METERING_INVALID_DATA", async () => {
    clearPilotEnv();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [
        "2026-11-01T00:00+03:00[Africa/Kampala]",
        "2026-11-01T12:00+03:00[Africa/Kampala]",
      ],
      data: { [METER0]: [1_200, 1_300] },
    }));

    const error = await provider().getDeviceEnergySeries(dayRequest()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ code: "METERING_INVALID_DATA", statusCode: 502 });
    expect((error as MeteringError).message).not.toContain("openems.example.test");
    expect(consoleSpy).toHaveBeenCalledWith(
      "MGM energy series: two OpenEMS values for one bucket",
      expect.objectContaining({ edgeId: "edge-1", channel: METER0 })
    );
  });
});

describe("OpenEmsMeteringProvider.getDeviceEnergySeries: values and timestamps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getMicrogridEmsConfig.mockClear();
    resetPilotEnv();
  });

  it("reads epoch-millisecond, epoch-second and Java zoned timestamps", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [
        K0,
        (K0 + HOUR) / 1000,
        String((K0 + 2 * HOUR) / 1000),
        "2026-11-05T03:00+03:00[Africa/Kampala]",
        new Date(K0 + 4 * HOUR).toISOString(),
      ],
      data: { [METER0]: [1, 2, 3, 4, 5] },
    }));

    const series = await provider().getDeviceEnergySeries(seriesRequest());

    expect(series.kwh["dev-1"].slice(0, 6)).toEqual([0.001, 0.002, 0.003, 0.004, 0.005, null]);
  });

  it("fails with 502 METERING_INVALID_DATA when most timestamps cannot be read", async () => {
    clearPilotEnv();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: ["first hour", "second hour", K0 + 2 * HOUR],
      data: { [METER0]: [1, 2, 3] },
    }));

    const error = await provider().getDeviceEnergySeries(seriesRequest()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "METERING_INVALID_DATA",
      statusCode: 502,
      message: "OpenEMS returned this usage in a form MGM could not read. Try again shortly.",
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      "MGM energy series: unreadable OpenEMS timestamps",
      expect.objectContaining({ edgeId: "edge-1", count: 3, unreadable: 2 })
    );
  });

  it("still reads a response when exactly half its timestamps are unreadable", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [K0, "not-a-date"],
      data: { [METER0]: [7, 8] },
    }));

    const series = await provider().getDeviceEnergySeries(seriesRequest());

    expect(series.kwh["dev-1"][0]).toBe(0.007);
    expect(series.kwh["dev-1"].slice(1).every((value) => value === null)).toBe(true);
  });

  it("keeps a negative value (a counter reset) and a non-numeric one as null, never zero", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({
      timestamps: [K0, K0 + HOUR, K0 + 2 * HOUR, K0 + 3 * HOUR, K0 + 4 * HOUR],
      data: { [METER0]: [-5, "n/a", null, 0, 40] },
    }));

    const series = await provider().getDeviceEnergySeries(seriesRequest());

    expect(series.kwh["dev-1"].slice(0, 5)).toEqual([null, null, null, 0, 0.04]);
  });

  it("queries each edge for its own channels and returns a series for every device asked for", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const rpc = sent(init);
      if (rpc.edgeId === "edge-a") {
        return response({ timestamps: [K0], data: { [METER0]: [100], [METER1]: [200] } });
      }
      return response({ timestamps: [K0 + HOUR], data: { "meter3/ActiveConsumptionEnergy": [300] } });
    });

    const series = await provider().getDeviceEnergySeries(seriesRequest({
      devices: [
        device("dev-1", "edge-a", "meter0"),
        device("dev-2", "edge-a", "meter1"),
        device("dev-3", "edge-b", "meter3"),
        // No component id: not requested, all null.
        device("dev-4", "edge-a", ""),
        // No edge: not requested, all null.
        device("dev-5", "", "meter9"),
      ],
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const batches = fetchSpy.mock.calls.map(([, init]) => {
      const rpc = sent(init);
      return [rpc.edgeId, rpc.inner.params.channels];
    });
    expect(batches).toEqual(expect.arrayContaining([
      ["edge-a", [METER0, METER1]],
      ["edge-b", ["meter3/ActiveConsumptionEnergy"]],
    ]));
    expect(Object.keys(series.kwh).sort()).toEqual(["dev-1", "dev-2", "dev-3", "dev-4", "dev-5"]);
    expect(series.kwh["dev-1"][0]).toBe(0.1);
    expect(series.kwh["dev-2"][0]).toBe(0.2);
    expect(series.kwh["dev-3"][1]).toBe(0.3);
    expect(series.kwh["dev-4"]).toEqual(Array(24).fill(null));
    expect(series.kwh["dev-5"]).toEqual(Array(24).fill(null));
  });

  it("keeps the same component on two edges apart: each device gets its own edge's values", async () => {
    clearPilotEnv();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const rpc = sent(init);
      return response({
        timestamps: [K0, K0 + HOUR],
        data: { [METER0]: rpc.edgeId === "edge-1" ? [100, 110] : [500, 550] },
      });
    });

    const series = await provider().getDeviceEnergySeries(seriesRequest({
      // A replacement meter on another gateway, with the same component id.
      devices: [device("D1", "edge-1", "meter0"), device("D2", "edge-2", "meter0")],
    }));

    expect(series.kwh.D1.slice(0, 2)).toEqual([0.1, 0.11]);
    expect(series.kwh.D2.slice(0, 2)).toEqual([0.5, 0.55]);
  });

  it("refuses an edge whose response repeats a bucket for one channel", async () => {
    clearPilotEnv();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const rpc = sent(init);
      return rpc.edgeId === "edge-1"
        ? response({ timestamps: [K0, K0], data: { [METER0]: [100, 100] } })
        : response({ timestamps: [K0], data: { [METER0]: [500] } });
    });

    await expect(provider().getDeviceEnergySeries(seriesRequest({
      devices: [device("D1", "edge-1", "meter0"), device("D2", "edge-2", "meter0")],
    }))).rejects.toMatchObject({ code: "METERING_INVALID_DATA", statusCode: 502 });
  });

  it("requests a channel two devices share once, and gives each device its own array", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ timestamps: [K0], data: { [METER0]: [250] } })
    );

    const series = await provider().getDeviceEnergySeries(seriesRequest({
      devices: [device("dev-1", "edge-1", "meter0"), device("dev-2", "edge-1", "meter0")],
    }));

    expect(sent(fetchSpy.mock.calls[0][1]).inner.params.channels).toEqual([METER0]);
    expect(series.kwh["dev-1"]).toEqual(series.kwh["dev-2"]);
    expect(series.kwh["dev-1"]).not.toBe(series.kwh["dev-2"]);
    expect(series.kwh["dev-1"][0]).toBe(0.25);
  });

  it("reads nothing, not even the configuration, when no device can be read", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const series = await provider().getDeviceEnergySeries(seriesRequest({
      devices: [device("dev-1", "edge-1", ""), device("dev-2", "", "meter0")],
    }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(series.buckets).toHaveLength(24);
    expect(series.kwh).toEqual({ "dev-1": Array(24).fill(null), "dev-2": Array(24).fill(null) });
  });

  it("refuses a malformed range with 400 before reading the configuration or OpenEMS", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(provider().getDeviceEnergySeries(seriesRequest({
      startDate: "2026-11-05", endDate: "2026-11-04",
    }))).rejects.toMatchObject({ code: "METERING_INVALID_DATA", statusCode: 400 });
    await expect(provider().getDeviceEnergySeries(seriesRequest({
      startDate: "2026-11-01", endDate: "2026-11-08",
    }))).rejects.toMatchObject({ code: "METERING_INVALID_DATA", statusCode: 400 });
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OpenEmsMeteringProvider.getDeviceEnergySeries: errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getMicrogridEmsConfig.mockClear();
    resetPilotEnv();
  });

  it("retries channel by channel when the batch has no history, and leaves that meter all null", async () => {
    clearPilotEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { channels } = sent(init).inner.params;
      if (channels.length > 1 || channels[0] === METER1) return missing();
      return response({ timestamps: [K0, K0 + HOUR], data: { [channels[0]]: [10, 20] } });
    });

    const series = await provider().getDeviceEnergySeries(seriesRequest({
      devices: [device("dev-1", "edge-1", "meter0"), device("dev-2", "edge-1", "meter1")],
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(1 + 2);
    for (const [, init] of fetchSpy.mock.calls.slice(1)) {
      expect(sent(init).inner.params).toMatchObject({
        fromDate: "2026-11-04",
        resolution: { value: 1, unit: "Hours" },
      });
    }
    expect(series.kwh["dev-1"].slice(0, 3)).toEqual([0.01, 0.02, null]);
    expect(series.kwh["dev-2"]).toEqual(Array(24).fill(null));
  });

  it("reads under one deadline: every request and retry shares the same abort signal", async () => {
    clearPilotEnv();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { channels } = sent(init).inner.params;
      if (channels.length > 1) return missing();
      return response({ timestamps: [K0], data: { [channels[0]]: [1] } });
    });

    await provider().getDeviceEnergySeries(seriesRequest({
      devices: [
        device("dev-1", "edge-1", "meter0"),
        device("dev-2", "edge-1", "meter1"),
        device("dev-3", "edge-2", "meter0"),
      ],
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(1 + 2 + 1);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(OpenEmsClient.PAGE_READ_TIMEOUT_MS);
    const deadline = timeoutSpy.mock.results[0].value;
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init?.signal).toBe(deadline);
    }
  });

  it.each([
    [
      "a refused sign-in (401)",
      async () => new Response("", { status: 401 }),
      { code: "METERING_UNAUTHORIZED", statusCode: 401 },
      "OpenEMS refused MGM's sign-in. Check the OpenEMS connection under Setup.",
    ],
    [
      "an HTTP 502 with a body naming the backend",
      async () => new Response("<html>https://openems.example.test is down</html>", { status: 502 }),
      { code: "METERING_UNAVAILABLE", statusCode: 502 },
      "OpenEMS could not provide this usage. Try again shortly.",
    ],
    [
      "a JSON-RPC error",
      async () => new Response(JSON.stringify({ error: { message: "Edge edge-1 is not connected" } }), {
        status: 200,
      }),
      { code: "METERING_UNAVAILABLE", statusCode: 502 },
      "OpenEMS could not provide this usage. Try again shortly.",
    ],
    [
      "a different HTTP 400",
      async () => new Response(JSON.stringify({ error: { message: "Edge is not connected" } }), { status: 400 }),
      { code: "METERING_UNAVAILABLE", statusCode: 502 },
      "OpenEMS could not provide this usage. Try again shortly.",
    ],
    [
      "a read timeout",
      () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      { code: "METERING_UNAVAILABLE", statusCode: 503 },
      "OpenEMS did not answer in time. Try again shortly.",
    ],
    [
      "a network failure",
      () => Promise.reject(new TypeError("fetch failed")),
      { code: "METERING_UNAVAILABLE", statusCode: 503 },
      "OpenEMS did not answer in time. Try again shortly.",
    ],
  ])("translates %s into fixed copy that names neither the backend nor its reply", async (_label, reply, expected, message) => {
    clearPilotEnv();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(reply);

    const error = await provider().getDeviceEnergySeries(seriesRequest()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MeteringError);
    expect(error).toMatchObject({ ...expected, message });
    const exposed = `${(error as MeteringError).message} ${JSON.stringify((error as MeteringError).details)}`;
    expect(exposed).not.toContain("openems.example.test");
    expect(exposed).not.toContain("not connected");
    expect(exposed).not.toContain("is down");
    // Not a missing channel: no per-channel retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The client's own message, with the backend, goes to the server log only.
    expect(consoleSpy.mock.calls[0][0]).toBe("MGM energy series: OpenEMS failed");
  });

  it("starts no request once the deadline has passed", async () => {
    clearPilotEnv();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deadline = new AbortController();
    deadline.abort(new DOMException("signal timed out", "TimeoutError"));
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(provider().getDeviceEnergySeries(seriesRequest())).rejects.toMatchObject({
      code: "METERING_UNAVAILABLE",
      statusCode: 503,
      message: "OpenEMS did not answer in time. Try again shortly.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an unexpected response shape as METERING_UNAVAILABLE 503", async () => {
    clearPilotEnv();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 })
    );

    await expect(provider().getDeviceEnergySeries(seriesRequest())).rejects.toMatchObject({
      code: "METERING_UNAVAILABLE",
      statusCode: 503,
      message: "Metering provider failed unexpectedly",
    });
    expect(consoleSpy.mock.calls[0][0]).toBe("Unexpected MGM energy series failure");
  });

  it("fails with 503 METERING_CONFIGURATION when the microgrid has no OpenEMS configuration", async () => {
    clearPilotEnv();
    getMicrogridEmsConfig.mockResolvedValueOnce(null as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(provider().getDeviceEnergySeries(seriesRequest())).rejects.toMatchObject({
      code: "METERING_CONFIGURATION",
      statusCode: 503,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses another microgrid with 403 METERING_CONFIGURATION under the pilot environment", async () => {
    process.env.MGM_OPENEMS_MICROGRID_ID = "pilot-microgrid";
    process.env.MGM_OPENEMS_URL = "https://pilot-openems.example.test";
    delete process.env.MGM_OPENEMS_USERNAME;
    delete process.env.MGM_OPENEMS_PASSWORD;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(provider().getDeviceEnergySeries(seriesRequest({ microgridId: "other-microgrid" })))
      .rejects.toMatchObject({ code: "METERING_CONFIGURATION", statusCode: 403 });
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the pilot environment configuration for its bound microgrid", async () => {
    process.env.MGM_OPENEMS_MICROGRID_ID = "pilot-microgrid";
    process.env.MGM_OPENEMS_URL = "https://pilot-openems.example.test";
    process.env.MGM_OPENEMS_USERNAME = "readonly-user";
    process.env.MGM_OPENEMS_PASSWORD = "readonly-password";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ timestamps: [K0], data: { [METER0]: [42] } })
    );

    const series = await provider().getDeviceEnergySeries(seriesRequest({ microgridId: "pilot-microgrid" }));

    expect(series.kwh["dev-1"][0]).toBe(0.042);
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][0]).toBe("https://pilot-openems.example.test/jsonrpc");
  });
});
