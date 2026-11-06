// getHouseMeterIds against a recording fake of the Supabase query builder:
// which filters it sends (the links in force on the day read, half-open as
// 00058 defines them), and that a failed read throws rather than looking
// like a site without household meters.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseMeteringRepository } from "../supabase-repository";

type Call = { table: string; steps: [string, ...unknown[]][] };
type Answer = { data: unknown[] | null; error: { code?: string; message?: string } | null };

/** A query builder that records each chained call and resolves per table. */
function fakeSupabase(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, steps: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "is", "lte", "or"]) {
        builder[method] = (...args: unknown[]) => {
          call.steps.push([method, ...args]);
          return builder;
        };
      }
      builder.then = (resolve: (value: Answer) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(answers[table] ?? { data: [], error: null }).then(resolve, reject);
      return builder;
    },
  };
  return { supabase: client as unknown as SupabaseClient, calls };
}

const ok = (data: unknown[]): Answer => ({ data, error: null });

describe("createSupabaseMeteringRepository.getHouseMeterIds", () => {
  it("reads the primary and secondary meter links in force on the day", async () => {
    const { supabase, calls } = fakeSupabase({
      edges: ok([{ id: "e-1" }]),
      devices: ok([{ id: "d-1" }, { id: "d-2" }]),
      household_devices: ok([{ device_id: "d-1" }, { device_id: "d-1" }, { device_id: "d-2" }]),
    });
    const ids = await createSupabaseMeteringRepository(supabase).getHouseMeterIds(
      "mg-1",
      "2026-11-01"
    );
    expect(ids).toEqual(["d-1", "d-2"]);
    const links = calls.find((c) => c.table === "household_devices");
    expect(links?.steps).toEqual([
      ["select", "device_id"],
      ["in", "device_id", ["d-1", "d-2"]],
      ["in", "role", ["primary_consumption_meter", "secondary_meter"]],
      ["lte", "effective_from", "2026-11-01"],
      ["or", "effective_to.is.null,effective_to.gt.2026-11-01"],
    ]);
  });

  it("returns no ids without edges or devices, and does not read links", async () => {
    const noEdges = fakeSupabase({ edges: ok([]) });
    expect(
      await createSupabaseMeteringRepository(noEdges.supabase).getHouseMeterIds("mg-1", "2026-11-01")
    ).toEqual([]);
    expect(noEdges.calls.map((c) => c.table)).toEqual(["edges"]);
    const noDevices = fakeSupabase({ edges: ok([{ id: "e-1" }]), devices: ok([]) });
    expect(
      await createSupabaseMeteringRepository(noDevices.supabase).getHouseMeterIds(
        "mg-1",
        "2026-11-01"
      )
    ).toEqual([]);
    expect(noDevices.calls.map((c) => c.table)).toEqual(["edges", "devices"]);
  });

  it("throws when the link read fails, rather than answering no meters", async () => {
    const { supabase } = fakeSupabase({
      edges: ok([{ id: "e-1" }]),
      devices: ok([{ id: "d-1" }]),
      household_devices: { data: null, error: { code: "42501", message: "permission denied" } },
    });
    await expect(
      createSupabaseMeteringRepository(supabase).getHouseMeterIds("mg-1", "2026-11-01")
    ).rejects.toThrow("Could not read household meter links: permission denied (42501)");
  });

  it("throws when the edge or device read fails", async () => {
    const edges = fakeSupabase({ edges: { data: null, error: { message: "timeout" } } });
    await expect(
      createSupabaseMeteringRepository(edges.supabase).getHouseMeterIds("mg-1", "2026-11-01")
    ).rejects.toThrow("Could not read edges: timeout");
    const devices = fakeSupabase({
      edges: ok([{ id: "e-1" }]),
      devices: { data: null, error: { message: "timeout" } },
    });
    await expect(
      createSupabaseMeteringRepository(devices.supabase).getHouseMeterIds("mg-1", "2026-11-01")
    ).rejects.toThrow("Could not read devices: timeout");
  });

  it("refuses a date that is not a calendar day key before building a filter", async () => {
    const { supabase, calls } = fakeSupabase({});
    await expect(
      createSupabaseMeteringRepository(supabase).getHouseMeterIds("mg-1", "2026-11-01,x.eq.1")
    ).rejects.toThrow("Invalid date key");
    expect(calls).toEqual([]);
  });
});
