// getManagedDevices and getMicrogridTimezone against a fake of the Supabase
// query builder: a failed read throws, so the capability refuses the read
// rather than taking it for a microgrid without devices or without a zone.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMeteringRepository } from "../supabase-repository";

type Answer = { data: unknown; error: { code?: string; message?: string } | null };

/** A query builder that records the tables read and resolves per table. */
function fakeSupabase(answers: Record<string, Answer>) {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      const answer = () => Promise.resolve(answers[table] ?? { data: [], error: null });
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in"]) builder[method] = () => builder;
      builder.maybeSingle = answer;
      builder.then = (resolve: (value: Answer) => unknown, reject: (e: unknown) => unknown) =>
        answer().then(resolve, reject);
      return builder;
    },
  };
  return { supabase: client as unknown as SupabaseClient, tables };
}

const ok = (data: unknown): Answer => ({ data, error: null });
const failed = (message: string, code?: string): Answer => ({ data: null, error: { code, message } });

describe("createSupabaseMeteringRepository.getManagedDevices", () => {
  it("maps each device to its edge's OpenEMS id", async () => {
    const { supabase } = fakeSupabase({
      edges: ok([{ id: "e-1", openems_edge_id: "edge0" }]),
      devices: ok([
        { id: "d-1", edge_id: "e-1", name: "Battery", device_type: "battery", openems_component_id: "ess0" },
        { id: "d-2", edge_id: "e-1", name: "Meter", device_type: "consumption_meter", openems_component_id: null },
      ]),
    });
    expect(await createSupabaseMeteringRepository(supabase).getManagedDevices("mg-1")).toEqual([
      { id: "d-1", name: "Battery", edgeId: "e-1", deviceType: "battery", edgeOpenemsId: "edge0", componentId: "ess0" },
      { id: "d-2", name: "Meter", edgeId: "e-1", deviceType: "consumption_meter", edgeOpenemsId: "edge0", componentId: "" },
    ]);
  });

  it("returns no devices for a microgrid without edges, and does not read devices", async () => {
    const { supabase, tables } = fakeSupabase({ edges: ok([]) });
    expect(await createSupabaseMeteringRepository(supabase).getManagedDevices("mg-1")).toEqual([]);
    expect(tables).toEqual(["edges"]);
  });

  it("throws when the edge read fails, rather than answering no devices", async () => {
    const { supabase, tables } = fakeSupabase({ edges: failed("permission denied", "42501") });
    await expect(createSupabaseMeteringRepository(supabase).getManagedDevices("mg-1")).rejects.toThrow(
      "Could not read edges: permission denied (42501)"
    );
    expect(tables).toEqual(["edges"]);
  });

  it("throws when the device read fails, rather than answering no devices", async () => {
    const { supabase } = fakeSupabase({
      edges: ok([{ id: "e-1", openems_edge_id: "edge0" }]),
      devices: failed("timeout"),
    });
    await expect(createSupabaseMeteringRepository(supabase).getManagedDevices("mg-1")).rejects.toThrow(
      "Could not read devices: timeout"
    );
  });
});

describe("createSupabaseMeteringRepository.getMicrogridTimezone", () => {
  it("returns the stored zone as stored", async () => {
    const { supabase } = fakeSupabase({ microgrids: ok({ timezone: "Africa/Kampala" }) });
    expect(await createSupabaseMeteringRepository(supabase).getMicrogridTimezone("mg-1")).toBe(
      "Africa/Kampala"
    );
  });

  it("returns null for a microgrid without a zone, or one not found", async () => {
    const none = fakeSupabase({ microgrids: ok({ timezone: null }) });
    expect(await createSupabaseMeteringRepository(none.supabase).getMicrogridTimezone("mg-1")).toBeNull();
    const missing = fakeSupabase({ microgrids: ok(null) });
    expect(await createSupabaseMeteringRepository(missing.supabase).getMicrogridTimezone("mg-1")).toBeNull();
  });

  it("throws when the read fails, rather than answering no zone", async () => {
    const { supabase } = fakeSupabase({ microgrids: failed("timeout", "57014") });
    await expect(createSupabaseMeteringRepository(supabase).getMicrogridTimezone("mg-1")).rejects.toThrow(
      "Could not read the microgrid's timezone: timeout (57014)"
    );
  });
});
