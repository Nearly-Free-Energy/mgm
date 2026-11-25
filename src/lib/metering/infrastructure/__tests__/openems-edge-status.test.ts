/**
 * The OpenEMS edge-status reader: one outcome per microgrid in order; at
 * most EDGE_STATUS_CONCURRENCY microgrids read at once; a microgrid's read
 * builds a client from its stored configuration through the person's own
 * client and asks getEdgesStatus with the read's signal; a failure is the
 * microgrid's outcome, logged with an MGM code and never the backend's text.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMicrogridEmsConfig = vi.fn();
const getEdgesStatus = vi.fn();
vi.mock("@/lib/openems/config", () => ({ getMicrogridEmsConfig: (...a: unknown[]) => getMicrogridEmsConfig(...a) }));
vi.mock("@/lib/openems", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openems")>();
  return { ...actual, createOpenEmsClient: () => ({ getEdgesStatus: (...a: unknown[]) => getEdgesStatus(...a) }) };
});

import { OpenEmsError } from "@/lib/openems";
import type { MeteringComposition } from "../../compose";
import { _resetEdgeStatusCacheForTests, type EdgeStatusRead } from "../edge-status-cache";
import { EDGE_STATUS_CONCURRENCY, createEdgeStatusReader, openEmsEdgeStatusRead } from "../openems-edge-status";

const ORG = "e7f40000-0000-4000-8000-000000000001";
const supabase = { marker: "person's client" } as unknown as SupabaseClient;
const composition = { scope: { organizationId: ORG, userId: "u", roles: [] }, metering: {}, dispose: async () => {} } as unknown as MeteringComposition;
const later = () => Date.now() + 60_000;

beforeEach(() => {
  _resetEdgeStatusCacheForTests();
  getMicrogridEmsConfig.mockReset();
  getEdgesStatus.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("openEmsEdgeStatusRead", () => {
  it("builds the client from the microgrid's stored configuration on the person's client, and passes the edges and the signal", async () => {
    getMicrogridEmsConfig.mockResolvedValue({ type: "direct_url", url: "https://ems.example.test/rest" });
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: true }]);
    const signal = new AbortController().signal;
    expect(await openEmsEdgeStatusRead(supabase, "mg1", ["edge0", "edge1"])(signal)).toEqual([{ edgeId: "edge0", online: true }]);
    expect(getMicrogridEmsConfig).toHaveBeenCalledWith(supabase, "mg1");
    expect(getEdgesStatus).toHaveBeenCalledWith(["edge0", "edge1"], { signal });
  });

  it("fails when the microgrid has no configuration now, or the signal ended while it was read", async () => {
    getMicrogridEmsConfig.mockResolvedValueOnce(null);
    await expect(openEmsEdgeStatusRead(supabase, "mg1", ["edge0"])(new AbortController().signal)).rejects.toThrow();
    getMicrogridEmsConfig.mockResolvedValueOnce({ type: "direct_url", url: "https://ems.example.test/rest" });
    const ended = new AbortController();
    ended.abort();
    await expect(openEmsEdgeStatusRead(supabase, "mg1", ["edge0"])(ended.signal)).rejects.toThrow();
    expect(getEdgesStatus).not.toHaveBeenCalled();
  });
});

describe("createEdgeStatusReader", () => {
  it("answers each microgrid in order: read, or failed without the backend's text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getMicrogridEmsConfig.mockImplementation(async (_c: unknown, id: string) => {
      if (id === "bad") throw new OpenEmsError("401 from keycloak canary-91c2", "OPENEMS_AUTH_FAILED", 401);
      return { type: "direct_url", url: "https://ems.example.test/rest" };
    });
    getEdgesStatus.mockResolvedValue([{ edgeId: "edge0", online: false }, { edgeId: "edge1", online: true }]);
    const out = await createEdgeStatusReader(composition, supabase).getEdgeStatuses(
      [
        { microgridId: "good", edgeIds: ["edge0", "edge1"] },
        { microgridId: "bad", edgeIds: ["edge0"] },
      ],
      later(),
    );
    expect(out).toEqual([
      { microgridId: "good", state: "read", total: 2, offline: 1, readAt: expect.any(String) },
      { microgridId: "bad", state: "failed", readAt: expect.any(String) },
    ]);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain("OPENEMS_AUTH_FAILED");
    expect(logged).not.toContain("canary");
    expect(JSON.stringify(out)).not.toContain("canary");
  });

  it(`reads at most ${EDGE_STATUS_CONCURRENCY} microgrids at once`, async () => {
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const read = vi.fn(() => async (): Promise<EdgeStatusRead> => {
      running++;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
      return [];
    });
    const sites = Array.from({ length: EDGE_STATUS_CONCURRENCY * 2 + 1 }, (_, i) => ({ microgridId: `mg${i}`, edgeIds: ["edge0"] }));
    const pending = createEdgeStatusReader(composition, supabase, { read }).getEdgeStatuses(sites, later());
    while (read.mock.calls.length < sites.length || releases.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.splice(0).forEach((release) => release());
    }
    const out = await pending;
    expect(most).toBe(EDGE_STATUS_CONCURRENCY);
    expect(out.map((o) => [o.microgridId, o.state])).toEqual(sites.map((s) => [s.microgridId, "read"]));
  });

  it("answers late, with no read, a microgrid whose turn comes too close to the deadline", async () => {
    const backend = vi.fn(async (): Promise<EdgeStatusRead> => []);
    const out = await createEdgeStatusReader(composition, supabase, { read: () => backend }).getEdgeStatuses(
      [{ microgridId: "mg", edgeIds: ["edge0"] }],
      Date.now() + 100,
    );
    expect(out).toEqual([{ microgridId: "mg", state: "late" }]);
    expect(backend).not.toHaveBeenCalled();
  });
});
