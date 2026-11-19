/**
 * composeTenantApp: who reaches a unit, what a disabled tenant app answers,
 * and that each request's capability reads through its own caller's client.
 *
 * The fake clients answer the way RLS and the database functions would for
 * their caller: their own role rows, `fn_tenant_home` for a unit they hold,
 * the plugin state for the unit's organization and their meter links.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
// The root before any composer: the metering surface's loader imports
// composeMetering, and loaded first from inside the scope mock below it would
// bind the unwrapped opener. If the root stops importing surface modules, the
// order no longer matters.
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import { openOrganizationScope } from "@/lib/runtime/scope";
import { BillingPlugin } from "@/lib/billing/compose";
import { composeTenantApp } from "../compose";

const state = vi.hoisted(() => ({ failToConstruct: false }));

// Wrapped, not replaced: the spy records whether the composer opened a scope.
vi.mock("@/lib/runtime/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime/scope")>();
  return { ...actual, openOrganizationScope: vi.fn(actual.openOrganizationScope) };
});

vi.mock("../capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capability")>();
  return {
    ...actual,
    TenantAppCapability: class extends actual.TenantAppCapability {
      constructor(...args: ConstructorParameters<typeof actual.TenantAppCapability>) {
        if (state.failToConstruct) throw new Error("capability failed to construct");
        super(...args);
      }
    },
  };
});

const ORG_A = "550e8400-e29b-41d4-a716-44665544000a";
const ORG_B = "550e8400-e29b-41d4-a716-44665544000b";
const UNIT_A = "550e8400-e29b-41d4-a716-4466554400a1";
const UNIT_B = "550e8400-e29b-41d4-a716-4466554400b1";
/** 22:30 UTC on 18 November: already the 19th in Kampala (UTC+3). */
const NOW = Date.parse("2026-11-18T22:30:00Z");

type Role = { user_id: string; role: string; scope_type: string; scope_id: string | null };

type Caller = {
  label: string;
  user: { id: string } | null;
  roles: Role[];
  /** The units `fn_tenant_home` answers for this caller, by id. */
  units: Record<string, { organization_id: string; display_name: string }>;
  /** When set, the caller's `user_roles` read fails with it. */
  rolesError?: { message: string };
  homeError?: { message: string };
  /** How `mgm_plugin_enabled_for_org` answers for the caller. */
  plugin: "enabled" | "disabled" | "error";
};

const tenantRow = (userId: string, unit: string): Role => ({
  user_id: userId,
  role: "tenant",
  scope_type: "tenant",
  scope_id: unit,
});

function tenantOfA(overrides: Partial<Caller> = {}): Caller {
  return {
    label: "a",
    user: { id: "tenant-a" },
    roles: [tenantRow("tenant-a", UNIT_A)],
    units: { [UNIT_A]: { organization_id: ORG_A, display_name: "Unit A tenant" } },
    plugin: "enabled",
    ...overrides,
  };
}

/** A thenable query that records each filter and answers `result`. */
function query(result: () => { data: unknown; error: unknown }, filters: unknown[][]) {
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
    returns: () => chain,
  };
  for (const method of ["select", "eq", "in", "lte", "or"]) {
    chain[method] = (...args: unknown[]) => {
      filters.push([method, ...args]);
      return chain;
    };
  }
  return chain;
}

type FakeClient = SupabaseClient & {
  rpc: ReturnType<typeof vi.fn>;
  label: string;
  meterReads: unknown[][];
};

