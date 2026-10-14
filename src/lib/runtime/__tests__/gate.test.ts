import { beforeEach, describe, expect, it, vi } from "vitest";
import { MgmGate, resolveTargetOrganization, type GateTarget } from "../gate";
import { MGM_BUNDLED_PLUGINS, getBundledPlugin } from "@/lib/plugins/bundled";
import type { MgmCatalog } from "../services";

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const TARGET_ID = "550e8400-e29b-41d4-a716-446655440001";

const catalog: MgmCatalog = {
  plugins: MGM_BUNDLED_PLUGINS,
  get: (name) => getBundledPlugin(name),
  isCore: (name) => getBundledPlugin(name)?.core ?? false,
};

type Row = Record<string, unknown> | null;

function makeSupabase(options: {
  row?: Row;
  selectError?: { message: string } | null;
  enabled?: boolean | null;
  rpcError?: { message: string } | null;
}) {
  const calls: { table: string; columns: string; id: string }[] = [];
  const rpc = vi.fn(async () => ({
    data: options.enabled ?? null,
    error: options.rpcError ?? null,
  }));
  const supabase = {
    from(table: string) {
      const call = { table, columns: "", id: "" };
      const query = {
        select(columns: string) {
          call.columns = columns;
          return query;
        },
        eq(_column: string, id: string) {
          call.id = id;
          calls.push(call);
          return query;
        },
        maybeSingle: async () => ({
          data: options.row ?? null,
          error: options.selectError ?? null,
        }),
      };
      return query;
    },
    rpc,
  };
  return { supabase: supabase as never, calls, rpc };
}

const org = { org_id: ORG_ID };
const microgrid = { communities: org };
const edge = { microgrids: microgrid };

const CASES: Array<[GateTarget["kind"], string, Row]> = [
  ["community", "communities", { id: TARGET_ID, org_id: ORG_ID }],
  ["microgrid", "microgrids", { id: TARGET_ID, communities: [org] }],
  ["edge", "edges", { id: TARGET_ID, microgrids: microgrid }],
  ["device", "devices", { id: TARGET_ID, edges: edge }],
  ["billingPeriod", "billing_periods", { id: TARGET_ID, microgrids: microgrid }],
  ["lineItem", "billing_line_items", { id: TARGET_ID, billing_periods: { microgrids: microgrid } }],
  ["rateSchedule", "rate_schedules", { id: TARGET_ID, microgrids: microgrid }],
];

describe("resolveTargetOrganization", () => {
  it.each(CASES)("resolves a %s through %s", async (kind, table, row) => {
    const { supabase, calls } = makeSupabase({ row });
    await expect(
      resolveTargetOrganization(supabase, { kind, id: TARGET_ID } as GateTarget)
    ).resolves.toBe(ORG_ID);
    expect(calls).toEqual([expect.objectContaining({ table, id: TARGET_ID })]);
  });

  it("returns the id itself for an organization without querying", async () => {
    const { supabase, calls } = makeSupabase({});
    await expect(
      resolveTargetOrganization(supabase, { kind: "organization", id: ORG_ID })
    ).resolves.toBe(ORG_ID);
    expect(calls).toEqual([]);
  });

  it("returns null when the target is not visible", async () => {
    const { supabase } = makeSupabase({ row: null });
    await expect(
      resolveTargetOrganization(supabase, { kind: "edge", id: TARGET_ID })
    ).resolves.toBeNull();
  });

  it("throws when the lookup fails", async () => {
    const { supabase } = makeSupabase({ selectError: { message: "boom" } });
    await expect(
      resolveTargetOrganization(supabase, { kind: "edge", id: TARGET_ID })
    ).rejects.toThrow("boom");
  });
});

