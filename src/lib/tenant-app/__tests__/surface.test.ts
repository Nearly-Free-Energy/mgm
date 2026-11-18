/**
 * The tenant app's GUI contribution (RFC mgm#197 § 3–4): `tenant.home`, a
 * tenant view of the caller's own unit at /my with its nav entry for the
 * tenant audience, accepted by the registry, never readable by an assistant,
 * with examples a GUI can be tested against; and its loader, which reads
 * through composeTenantApp and always disposes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import { SurfaceRegistry } from "@/lib/gui/host/server/surface-registry";
import type { TenantRequest, ViewDef } from "@/lib/gui/surface";
import { MGM_BUNDLED_PLUGINS, matchCatalogPage } from "@/lib/plugins/bundled";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { TenantAppCapabilityContract, TenantAppResult, TenantHome } from "../types";

const composeTenantApp = vi.fn();
vi.mock("../compose", () => ({ composeTenantApp: (...args: unknown[]) => composeTenantApp(...args) }));

import { TENANT_APP_SURFACE } from "../surface";
import { TENANT_HOME_EXAMPLES, TENANT_HOME_LOADED_EXAMPLES } from "../surface/examples";
import { loadTenantHome, TENANT_HOME_REFUSALS, tenantHomeRefusal } from "../surface/home";
import { buildTenantHomeModel, TENANT_HOME_KEYS, TENANT_METER_PREFIX } from "../surface/home-model";

const view = TENANT_APP_SURFACE.views?.[0] as ViewDef;
const UNIT = "550e8400-e29b-41d4-a716-4466554400a1";
const fmt = createFmt({ locale: "en-GB" });

const HOME: TenantHome = {
  tenant: { id: UNIT, displayName: "Nakato Grace", unitLabel: "Unit 4" },
  microgrid: { name: "Kasana East", timezone: "Africa/Kampala", currency: "UGX" },
  date: "2026-11-19",
  meters: [
    {
      deviceId: "550e8400-e29b-41d4-a716-4466554400d1",
      name: "House meter",
      deviceType: "consumption_meter",
      role: "primary_consumption_meter",
      effectiveFrom: "2026-03-01",
      effectiveTo: null,
    },
  ],
};

describe("TENANT_APP_SURFACE", () => {
  it("contributes the tenant's home as a tenant record view at /my, read from the database", () => {
    expect(TENANT_APP_SURFACE.plugin).toBe("tenant-app");
    expect(TENANT_APP_SURFACE.views?.map((v) => v.id)).toEqual(["tenant.home"]);
    expect(view).toMatchObject({
      kind: "record",
      scope: "tenant",
      path: "/my",
      params: {},
      cost: "db",
      declares: { keys: TENANT_HOME_KEYS, prefixes: [TENANT_METER_PREFIX] },
      load: loadTenantHome,
    });
    // Never attached, never polled, never readable by an assistant, no query.
    for (const key of ["attach", "live", "agent", "query", "ext", "entity"]) expect(view).not.toHaveProperty(key);
  });

  it("names it from a tenant nav entry, on a catalog page served by the view and not yet released", () => {
    expect(TENANT_APP_SURFACE.nav).toEqual([
      { id: "tenant.home", title: "My home", icon: "tenants", group: "operate", order: 80, view: "tenant.home", audience: "tenant" },
    ]);
    expect(matchCatalogPage("/my")).toMatchObject({ plugin: { name: "tenant-app" }, page: { path: "/my", servedBy: "view" } });
    // RFC mgm#197: released by PR 5.
    expect(isReleasedRoute("/my")).toBe(false);
  });

  it("contributes nothing else: no action, signal, status, search or entity", () => {
    expect(Object.keys(TENANT_APP_SURFACE).sort()).toEqual(["nav", "plugin", "views"]);
  });

  it("is accepted by the registry, and removed when its plugin unloads", () => {
    const registry = new SurfaceRegistry({ plugins: MGM_BUNDLED_PLUGINS });
    const remove = registry.contribute(TENANT_APP_SURFACE);
    expect(registry.snapshot().views.map((v) => [v.plugin, v.def.id])).toEqual([["tenant-app", "tenant.home"]]);
    remove();
    expect(registry.snapshot().views).toEqual([]);
    expect(registry.snapshot().nav).toEqual([]);
  });
});

describe("the tenant.home model and examples", () => {
  it("shows the unit, its microgrid, today and each meter by its role", () => {
    expect(buildTenantHomeModel(HOME, fmt)).toEqual({
      title: "Nakato Grace",
      entity: { kind: "tenant", id: UNIT, label: "Nakato Grace" },
      actions: [],
      body: {
        sections: [
          {
            fields: [
              { key: "unit", label: "Unit", value: { t: "text", text: "Unit 4" } },
              { key: "microgrid", label: "Microgrid", value: { t: "text", text: "Kasana East" } },
              { key: "today", label: "Today", value: fmt.date("2026-11-19") },
            ],
          },
          {
            title: "Meters",
            fields: [{ key: `meter.${HOME.meters[0].deviceId}`, label: "House meter", value: { t: "text", text: "Primary meter" } }],
          },
        ],
      },
    });
  });

  it("says when no meter is assigned today, and shows a missing unit label as empty", () => {
    const model = buildTenantHomeModel({ ...HOME, tenant: { ...HOME.tenant, unitLabel: null }, meters: [] }, fmt);
    expect(model.body.sections[0].fields[0].value).toEqual(fmt.empty());
    expect(model.body.sections[1].fields).toEqual([
      { key: "meters", label: "Meters", value: { t: "text", text: "No meter is assigned to this unit today" } },
    ]);
  });

  it("are a unit with two meters and one with none, which pass the view's strict parse as the loader returns them", () => {
    expect(TENANT_HOME_LOADED_EXAMPLES.map((m) => m.body.sections[1].fields.length)).toEqual([2, 1]);
    for (const model of TENANT_HOME_LOADED_EXAMPLES) expect(strictParseModel(view, model)).toMatchObject({ ok: true });
    for (const model of TENANT_HOME_EXAMPLES) {
      expect(model).toMatchObject({ type: "view", view: "tenant.home", kind: "record", org: null, trail: [], attached: [], actions: [] });
    }
  });
});

describe("loadTenantHome", () => {
  const dispose = vi.fn(async () => {});
  const getHome = vi.fn<TenantAppCapabilityContract["getHome"]>();
  const supabase = { caller: "tenant" } as unknown as SupabaseClient;
  const req: TenantRequest = {
    supabase,
    user: { id: "u" } as User,
    roles: [],
    organizationId: null,
    tenantId: UNIT,
    params: {},
    search: new URLSearchParams(),
    locale: "en-GB",
    now: new Date("2026-11-18T22:30:00Z"),
    fmt,
  };

  beforeEach(() => {
    dispose.mockClear();
    getHome.mockReset();
    composeTenantApp.mockReset();
    composeTenantApp.mockResolvedValue({ ok: true, data: { scope: {}, tenantApp: { getHome }, dispose } });
  });

  it("composes for the request's unit on the caller's client and clock, and disposes after reading", async () => {
    getHome.mockResolvedValue({ ok: true, data: HOME });
    expect(await loadTenantHome(req)).toEqual({ ok: true, model: buildTenantHomeModel(HOME, fmt) });
    const options = composeTenantApp.mock.calls[0][0] as { supabase: unknown; tenantId: string; now: () => number };
    expect(options.supabase).toBe(supabase);
    expect(options.tenantId).toBe(UNIT);
    expect(options.now()).toBe(req.now.getTime());
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes when the read fails or throws", async () => {
    getHome.mockResolvedValue({ ok: false, status: 503, code: "tenant_app_unavailable", message: "x" });
    expect(await loadTenantHome(req)).toEqual(TENANT_HOME_REFUSALS.unavailable);
    getHome.mockRejectedValue(new Error("boom"));
    await expect(loadTenantHome(req)).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "tenant_app_unauthenticated", TENANT_HOME_REFUSALS.signedOut],
    [400, "tenant_app_invalid_tenant", TENANT_HOME_REFUSALS.notFound],
    [403, "tenant_app_forbidden", TENANT_HOME_REFUSALS.notFound],
    [409, "tenant_app_disabled", TENANT_HOME_REFUSALS.disabled],
    [500, "tenant_app_composition_failed", TENANT_HOME_REFUSALS.failed],
    [503, "tenant_app_gate_unavailable", TENANT_HOME_REFUSALS.unavailable],
  ])("answers a composer refusal %i (%s) with fixed copy, opening nothing", async (status, code, refusal) => {
    const failure: TenantAppResult<never> = { ok: false, status: status as 400, code, message: "the capability's own words" };
    composeTenantApp.mockResolvedValue(failure);
    expect(await loadTenantHome(req)).toEqual(refusal);
    expect(tenantHomeRefusal(failure)).toEqual(refusal);
    expect(getHome).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });
});