function client(caller: Caller): FakeClient {
  const meterReads: unknown[][] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, string>) => {
    if (fn === "fn_tenant_home") {
      if (caller.homeError) return { data: null, error: caller.homeError };
      const unit = caller.units[args._tenant_id];
      return {
        data: unit
          ? [
              {
                tenant_id: args._tenant_id,
                display_name: unit.display_name,
                unit_label: null,
                microgrid_id: "550e8400-e29b-41d4-a716-446655440099",
                microgrid_name: "Kasana East",
                timezone: "Africa/Kampala",
                currency: "UGX",
                organization_id: unit.organization_id,
              },
            ]
          : [],
        error: null,
      };
    }
    if (fn === "mgm_plugin_enabled_for_org") {
      if (caller.plugin === "error") return { data: null, error: { message: "statement timeout" } };
      return { data: caller.plugin === "enabled", error: null };
    }
    throw new Error(`Unexpected RPC: ${fn}`);
  });
  return {
    label: caller.label,
    meterReads,
    auth: { getUser: async () => ({ data: { user: caller.user } }) },
    rpc,
    from(table: string) {
      if (table === "user_roles") {
        return query(
          () =>
            caller.rolesError
              ? { data: null, error: caller.rolesError }
              : { data: caller.user ? caller.roles : [], error: null },
          []
        );
      }
      if (table === "tenant_devices") {
        const filters: unknown[][] = [];
        meterReads.push(filters);
        return query(
          () => ({
            data: [
              {
                device_id: `meter-${caller.label}`,
                role: "primary_consumption_meter",
                effective_from: "2026-01-01",
                effective_to: null,
                devices: { id: `meter-${caller.label}`, name: `Meter ${caller.label}`, device_type: "consumption_meter" },
              },
            ],
            error: null,
          }),
          filters
        );
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as FakeClient;
}

/** What the root gate answers when asked whether the tenant app is live for `org`. */
async function gateRefusal(supabase: SupabaseClient, org: string) {
  const runtime = await getMgmRuntime();
  const decision = await runtime.gate.check(supabase, {
    plugin: "tenant-app",
    target: { kind: "organization", id: org },
    method: "GET",
    access: "write",
  });
  if (decision.ok) throw new Error("expected the gate to refuse the tenant app");
  const { status, code, message } = decision;
  return { ok: false, status, code, message };
}

beforeEach(() => {
  state.failToConstruct = false;
  vi.clearAllMocks();
});

afterEach(async () => {
  await resetMgmRuntimeForTests();
});

describe("composeTenantApp authorization", () => {
  it("rejects a malformed tenant id before asking anything", async () => {
    const supabase = client(tenantOfA());
    const result = await composeTenantApp({ supabase, tenantId: "not-a-uuid" });
    expect(result).toMatchObject({ ok: false, status: 400, code: "tenant_app_invalid_tenant" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    const supabase = client(tenantOfA({ user: null }));
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });
    expect(result).toMatchObject({ ok: false, status: 401, code: "tenant_app_unauthenticated" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["a super admin", [{ user_id: "u", role: "super_admin", scope_type: "org", scope_id: null }]],
    ["the unit organization's manager", [{ user_id: "u", role: "org_manager", scope_type: "org", scope_id: ORG_A }]],
    ["the tenant of another unit", [tenantRow("u", UNIT_B)]],
    ["a signed-in user with no role", []],
  ])("refuses %s, before reading the unit", async (_who, roles) => {
    // fn_tenant_home would answer, so only the role check can refuse.
    const supabase = client(tenantOfA({ user: { id: "u" }, roles }));
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });
    expect(result).toMatchObject({ ok: false, status: 403, code: "tenant_app_forbidden" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(openOrganizationScope).not.toHaveBeenCalled();
  });

  it("reads a unit id given in upper case as the same unit", async () => {
    const supabase = client(tenantOfA());
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A.toUpperCase() });
    if (!result.ok) throw new Error(result.code);
    await result.data.dispose();
    expect(supabase.rpc).toHaveBeenCalledWith("fn_tenant_home", { _tenant_id: UNIT_A });
  });

  it("refuses a unit fn_tenant_home no longer answers for", async () => {
    const supabase = client(tenantOfA({ units: {} }));
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });
    expect(result).toMatchObject({ ok: false, status: 403, code: "tenant_app_forbidden" });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(openOrganizationScope).not.toHaveBeenCalled();
  });

  it("answers 503 when the caller's role rows cannot be read, not a missing unit", async () => {
    const supabase = client(tenantOfA({ rolesError: { message: "statement timeout" } }));
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });
    expect(result).toMatchObject({ ok: false, status: 503, code: "tenant_app_unavailable" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(openOrganizationScope).not.toHaveBeenCalled();
  });

  it("answers 503 when the unit cannot be read", async () => {
    const supabase = client(tenantOfA({ homeError: { message: "statement timeout" } }));
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });
    expect(result).toMatchObject({ ok: false, status: 503, code: "tenant_app_unavailable" });
    expect(openOrganizationScope).not.toHaveBeenCalled();
  });
});