describe("MgmGate", () => {
  let gate: MgmGate;
  beforeEach(() => {
    gate = new MgmGate(catalog);
  });

  it.each(["GET", "HEAD"])("never gates %s", async (method) => {
    const { supabase, calls, rpc } = makeSupabase({ enabled: false });
    await expect(
      gate.check(supabase, { plugin: "metering", target: { kind: "edge", id: TARGET_ID }, method })
    ).resolves.toEqual({ ok: true, organizationId: null });
    expect(calls).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("honours an explicit access override in both directions", async () => {
    const disabled = makeSupabase({ row: { id: TARGET_ID, microgrids: microgrid }, enabled: false });
    await expect(
      gate.check(disabled.supabase, {
        plugin: "metering",
        target: { kind: "edge", id: TARGET_ID },
        method: "GET",
        access: "write",
      })
    ).resolves.toMatchObject({ ok: false, status: 409 });

    const preview = makeSupabase({ enabled: false });
    await expect(
      gate.check(preview.supabase, {
        plugin: "billing",
        target: { kind: "community", id: TARGET_ID },
        method: "POST",
        access: "read",
      })
    ).resolves.toEqual({ ok: true, organizationId: null });
    expect(preview.rpc).not.toHaveBeenCalled();
  });

  it("never gates the core organization directory", async () => {
    const { supabase, rpc } = makeSupabase({ enabled: false });
    await expect(
      gate.check(supabase, {
        plugin: "organization-directory",
        target: { kind: "organization", id: ORG_ID },
        method: "PATCH",
      })
    ).resolves.toMatchObject({ ok: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 409 <plugin>_disabled for a write while the plugin is off", async () => {
    const { supabase, rpc } = makeSupabase({ row: { id: TARGET_ID, microgrids: microgrid }, enabled: false });
    const decision = await gate.check(supabase, {
      plugin: "metering",
      target: { kind: "edge", id: TARGET_ID },
      method: "post",
    });
    expect(decision).toEqual({
      ok: false,
      status: 409,
      code: "metering_disabled",
      message: expect.stringContaining("Metering is disabled"),
    });
    expect(rpc).toHaveBeenCalledWith("mgm_plugin_enabled_for_org", {
      _org_id: ORG_ID,
      _plugin_name: "metering",
    });
  });

  it("uses the community_management code prefix", async () => {
    const { supabase } = makeSupabase({ row: { id: TARGET_ID, org_id: ORG_ID }, enabled: false });
    await expect(
      gate.check(supabase, {
        plugin: "community-management",
        target: { kind: "community", id: TARGET_ID },
        method: "DELETE",
      })
    ).resolves.toMatchObject({ status: 409, code: "community_management_disabled" });
  });

  it("passes a write with the resolved organization when enabled", async () => {
    const { supabase } = makeSupabase({ row: { id: TARGET_ID, microgrids: microgrid }, enabled: true });
    await expect(
      gate.check(supabase, {
        plugin: "billing",
        target: { kind: "rateSchedule", id: TARGET_ID },
        method: "PUT",
      })
    ).resolves.toEqual({ ok: true, organizationId: ORG_ID });
  });

  it("leaves an invisible target to the route's own 404/403", async () => {
    const { supabase, rpc } = makeSupabase({ row: null, enabled: false });
    await expect(
      gate.check(supabase, { plugin: "billing", target: { kind: "lineItem", id: TARGET_ID }, method: "PATCH" })
    ).resolves.toEqual({ ok: true, organizationId: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the organization lookup fails", async () => {
    const { supabase } = makeSupabase({ selectError: { message: "down" } });
    await expect(
      gate.check(supabase, { plugin: "payments", target: { kind: "community", id: TARGET_ID }, method: "PUT" })
    ).resolves.toMatchObject({ ok: false, status: 503, code: "payments_gate_unavailable" });
  });

  it("fails closed with 503 when plugin state cannot be read", async () => {
    const { supabase } = makeSupabase({
      row: { id: TARGET_ID, org_id: ORG_ID },
      rpcError: { message: "down" },
    });
    await expect(
      gate.check(supabase, { plugin: "billing", target: { kind: "community", id: TARGET_ID }, method: "POST" })
    ).resolves.toMatchObject({ ok: false, status: 503, code: "billing_gate_unavailable" });
  });

  it("fails closed when the lookup or plugin read throws", async () => {
    const throwing = {
      from() {
        throw new Error("network");
      },
      rpc: vi.fn(),
    } as never;
    await expect(
      gate.check(throwing, { plugin: "billing", target: { kind: "microgrid", id: TARGET_ID }, method: "POST" })
    ).resolves.toMatchObject({ ok: false, status: 503 });

    const { supabase } = makeSupabase({ row: { id: TARGET_ID, org_id: ORG_ID } });
    (supabase as unknown as { rpc: () => Promise<never> }).rpc = async () => {
      throw new Error("network");
    };
    await expect(
      gate.check(supabase, { plugin: "billing", target: { kind: "community", id: TARGET_ID }, method: "POST" })
    ).resolves.toMatchObject({ ok: false, status: 503, code: "billing_gate_unavailable" });
  });

  it("rejects plugins outside the catalog", async () => {
    const { supabase } = makeSupabase({});
    await expect(
      gate.check(supabase, {
        plugin: "unknown" as never,
        target: { kind: "organization", id: ORG_ID },
        method: "POST",
      })
    ).rejects.toThrow('Unknown MGM plugin "unknown"');
  });
});
