/**
 * The `metering.connection` watcher: one read of the organization's
 * configured microgrids whose last OpenEMS check failed, through the
 * person's own client, with no vendor call; one signal per microgrid with
 * fixed copy, never the stored error text; a failed read throws without the
 * database's message.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import { signalOutSchema } from "@/lib/gui/host/server/model-schema";
import { MAX_SIGNALS_PER_SOURCE, type SurfaceRequest } from "@/lib/gui/surface";
import { loadConnectionSignals } from "../connection-signals";
import { CONNECTION_EXAMPLES } from "../connection-signals-examples";
import { buildConnectionSignals, type ConnectionInput } from "../connection-signals-model";

const ORG = "e7f20000-0000-4000-8000-000000000001";
const MG = "e7f20000-0000-4000-8000-0000000000a1";
const SECRET = "permission denied for table microgrids";
const VENDOR_TEXT = "401 Unauthorized from keycloak canary-7f3a";
const NOW = new Date("2026-11-20T09:00:00Z");
const fmt = createFmt({ locale: "en-GB" });

const req = (client: SupabaseClient): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e7f20000-0000-4000-8fff-000000000001" } as User,
    roles: [managerOf(ORG)],
    organizationId: ORG,
    params: {},
    search: new URLSearchParams(),
    locale: "en-GB",
    now: NOW,
    fmt,
  }) as unknown as SurfaceRequest;

const microgrid = (over: Partial<ConnectionInput> = {}): ConnectionInput => ({
  id: MG,
  name: "North site",
  timezone: "Africa/Kampala",
  emsType: "cloud_aws",
  status: "auth_failed",
  checkedAt: "2026-11-19T06:15:00Z",
  ...over,
});

describe("loadConnectionSignals", () => {
  it("reads the organization's configured microgrids whose last check failed, and calls nothing else", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { client, calls } = tableClient({
      microgrids: {
        data: [{ id: MG, name: "North site", timezone: "Africa/Kampala", ems_type: "direct_url", ems_last_discover_status: "unreachable", ems_last_discover_at: "2026-11-19T06:15:00Z", ems_last_discover_error: VENDOR_TEXT }],
      },
    });
    const out = await loadConnectionSignals(req(client));
    expect(calls).toEqual([
      {
        table: "microgrids",
        ops: [
          ["select", ["id, name, timezone, ems_type, ems_last_discover_status, ems_last_discover_at, communities!inner(org_id)"]],
          ["eq", ["communities.org_id", ORG]],
          ["not", ["ems_type", "is", null]],
          ["in", ["ems_last_discover_status", ["auth_failed", "unreachable", "zero_edges", "unknown_error"]]],
          ["order", ["name", { ascending: true }]],
          ["order", ["id", { ascending: true }]],
          ["limit", [MAX_SIGNALS_PER_SOURCE]],
        ],
      },
    ]);
    expect(out.map((s) => [s.title, s.href])).toEqual([["North site: OpenEMS could not be reached", `/microgrids/${MG}/setup/openems-backend`]]);
    expect(JSON.stringify(out)).not.toContain("canary-7f3a");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("throws on a failed read, without the database's message", async () => {
    const { client } = tableClient({ microgrids: { data: null, error: { message: SECRET } } });
    const failed = loadConnectionSignals(req(client));
    await expect(failed).rejects.toThrow("metering.connection: the microgrids could not be read");
    await expect(failed).rejects.not.toThrow(SECRET);
  });
});

describe("buildConnectionSignals", () => {
  it("says what the last check found, with when, in the microgrid's zone", () => {
    expect(buildConnectionSignals(fmt, [microgrid()], NOW)).toEqual([
      {
        id: MG,
        kind: "alarm",
        severity: "warn",
        title: "North site: OpenEMS refused the saved sign-in",
        facts: [fmt.datetime("2026-11-19T06:15:00.000Z", "Africa/Kampala")],
        entity: { kind: "microgrid", id: MG, label: "North site" },
        href: `/microgrids/${MG}/setup/openems-backend`,
        at: "2026-11-19T06:15:00.000Z",
      },
    ]);
  });

  it.each([
    ["auth_failed", "North site: OpenEMS refused the saved sign-in"],
    ["unreachable", "North site: OpenEMS could not be reached"],
    ["zero_edges", "North site: OpenEMS lists no edges"],
    ["unknown_error", "North site: the OpenEMS connection check failed"],
  ])("words %s as fixed copy", (status, title) => {
    expect(buildConnectionSignals(fmt, [microgrid({ status })], NOW).map((s) => s.title)).toEqual([title]);
  });

  it("leaves out a healthy check, no check, and a microgrid with no backend", () => {
    const out = buildConnectionSignals(
      fmt,
      [microgrid({ id: "ok", status: "success" }), microgrid({ id: "never", status: null }), microgrid({ id: "none", emsType: null })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("dates a failure with no recorded time now, without a fact, and reads an unknown zone as UTC", () => {
    const [undated] = buildConnectionSignals(fmt, [microgrid({ checkedAt: null })], NOW);
    expect(undated).toMatchObject({ at: NOW.toISOString() });
    expect(undated).not.toHaveProperty("facts");
    const [utc] = buildConnectionSignals(fmt, [microgrid({ timezone: "Kampala" })], NOW);
    expect(utc.facts).toEqual([fmt.datetime("2026-11-19T06:15:00.000Z", "UTC")]);
  });

  it(`lists microgrids by name and stops at ${MAX_SIGNALS_PER_SOURCE}`, () => {
    const many = Array.from({ length: MAX_SIGNALS_PER_SOURCE + 3 }, (_, i) => microgrid({ id: `m${i}`, name: `Site ${String(MAX_SIGNALS_PER_SOURCE + 3 - i).padStart(3, "0")}` }));
    const out = buildConnectionSignals(fmt, many, NOW);
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(out[0].title).toBe("Site 001: OpenEMS refused the saved sign-in");
  });

  it("returns signals a watcher may send, as the examples are", () => {
    for (const s of [...buildConnectionSignals(fmt, [microgrid()], NOW), ...CONNECTION_EXAMPLES]) {
      expect(signalOutSchema.safeParse(s).success).toBe(true);
    }
    expect(CONNECTION_EXAMPLES.map((s) => s.title)).toEqual(["Kiwumu: OpenEMS refused the saved sign-in", "Lwamata: OpenEMS could not be reached"]);
  });
});
