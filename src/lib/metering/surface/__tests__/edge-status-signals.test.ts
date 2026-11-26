/**
 * The `metering.edge-status` watcher: one read of the organization's
 * microgrids with a backend and edges, through the person's own client;
 * none of them means no composition and no backend read; composeMetering
 * runs before any stored configuration is read, and a refusal (metering off,
 * a session Auth has ended) throws before one; a microgrid with a gateway
 * offline, or whose read failed, is a signal with fixed copy, one with all
 * online is none; every configured microgrid up to the bound is examined
 * and a read that reaches the bound throws; at most MAX_SIGNALS_PER_SOURCE
 * signals go back, offline ones first; a failed database read throws
 * without its message. Meters on online gateways with no recent reading
 * are a signal of their own, as is a meter read that failed; a meter on an
 * offline gateway, a battery or an inverter is not asked about.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];
const composeMetering = vi.fn();
const dispose = vi.fn(async () => {});
const getMicrogridEmsConfig = vi.fn();
const getEdgesStatus = vi.fn();
const queryHistoricSamples = vi.fn();
vi.mock("../../compose", () => ({
  composeMetering: (...a: unknown[]) => {
    order.push("compose");
    return composeMetering(...a);
  },
}));
vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: (...a: unknown[]) => {
    order.push("config");
    return getMicrogridEmsConfig(...a);
  },
}));
vi.mock("@/lib/openems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openems")>();
  return {
    ...actual,
    createOpenEmsClient: () => ({
      getEdgesStatus: (...a: unknown[]) => getEdgesStatus(...a),
      queryHistoricSamples: (...a: unknown[]) => queryHistoricSamples(...a),
    }),
  };
});

import { createFmt } from "@/lib/gui/fmt";
import { managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import { signalOutSchema } from "@/lib/gui/host/server/model-schema";
import { MAX_SIGNALS_PER_SOURCE, type SurfaceRequest } from "@/lib/gui/surface";
import { OpenEmsError } from "@/lib/openems";
import { _resetEdgeStatusCacheForTests, EDGE_STATUS_READ_TIMEOUT_MS } from "../../infrastructure/edge-status-cache";
import { EDGE_STATUS_BUDGET_MS, EDGE_STATUS_MICROGRID_BOUND, loadEdgeStatusSignals } from "../edge-status-signals";
import { EDGE_STATUS_EXAMPLES } from "../edge-status-signals-examples";
import { buildEdgeStatusSignals, type EdgeStatusMicrogrid } from "../edge-status-signals-model";

const ORG = "e7f50000-0000-4000-8000-000000000001";
const NORTH = "e7f50000-0000-4000-8000-0000000000a1";
const SOUTH = "e7f50000-0000-4000-8000-0000000000a2";
const EAST = "e7f50000-0000-4000-8000-0000000000a3";
const SECRET = "permission denied for table microgrids";
const VENDOR_TEXT = "403 from the backend canary-2b7e";
const NOW = new Date("2026-11-25T09:00:00Z");
const fmt = createFmt({ locale: "en-GB" });

const req = (client: SupabaseClient): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e7f50000-0000-4000-8fff-000000000001" } as User,
    roles: [managerOf(ORG)],
    organizationId: ORG,
    params: {},
    search: new URLSearchParams(),
    locale: "en-GB",
    now: NOW,
    fmt,
  }) as unknown as SurfaceRequest;

type Device = { openems_component_id: string | null; device_type: string };
const row = (id: string, name: string, edges: string[], devices: Record<string, Device[]> = {}) => ({
  id,
  name,
  timezone: "Africa/Kampala",
  communities: { org_id: ORG },
  edges: edges.map((e) => ({ openems_edge_id: e, devices: devices[e] ?? [] })),
});
const meter = (component: string, type = "consumption_meter"): Device => ({ openems_component_id: component, device_type: type });
/** Five-minute samples up to NOW, the last value of each channel at `lastAt` (or none). */
const samples = (channels: string[], lastAt: Record<string, string | null>) => {
  const timestamps = Array.from({ length: 24 }, (_, i) => new Date(NOW.getTime() - (23 - i) * 300_000).toISOString());
  return {
    timestamps,
    data: Object.fromEntries(channels.map((c) => [c, timestamps.map((t) => (lastAt[c] !== null && lastAt[c] !== undefined && t <= lastAt[c]! ? 120 : null))])),
  };
};

