/**
 * The meter read: a meter is quiet when its power history has no value in
 * any five-minute bin overlapping the last half hour, whichever end of the
 * bin OpenEMS stamps; one request per edge, with every one of its meters;
 * a channel without history is quiet, the others still answer, and it is
 * asked about alone next time until it answers; an edge whose request fails
 * or whose history MGM cannot read is a failed edge, the others still
 * count; too many meters fail the read; the dates asked for reach back to
 * the previous UTC day when the window does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenEmsError } from "@/lib/openems";
import { _resetNoHistoryForTests, METER_QUIET_AFTER_MS, METERS_PER_MICROGRID_BOUND, readMeterActivity, reportedSince } from "../meter-activity";

beforeEach(() => _resetNoHistoryForTests());
const MG = "mg1";

const NOW = Date.parse("2026-11-25T09:00:00Z");
const signal = new AbortController().signal;
const bins = (n: number, endMs = NOW) => Array.from({ length: n }, (_, i) => new Date(endMs - (n - 1 - i) * 300_000).toISOString());
const noHistory = () => new OpenEmsError("Energy values are not available for query", "OPENEMS_HTTP_ERROR", 400, { status: 400 });

describe("reportedSince", () => {
  const since = NOW - METER_QUIET_AFTER_MS;

  it("counts a value in a bin stamped from one bin before the window, and nothing older", () => {
    const timestamps = bins(12);
    const at = (iso: string) => ({ timestamps, data: { c: timestamps.map((t) => (t === iso ? 5 : null)) } });
    expect(reportedSince(at("2026-11-25T08:25:00.000Z"), "c", since)).toBe(true);
    expect(reportedSince(at("2026-11-25T08:20:00.000Z"), "c", since)).toBe(false);
    expect(reportedSince({ timestamps, data: { c: timestamps.map(() => 0) } }, "c", since)).toBe(true);
    expect(reportedSince({ timestamps, data: {} }, "c", since)).toBe(false);
  });

  it("reads epoch seconds and zoned instants as OpenEMS sends them", () => {
    expect(reportedSince({ timestamps: [Math.floor(NOW / 1000)], data: { c: [1] } }, "c", since)).toBe(true);
    expect(reportedSince({ timestamps: ["2026-11-25T11:55:00+03:00[Africa/Kampala]"], data: { c: [1] } }, "c", since)).toBe(true);
  });

  it("throws on no bins, or on mostly unreadable instants, rather than call the meter quiet", () => {
    expect(() => reportedSince({ timestamps: [], data: { c: [] } }, "c", since)).toThrow();
    expect(() => reportedSince({ timestamps: ["yesterday", "today", NOW], data: { c: [1, 1, 1] } }, "c", since)).toThrow();
  });
});

describe("readMeterActivity", () => {
  it("asks once per edge for its meters' power, and names the quiet ones", async () => {
    const query = vi.fn(async (edgeId: string, channels: string[]) => {
      const timestamps = bins(6);
      return { timestamps, data: Object.fromEntries(channels.map((c) => [c, timestamps.map(() => (c === "meter1/ActivePower" || edgeId === "edge9" ? null : 1))])) };
    });
    const out = await readMeterActivity(
      { queryHistoricSamples: query },
      MG,
      [
        { edgeId: "edge0", componentId: "meter0" },
        { edgeId: "edge0", componentId: "meter1" },
        { edgeId: "edge0", componentId: "meter0" },
        { edgeId: "edge9", componentId: "meter0" },
      ],
      NOW,
      signal,
    );
    expect(out.quiet).toEqual(expect.arrayContaining([{ edgeId: "edge0", componentId: "meter1" }, { edgeId: "edge9", componentId: "meter0" }]));
    expect(out.quiet).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith("edge0", ["meter0/ActivePower", "meter1/ActivePower"], "2026-11-25", "2026-11-25", "UTC", 5, { signal });
  });

  it("calls a meter whose channel has no history quiet, and still reads the others", async () => {
    const query = vi.fn(async (_edgeId: string, channels: string[]) => {
      if (channels.includes("meter1/ActivePower")) throw noHistory();
      return { timestamps: bins(2), data: { [channels[0]]: [1, 1] } };
    });
    const out = await readMeterActivity({ queryHistoricSamples: query }, MG, [{ edgeId: "e", componentId: "meter0" }, { edgeId: "e", componentId: "meter1" }], NOW, signal);
    expect(out).toEqual({ quiet: [{ edgeId: "e", componentId: "meter1" }], failedEdges: [] });
    expect(query).toHaveBeenCalledTimes(3);

    // Next time, the channel without history is asked about alone, beside the others' batch, with no refused batch first.
    query.mockClear();
    const again = await readMeterActivity({ queryHistoricSamples: query }, MG, [{ edgeId: "e", componentId: "meter0" }, { edgeId: "e", componentId: "meter1" }], NOW, signal);
    expect(again.quiet).toEqual([{ edgeId: "e", componentId: "meter1" }]);
    expect(query.mock.calls.map((c) => c[1])).toEqual([["meter0/ActivePower"], ["meter1/ActivePower"]]);

    // Once it answers, it is forgotten and reported again.
    query.mockImplementation(async (_e: string, channels: string[]) => ({ timestamps: bins(2), data: Object.fromEntries(channels.map((c) => [c, [1, 1]])) }));
    expect((await readMeterActivity({ queryHistoricSamples: query }, MG, [{ edgeId: "e", componentId: "meter1" }], NOW, signal)).quiet).toEqual([]);
    query.mockClear();
    await readMeterActivity({ queryHistoricSamples: query }, MG, [{ edgeId: "e", componentId: "meter0" }, { edgeId: "e", componentId: "meter1" }], NOW, signal);
    expect(query.mock.calls.map((c) => c[1])).toEqual([["meter0/ActivePower", "meter1/ActivePower"]]);
  });

  it("lists an edge whose request is refused, or whose answer cannot be read, as failed, and still reads the others", async () => {
    const query = vi.fn(async (edgeId: string, channels: string[]) => {
      if (edgeId === "gone") throw new OpenEmsError("backend text", "OPENEMS_HTTP_ERROR", 502, { status: 502 });
      if (edgeId === "garbled") return { timestamps: ["soon", "later"], data: { [channels[0]]: [1, 1] } };
      return { timestamps: bins(2), data: { [channels[0]]: [null, null] } };
    });
    const out = await readMeterActivity(
      { queryHistoricSamples: query },
      MG,
      ["gone", "garbled", "ok"].map((edgeId) => ({ edgeId, componentId: "meter0" })),
      NOW,
      signal,
    );
    expect(out.quiet).toEqual([{ edgeId: "ok", componentId: "meter0" }]);
    expect([...out.failedEdges].sort()).toEqual(["garbled", "gone"]);
  });

  it("fails on too many meters, before asking anything", async () => {
    const many = Array.from({ length: METERS_PER_MICROGRID_BOUND + 1 }, (_, i) => ({ edgeId: "e", componentId: `meter${i}` }));
    const query = vi.fn();
    await expect(readMeterActivity({ queryHistoricSamples: query }, MG, many, NOW, signal)).rejects.toThrow("too many meters");
    expect(query).not.toHaveBeenCalled();
  });

  it("asks from the previous UTC day when the window starts before midnight", async () => {
    const early = Date.parse("2026-11-25T00:20:00Z");
    const query = vi.fn(async (_e: string, channels: string[]) => ({ timestamps: bins(2, early), data: { [channels[0]]: [1, 1] } }));
    await readMeterActivity({ queryHistoricSamples: query }, MG, [{ edgeId: "e", componentId: "meter0" }], early, signal);
    expect(query).toHaveBeenCalledWith("e", ["meter0/ActivePower"], "2026-11-24", "2026-11-25", "UTC", 5, { signal });
  });
});