describe("composeTenantApp and the plugin gate", () => {
  it("asks about the unit's organization with the tenant's own client", async () => {
    const supabase = client(tenantOfA());
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });
    if (!result.ok) throw new Error(result.code);
    await result.data.dispose();
    expect(supabase.rpc).toHaveBeenCalledWith("fn_tenant_home", { _tenant_id: UNIT_A });
    expect(supabase.rpc).toHaveBeenCalledWith("mgm_plugin_enabled_for_org", {
      _org_id: ORG_A,
      _plugin_name: "tenant-app",
    });
  });

  it("answers 409 like the gate and opens no scope while the tenant app is off", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    const supabase = client(tenantOfA({ plugin: "disabled" }));

    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });

    expect(result).toEqual(await gateRefusal(supabase, ORG_A));
    expect(result).toMatchObject({ status: 409, code: "tenant_app_disabled" });
    expect(openOrganizationScope).not.toHaveBeenCalled();
    expect(runtime.root.registry.size).toBe(before);
  });

  it("answers 503 like the gate and opens no scope when plugin state cannot be read", async () => {
    const supabase = client(tenantOfA({ plugin: "error" }));

    const result = await composeTenantApp({ supabase, tenantId: UNIT_A });

    expect(result).toEqual(await gateRefusal(supabase, ORG_A));
    expect(result).toMatchObject({ status: 503, code: "tenant_app_gate_unavailable" });
    expect(openOrganizationScope).not.toHaveBeenCalled();
  });
});