beforeEach(() => {
  order.length = 0;
  _resetEdgeStatusCacheForTests();
  composeMetering.mockReset().mockResolvedValue({ ok: true, data: { scope: { organizationId: ORG, userId: "u", roles: [] }, metering: {}, dispose } });
  dispose.mockClear();
  getMicrogridEmsConfig.mockReset().mockResolvedValue({ type: "direct_url", url: "https://ems.example.test/rest" });
  getEdgesStatus.mockReset();
  queryHistoricSamples.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("loadEdgeStatusSignals", () => {
  it("reads the organization's microgrids with a backend and edges, composes metering, then asks the backend", async () => {
    const { client, calls } = tableClient({ microgrids: { data: [row(NORTH, "North site", ["edge0", "edge1"]), row(SOUTH, "South site", ["edge2"])] } });
    getEdgesStatus.mockImplementation(async (ids: string[]) => ids.map((edgeId) => ({ edgeId, online: edgeId !== "edge1" })));
    const out = await loadEdgeStatusSignals(req(client));
    expect(calls).toEqual([
      {
        table: "microgrids",
        ops: [
          ["select", ["id, name, timezone, communities!inner(org_id), edges!inner(openems_edge_id, devices(openems_component_id, device_type))"]],
          ["eq", ["communities.org_id", ORG]],
          ["not", ["ems_type", "is", null]],
          ["order", ["name", { ascending: true }]],
          ["order", ["id", { ascending: true }]],
          ["limit", [EDGE_STATUS_MICROGRID_BOUND + 1]],
        ],
      },
    ]);
    expect(composeMetering).toHaveBeenCalledWith({ supabase: client, organizationId: ORG });
    expect(order).toEqual(["compose", "config", "config"]);
    expect(getMicrogridEmsConfig).toHaveBeenCalledWith(client, NORTH);
    expect(out.map((s) => [s.id, s.severity, s.title, s.href])).toEqual([
      [`offline:${NORTH}`, "warn", "North site: 1 gateway offline", `/microgrids/${NORTH}/setup/edges`],
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports meters on an online gateway with no reading for half an hour, and asks only about meters, reading the configuration once", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const devices = {
        edge0: [meter("meter0"), meter("meter1", "grid_meter"), meter("ess0", "battery"), meter("inv0", "inverter"), meter(null as unknown as string)],
        edge1: [meter("meter2")],
      };
      const { client } = tableClient({ microgrids: { data: [row(NORTH, "North site", ["edge0", "edge1"], devices)] } });
      getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: true }, { edgeId: "edge1", online: false }]);
      queryHistoricSamples.mockImplementation(async (edgeId: string, channels: string[]) =>
        samples(channels, edgeId === "edge0" ? { "meter0/ActivePower": "2026-11-25T08:20:00.000Z", "meter1/ActivePower": "2026-11-25T08:55:00.000Z" } : {}),
      );
      const out = await loadEdgeStatusSignals(req(client));
      expect(out.map((s) => [s.id, s.title, s.href])).toEqual([
        [`offline:${NORTH}`, "North site: 1 gateway offline", `/microgrids/${NORTH}/setup/edges`],
        [`quiet:${NORTH}`, "North site: 1 meter not reporting", `/microgrids/${NORTH}/setup/edges`],
      ]);
      expect(queryHistoricSamples).toHaveBeenCalledWith("edge0", ["meter0/ActivePower", "meter1/ActivePower"], "2026-11-25", "2026-11-25", "UTC", 5, { signal: expect.any(AbortSignal) });
      expect(order).toEqual(["compose", "config"]);
      for (const leaked of ["meter0", "edge0"]) expect(JSON.stringify(out)).not.toContain(leaked);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a meter read that failed as meters not checked, without the backend's text, and the gateways still", async () => {
    const { client } = tableClient({ microgrids: { data: [row(NORTH, "North site", ["edge0"], { edge0: [meter("meter0")] })] } });
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: true }]);
    queryHistoricSamples.mockRejectedValue(new OpenEmsError(VENDOR_TEXT, "OPENEMS_HTTP_ERROR", 502));
    const out = await loadEdgeStatusSignals(req(client));
    expect(out.map((s) => [s.id, s.title, s.href])).toEqual([
      [`unchecked:${NORTH}`, "North site: meter readings could not be checked", `/microgrids/${NORTH}/setup/openems-backend`],
    ]);
    expect(JSON.stringify(out)).not.toContain("canary");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain("metering.meter_activity_edge_failed");
  });

  it("asks no meter history of a microgrid whose meters are all on offline gateways, and reports no meter then", async () => {
    const { client } = tableClient({ microgrids: { data: [row(NORTH, "North site", ["edge0"], { edge0: [meter("meter0")] })] } });
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: false }]);
    queryHistoricSamples.mockResolvedValue(samples(["meter0/ActivePower"], {}));
    const out = await loadEdgeStatusSignals(req(client));
    expect(out.map((s) => s.id)).toEqual([`offline:${NORTH}`]);
  });

  it("composes nothing and asks no backend when no microgrid has a backend with edges", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client } = tableClient({ microgrids: { data: [] } });
    expect(await loadEdgeStatusSignals(req(client))).toEqual([]);
    expect(composeMetering).not.toHaveBeenCalled();
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["metering is off", { ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled" }],
    ["the session has ended", { ok: false, status: 401, code: "metering_unauthenticated", message: "Authentication required." }],
    ["the person has no access", { ok: false, status: 403, code: "metering_forbidden", message: "Not authorized" }],
  ])("throws, before any stored configuration is read, when %s", async (_why, refusal) => {
    composeMetering.mockResolvedValue(refusal);
    const { client } = tableClient({ microgrids: { data: [row(NORTH, "North site", ["edge0"])] } });
    await expect(loadEdgeStatusSignals(req(client))).rejects.toThrow(`metering.edge-status: the capability could not be composed (${refusal.status})`);
    expect(getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(getEdgesStatus).not.toHaveBeenCalled();
  });

  it("reports a microgrid whose read failed as not read, with fixed copy, and still reports the others", async () => {
    getMicrogridEmsConfig.mockImplementation(async (_c: unknown, id: string) => {
      if (id === SOUTH) throw new OpenEmsError(VENDOR_TEXT, "OPENEMS_FORBIDDEN", 403);
      return { type: "direct_url", url: "https://ems.example.test/rest" };
    });
    getEdgesStatus.mockResolvedValue([]);
    const { client } = tableClient({ microgrids: { data: [row(NORTH, "North site", ["edge0", "edge1"]), row(SOUTH, "South site", ["edge2"])] } });
    const out = await loadEdgeStatusSignals(req(client));
    expect(out.map((s) => [s.id, s.title, s.href])).toEqual([
      [`offline:${NORTH}`, "North site: 2 gateways offline", `/microgrids/${NORTH}/setup/edges`],
      [`unread:${SOUTH}`, "South site: gateway status could not be read", `/microgrids/${SOUTH}/setup/openems-backend`],
    ]);
    const text = JSON.stringify(out);
    for (const leaked of ["canary", "edge0", "edge2", "ems.example.test"]) expect(text).not.toContain(leaked);
  });

  it("reports a backend that does not answer within the read's timeout as not read, within the watcher's budget", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      getEdgesStatus.mockReturnValue(new Promise(() => {}));
      const { client } = tableClient({ microgrids: { data: [row(EAST, "East site", ["edge0"])] } });
      const pending = loadEdgeStatusSignals(req(client));
      await vi.advanceTimersByTimeAsync(EDGE_STATUS_READ_TIMEOUT_MS);
      const out = await pending;
      expect(EDGE_STATUS_READ_TIMEOUT_MS).toBeLessThan(EDGE_STATUS_BUDGET_MS);
      expect(out.map((s) => s.title)).toEqual(["East site: gateway status could not be read"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves a second load from the cache, with no second backend read", async () => {
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: false }]);
    const { client } = tableClient({ microgrids: { data: [row(NORTH, "North site", ["edge0"])] } });
    const first = await loadEdgeStatusSignals(req(client));
    const second = await loadEdgeStatusSignals(req(client));
    expect(second).toEqual(first);
    expect(getEdgesStatus).toHaveBeenCalledTimes(1);
    // The session and organization are still checked on every load.
    expect(composeMetering).toHaveBeenCalledTimes(2);
  });

  it(`examines every microgrid, past the ${MAX_SIGNALS_PER_SOURCE}th, and returns at most ${MAX_SIGNALS_PER_SOURCE} signals, offline ones first`, async () => {
    const count = MAX_SIGNALS_PER_SOURCE + 10;
    const name = (i: number) => `Site ${String(i).padStart(3, "0")}`;
    // Every site but the last fails to be read; the last, past the 50th by name, has its gateway offline.
    const rows = Array.from({ length: count }, (_, i) => row(`mg-${i}`, name(i), [`edge-${i}`]));
    getMicrogridEmsConfig.mockImplementation(async (_c: unknown, id: string) => {
      if (id !== `mg-${count - 1}`) throw new OpenEmsError(VENDOR_TEXT, "OPENEMS_UNREACHABLE", 503);
      return { type: "direct_url", url: "https://ems.example.test/rest" };
    });
    getEdgesStatus.mockResolvedValue([]);
    const { client } = tableClient({ microgrids: { data: rows } });
    const out = await loadEdgeStatusSignals(req(client));
    expect(getMicrogridEmsConfig).toHaveBeenCalledTimes(count);
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(out[0]).toMatchObject({ id: `offline:mg-${count - 1}`, title: `${name(count - 1)}: 1 gateway offline` });
    expect(out.slice(1).every((s) => s.id.startsWith("unread:"))).toBe(true);
  });

  it(`throws, so the watcher is unchecked, when the read reaches ${EDGE_STATUS_MICROGRID_BOUND} microgrids`, async () => {
    const rows = Array.from({ length: EDGE_STATUS_MICROGRID_BOUND + 1 }, (_, i) => row(`mg-${i}`, `Site ${i}`, ["edge0"]));
    const { client } = tableClient({ microgrids: { data: rows } });
    await expect(loadEdgeStatusSignals(req(client))).rejects.toThrow("metering.edge-status: too many microgrids to examine");
    expect(composeMetering).not.toHaveBeenCalled();
    const { client: atBound } = tableClient({ microgrids: { data: rows.slice(0, EDGE_STATUS_MICROGRID_BOUND) } });
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: true }]);
    await expect(loadEdgeStatusSignals(req(atBound))).resolves.toEqual([]);
  });

  it("throws on a failed read of the microgrids, without the database's message", async () => {
    const { client } = tableClient({ microgrids: { data: null, error: { message: SECRET } } });
    const failed = loadEdgeStatusSignals(req(client));
    await expect(failed).rejects.toThrow("metering.edge-status: the microgrids could not be read");
    await expect(failed).rejects.not.toThrow(SECRET);
    expect(composeMetering).not.toHaveBeenCalled();
  });
});

describe("buildEdgeStatusSignals", () => {
  const north: EdgeStatusMicrogrid = { id: NORTH, name: "North site", timezone: "Africa/Kampala" };

  it("says how many gateways are offline, with when the backend answered, in the microgrid's zone", () => {
    expect(buildEdgeStatusSignals(fmt, [north], [{ microgridId: NORTH, state: "read", total: 3, offline: 3, readAt: "2026-11-25T08:58:00.000Z" }], NOW)).toEqual([
      {
        id: `offline:${NORTH}`,
        kind: "alarm",
        severity: "warn",
        title: "North site: 3 gateways offline",
        facts: [fmt.datetime("2026-11-25T08:58:00.000Z", "Africa/Kampala")],
        entity: { kind: "microgrid", id: NORTH, label: "North site" },
        href: `/microgrids/${NORTH}/setup/edges`,
        at: "2026-11-25T08:58:00.000Z",
      },
    ]);
  });

  it("leaves out a microgrid with every gateway online, or with no outcome", () => {
    const south: EdgeStatusMicrogrid = { id: SOUTH, name: "South site", timezone: null };
    expect(buildEdgeStatusSignals(fmt, [north, south], [{ microgridId: NORTH, state: "read", total: 2, offline: 0, readAt: NOW.toISOString() }], NOW)).toEqual([]);
  });

  it("reports one not read in time as not read, dated now with no fact, and reads an unknown zone as UTC", () => {
    const [late] = buildEdgeStatusSignals(fmt, [north], [{ microgridId: NORTH, state: "late" }], NOW);
    expect(late).toMatchObject({ id: `unread:${NORTH}`, title: "North site: gateway status could not be read", at: NOW.toISOString() });
    expect(late).not.toHaveProperty("facts");
    const [failed] = buildEdgeStatusSignals(fmt, [{ ...north, timezone: "Kampala" }], [{ microgridId: NORTH, state: "failed", readAt: "2026-11-25T08:59:00.000Z" }], NOW);
    expect(failed.facts).toEqual([fmt.datetime("2026-11-25T08:59:00.000Z", "UTC")]);
  });

  it(`keeps offline gateways ahead of unread sites when it stops at ${MAX_SIGNALS_PER_SOURCE}`, () => {
    const sites = Array.from({ length: MAX_SIGNALS_PER_SOURCE + 2 }, (_, i) => ({ id: `m${i}`, name: `Site ${String(i).padStart(3, "0")}`, timezone: null }));
    const outcomes = sites.map((m, i) =>
      i >= MAX_SIGNALS_PER_SOURCE ? { microgridId: m.id, state: "read" as const, total: 1, offline: 1, readAt: NOW.toISOString() } : { microgridId: m.id, state: "late" as const },
    );
    const out = buildEdgeStatusSignals(fmt, sites, outcomes, NOW);
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(out.slice(0, 2).map((s) => s.title)).toEqual(sites.slice(MAX_SIGNALS_PER_SOURCE).map((m) => `${m.name}: 1 gateway offline`));
    expect(out.slice(2).map((s) => s.title)).toEqual(sites.slice(0, MAX_SIGNALS_PER_SOURCE - 2).map((m) => `${m.name}: gateway status could not be read`));
  });

  it(`lists microgrids by name and stops at ${MAX_SIGNALS_PER_SOURCE}`, () => {
    const many = Array.from({ length: MAX_SIGNALS_PER_SOURCE + 3 }, (_, i) => ({ id: `m${i}`, name: `Site ${String(MAX_SIGNALS_PER_SOURCE + 3 - i).padStart(3, "0")}`, timezone: null }));
    const out = buildEdgeStatusSignals(fmt, many, many.map((m) => ({ microgridId: m.id, state: "late" as const })), NOW);
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(out[0].title).toBe("Site 001: gateway status could not be read");
  });

  it("says how many meters on online gateways are not reporting, or that they could not be checked, and nothing for a meter read with no answer yet", () => {
    const read = (meters: object) => [{ microgridId: NORTH, state: "read" as const, total: 1, offline: 0, readAt: "2026-11-25T08:58:00.000Z", meters } as never];
    expect(buildEdgeStatusSignals(fmt, [north], read({ state: "read", total: 9, quiet: 2, readAt: "2026-11-25T08:57:00.000Z" }), NOW)).toEqual([
      {
        id: `quiet:${NORTH}`,
        kind: "alarm",
        severity: "warn",
        title: "North site: 2 meters not reporting",
        facts: [fmt.datetime("2026-11-25T08:57:00.000Z", "Africa/Kampala")],
        entity: { kind: "microgrid", id: NORTH, label: "North site" },
        href: `/microgrids/${NORTH}/setup/edges`,
        at: "2026-11-25T08:57:00.000Z",
      },
    ]);
    expect(buildEdgeStatusSignals(fmt, [north], read({ state: "read", total: 9, quiet: 0, readAt: NOW.toISOString() }), NOW)).toEqual([]);
    expect(buildEdgeStatusSignals(fmt, [north], read({ state: "late" }), NOW)).toEqual([]);
    expect(buildEdgeStatusSignals(fmt, [north], read({ state: "failed", readAt: NOW.toISOString() }), NOW).map((s) => [s.id, s.title])).toEqual([
      [`unchecked:${NORTH}`, "North site: meter readings could not be checked"],
    ]);
  });

  it("orders offline gateways, quiet meters, unread status, then unchecked meters, each by name", () => {
    const sites = ["A", "B", "C", "D"].map((n, i) => ({ id: `m${i}`, name: `Site ${n}`, timezone: null }));
    const at = NOW.toISOString();
    const out = buildEdgeStatusSignals(
      fmt,
      sites,
      [
        { microgridId: "m0", state: "read", total: 1, offline: 0, readAt: at, meters: { state: "failed", readAt: at } },
        { microgridId: "m1", state: "late" },
        { microgridId: "m2", state: "read", total: 2, offline: 1, readAt: at, meters: { state: "read", total: 3, quiet: 1, readAt: at } },
        { microgridId: "m3", state: "read", total: 1, offline: 0, readAt: at, meters: { state: "read", total: 3, quiet: 3, readAt: at } },
      ],
      NOW,
    );
    expect(out.map((s) => s.id)).toEqual(["offline:m2", "quiet:m2", "quiet:m3", "unread:m1", "unchecked:m0"]);
  });

  it("returns signals a watcher may send, as the examples are", () => {
    const built = buildEdgeStatusSignals(fmt, [north], [{ microgridId: NORTH, state: "read", total: 1, offline: 1, readAt: NOW.toISOString() }], NOW);
    for (const s of [...built, ...EDGE_STATUS_EXAMPLES]) expect(signalOutSchema.safeParse(s).success).toBe(true);
    expect(EDGE_STATUS_EXAMPLES.map((s) => s.title)).toEqual([
      "Kiwumu: 2 gateways offline",
      "Namulonge: 1 meter not reporting",
      "Lwamata: gateway status could not be read",
    ]);
  });
});