describe("composeTenantApp composition", () => {
  it("provides a scoped capability that reads the tenant's home and deactivates on dispose", async () => {
    const supabase = client(tenantOfA());
    const result = await composeTenantApp({ supabase, tenantId: UNIT_A, now: () => NOW });
    if (!result.ok) throw new Error(result.code);

    expect(result.data.scope).toMatchObject({
      tenantId: UNIT_A,
      organizationId: ORG_A,
      userId: "tenant-a",
    });
    const home = await result.data.tenantApp.getHome();
    expect(home).toMatchObject({
      ok: true,
      data: {
        tenant: { id: UNIT_A, displayName: "Unit A tenant" },
        microgrid: { name: "Kasana East", timezone: "Africa/Kampala", currency: "UGX" },
        date: "2026-11-19",
        meters: [{ deviceId: "meter-a", name: "Meter a" }],
      },
    });
    expect(supabase.meterReads).toEqual([
      expect.arrayContaining([
        ["eq", "tenant_id", UNIT_A],
        ["lte", "effective_from", "2026-11-19"],
      ]),
    ]);

    await result.data.dispose();
    expect(await result.data.tenantApp.getHome()).toMatchObject({
      ok: false,
      code: "tenant_app_composition_disposed",
    });
  });

  it("serves a person with two units one unit at a time", async () => {
    const both = tenantOfA({
      roles: [tenantRow("tenant-a", UNIT_A), tenantRow("tenant-a", UNIT_B)],
      units: {
        [UNIT_A]: { organization_id: ORG_A, display_name: "Unit A tenant" },
        [UNIT_B]: { organization_id: ORG_B, display_name: "Unit B tenant" },
      },
    });
    const supabase = client(both);
    const result = await composeTenantApp({ supabase, tenantId: UNIT_B });
    if (!result.ok) throw new Error(result.code);
    try {
      expect(result.data.scope).toMatchObject({ tenantId: UNIT_B, organizationId: ORG_B });
      expect(supabase.rpc).toHaveBeenCalledWith("mgm_plugin_enabled_for_org", {
        _org_id: ORG_B,
        _plugin_name: "tenant-app",
      });
    } finally {
      await result.data.dispose();
    }
  });

  it("opens the scope with the caller's tenant rows only, so a manager who rents carries no staff row into it", async () => {
    const managerWhoRents = tenantOfA({
      roles: [
        { user_id: "tenant-a", role: "org_manager", scope_type: "org", scope_id: ORG_B },
        tenantRow("tenant-a", UNIT_A),
        tenantRow("tenant-a", UNIT_B),
      ],
    });
    const result = await composeTenantApp({ supabase: client(managerWhoRents), tenantId: UNIT_A });
    if (!result.ok) throw new Error(result.code);
    try {
      expect(vi.mocked(openOrganizationScope)).toHaveBeenCalledTimes(1);
      const [request] = vi.mocked(openOrganizationScope).mock.calls[0];
      expect(request).toMatchObject({ organizationId: ORG_A, userId: "tenant-a" });
      expect(request.roles).toEqual([tenantRow("tenant-a", UNIT_A), tenantRow("tenant-a", UNIT_B)]);
    } finally {
      await result.data.dispose();
    }
  });

  it("opens the scope for a tenant, so no capability plugin that trusts its organization loads into it", async () => {
    const result = await composeTenantApp({ supabase: client(tenantOfA()), tenantId: UNIT_A });
    if (!result.ok) throw new Error(result.code);
    try {
      const [, options] = vi.mocked(openOrganizationScope).mock.calls[0];
      expect(options).toEqual({ audience: "tenant" });
      const opened = await vi.mocked(openOrganizationScope).mock.results[0].value;
      expect(opened.request.audience).toBe("tenant");
      expect(opened.ctx.get("mgmRequest")?.audience).toBe("tenant");
      // request-audience.test.ts loads each such plugin into a scope like it.
      await expect(opened.load(BillingPlugin, { repository: {} as never })).rejects.toThrow(
        "not one for audience tenant"
      );
    } finally {
      await result.data.dispose();
    }
  });

  it("keeps concurrent tenants' requests apart", async () => {
    const a = client(tenantOfA());
    const b = client({
      label: "b",
      user: { id: "tenant-b" },
      roles: [tenantRow("tenant-b", UNIT_B)],
      units: { [UNIT_B]: { organization_id: ORG_B, display_name: "Unit B tenant" } },
      plugin: "enabled",
    });

    const [ra, rb] = await Promise.all([
      composeTenantApp({ supabase: a, tenantId: UNIT_A, now: () => NOW }),
      composeTenantApp({ supabase: b, tenantId: UNIT_B, now: () => NOW }),
    ]);
    if (!ra.ok || !rb.ok) throw new Error("expected both compositions");
    try {
      const [homeA, homeB] = await Promise.all([ra.data.tenantApp.getHome(), rb.data.tenantApp.getHome()]);
      expect(ra.data.scope).toMatchObject({ tenantId: UNIT_A, organizationId: ORG_A, userId: "tenant-a" });
      expect(rb.data.scope).toMatchObject({ tenantId: UNIT_B, organizationId: ORG_B, userId: "tenant-b" });
      expect(homeA).toMatchObject({ ok: true, data: { meters: [{ deviceId: "meter-a" }] } });
      expect(homeB).toMatchObject({ ok: true, data: { meters: [{ deviceId: "meter-b" }] } });
      // Each read went through its own caller's client.
      expect(a.meterReads).toHaveLength(1);
      expect(b.meterReads).toHaveLength(1);
    } finally {
      await Promise.all([ra.data.dispose(), rb.data.dispose()]);
    }
  });

  it("disposes the scope it opened when the capability plugin fails to load", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    state.failToConstruct = true;

    const result = await composeTenantApp({ supabase: client(tenantOfA()), tenantId: UNIT_A });

    expect(result).toMatchObject({ ok: false, status: 500, code: "tenant_app_composition_failed" });
    expect(openOrganizationScope).toHaveBeenCalledTimes(1);
    expect(runtime.root.registry.size).toBe(before);
  });
});
