/**
 * The tenant app's GUI contribution (RFC mgm#197 § 3–5): `tenant.home`, a
 * tenant view of the caller's own unit at /my, and `tenant.usage-month` and
 * `tenant.usage-day`, its use at /my/usage and /my/usage/day, with nav
 * entries for the tenant audience, accepted by the registry, never readable
 * by an assistant, with examples a GUI can be tested against; and the home's
 * loader, which reads through composeTenantApp and always disposes it. The
 * usage views' models and loaders have tests of their own
 * (usage-model.test.ts, usage-loader.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createFmt } from "@/lib/gui/fmt";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import { SurfaceRegistry } from "@/lib/gui/host/server/surface-registry";
import type { TenantRequest, ViewDef } from "@/lib/gui/surface";
import { SYNTHETIC_NOTICE } from "@/lib/gui/host/server/view";
import { MGM_BUNDLED_PLUGINS, matchCatalogPage } from "@/lib/plugins/bundled";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { TenantAppCapabilityContract, TenantAppResult, TenantHome } from "../types";

const composeTenantApp = vi.fn();
vi.mock("../compose", () => ({ composeTenantApp: (...args: unknown[]) => composeTenantApp(...args) }));

import { TENANT_APP_SURFACE } from "../surface";
import { TENANT_HOME_EXAMPLES, TENANT_HOME_LOADED_EXAMPLES } from "../surface/examples";
import { loadTenantHome, TENANT_HOME_REFUSALS, tenantHomeRefusal } from "../surface/home";
import { buildTenantHomeModel, TENANT_HOME_KEYS, TENANT_METER_PREFIX } from "../surface/home-model";
import { loadTenantUsageDay, loadTenantUsageMonth } from "../surface/usage";
import { TenantUsageDayExt, TenantUsageMonthExt } from "../surface/usage-ext";
import {
  EXAMPLE_HIDDEN_IDS,
  EXAMPLE_SYNTHETIC_NOTICE,
  TENANT_USAGE_DAY_EXAMPLES,
  TENANT_USAGE_DAY_LOADED_EXAMPLES,
  TENANT_USAGE_MONTH_EXAMPLES,
  TENANT_USAGE_MONTH_LOADED_EXAMPLES,
} from "../surface/usage-examples";
import {
  TENANT_USAGE_DAY_EXT_SCHEMA,
  TENANT_USAGE_DAY_KEYS,
  TENANT_USAGE_MONTH_EXT_SCHEMA,
  TENANT_USAGE_MONTH_KEYS,
} from "../surface/usage-model";

const view = TENANT_APP_SURFACE.views?.[0] as ViewDef;
const viewById = (id: string) => TENANT_APP_SURFACE.views?.find((v) => v.id === id) as ViewDef;
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
    // The home stays first: contribution-schema.test.ts edits views[0] and nav[0].
    expect(TENANT_APP_SURFACE.views?.map((v) => v.id)).toEqual(["tenant.home", "tenant.usage-month", "tenant.usage-day"]);
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

  it.each([
    ["tenant.usage-month", "/my/usage", "month", TENANT_USAGE_MONTH_KEYS, TENANT_USAGE_MONTH_EXT_SCHEMA, TenantUsageMonthExt, loadTenantUsageMonth],
    ["tenant.usage-day", "/my/usage/day", "date", TENANT_USAGE_DAY_KEYS, TENANT_USAGE_DAY_EXT_SCHEMA, TenantUsageDayExt, loadTenantUsageDay],
  ] as const)("contributes %s as a tenant collection at %s, read from the metering source by its one parameter", (id, path, param, keys, schema, zod, load) => {
    expect(viewById(id)).toMatchObject({
      kind: "collection",
      scope: "tenant",
      path,
      params: {},
      query: [param],
      cost: "vendor",
      declares: { keys },
      ext: { schema, zod },
      load,
    });
    // Never attached, never polled, never readable by an assistant, no entity segment.
    for (const key of ["attach", "live", "agent", "entity"]) expect(viewById(id)).not.toHaveProperty(key);
  });

  it("names the home and the month from tenant nav entries, on catalog pages served by their views and not yet released", () => {
    expect(TENANT_APP_SURFACE.nav).toEqual([
      { id: "tenant.home", title: "My home", icon: "tenants", group: "operate", order: 80, view: "tenant.home", audience: "tenant" },
      { id: "tenant.usage", title: "My usage", icon: "readings", group: "operate", order: 81, view: "tenant.usage-month", audience: "tenant" },
    ]);
    for (const path of ["/my", "/my/usage", "/my/usage/day"]) {
      expect(matchCatalogPage(path), path).toMatchObject({ plugin: { name: "tenant-app" }, page: { path, params: {}, servedBy: "view" } });
      // RFC mgm#197: released by PR 5.
      expect(isReleasedRoute(path), path).toBe(false);
    }
  });

  it("contributes nothing else: no action, signal, status, search or entity", () => {
    expect(Object.keys(TENANT_APP_SURFACE).sort()).toEqual(["nav", "plugin", "views"]);
  });

  it("is accepted by the registry, and removed when its plugin unloads", () => {
    const registry = new SurfaceRegistry({ plugins: MGM_BUNDLED_PLUGINS });
    const remove = registry.contribute(TENANT_APP_SURFACE);
    expect(registry.snapshot().views.map((v) => [v.plugin, v.def.id])).toEqual([
      ["tenant-app", "tenant.home"],
      ["tenant-app", "tenant.usage-month"],
      ["tenant-app", "tenant.usage-day"],
    ]);
    expect(registry.snapshot().nav.map((n) => n.def.id)).toEqual(["tenant.home", "tenant.usage"]);
    remove();
    expect(registry.snapshot().views).toEqual([]);
    expect(registry.snapshot().nav).toEqual([]);
  });
});

describe("the tenant.home model and examples", () => {
  it("shows the unit, its microgrid, today and each meter by its role", () => {
    expect(buildTenantHomeModel(HOME, fmt)).toEqual({
      // The unit label, not the tenant's own name, which their units share.
      title: "Unit 4",
      entity: { kind: "tenant", id: UNIT, label: "Unit 4" },
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

describe("the usage views' examples", () => {
  const sets = [
    ["tenant.usage-month", TENANT_USAGE_MONTH_LOADED_EXAMPLES, TENANT_USAGE_MONTH_EXAMPLES, TenantUsageMonthExt],
    ["tenant.usage-day", TENANT_USAGE_DAY_LOADED_EXAMPLES, TENANT_USAGE_DAY_EXAMPLES, TenantUsageDayExt],
  ] as const;

  it.each(sets)("%s: pass the view's strict parse as the loader returns them, ext included", (id, loaded, received, zod) => {
    expect(loaded.length).toBeGreaterThan(3);
    for (const model of loaded) {
      expect(strictParseModel(viewById(id), model)).toMatchObject({ ok: true });
      expect(zod.safeParse(model.ext?.data).success).toBe(true);
    }
    for (const model of received) {
      expect(model).toMatchObject({ type: "view", view: id, kind: "collection", org: null, trail: [], attached: [], actions: [], links: [] });
      expect(model.body.rows.every((row) => row.actions.length === 0 && row.href === undefined)).toBe(true);
    }
  });

  it.each(sets)("%s: carry the host's synthetic notice exactly when a figure is generated", (_id, loaded, received) => {
    expect(EXAMPLE_SYNTHETIC_NOTICE).toEqual(SYNTHETIC_NOTICE);
    received.forEach((model, i) => {
      const cells = [...loaded[i].body.rows.flatMap((r) => Object.values(r.cells)), ...Object.values(loaded[i].body.totals ?? {})];
      expect(model.notice).toEqual(cells.some((c) => c.synthetic) ? SYNTHETIC_NOTICE : undefined);
      // Only figures are marked: never a "No data" text or a note.
      for (const cell of cells) if (cell.synthetic) expect(cell.t).toBe("energy");
    });
    expect(received.filter((m) => m.notice).length).toBeGreaterThan(0);
  });

  it("cover every state and problem a tenant can meet", () => {
    const months = TENANT_USAGE_MONTH_LOADED_EXAMPLES.map((m) => m.ext!.data as { days: { state: string }[]; problem: { kind: string } | null; stale: boolean; total: { kwh: number | null } });
    const days = TENANT_USAGE_DAY_LOADED_EXAMPLES.map((m) => m.ext!.data as { hours: { state: string }[]; problem: { kind: string } | null; total: { kwh: number | null } });
    const states = new Set([...months.flatMap((m) => m.days.map((d) => d.state)), ...days.flatMap((d) => d.hours.map((h) => h.state))]);
    expect([...states].sort()).toEqual(["data", "future", "no-data", "no-meter", "partial"]);
    expect(new Set(months.map((m) => m.problem?.kind ?? null))).toEqual(new Set([null, "unavailable", "limited"]));
    expect(months.some((m) => m.stale)).toBe(true);
    expect(months.some((m) => m.total.kwh !== null)).toBe(true);
    expect(days.some((d) => d.problem?.kind === "unavailable")).toBe(true);
    // An empty state for each view: a period before the unit's first meter.
    expect(TENANT_USAGE_MONTH_LOADED_EXAMPLES.some((m) => m.body.rows.length === 0)).toBe(true);
    expect(TENANT_USAGE_DAY_LOADED_EXAMPLES.some((m) => m.body.rows.length === 0)).toBe(true);
  });

  it("show none of the meters' or the microgrid's ids, only the unit's", () => {
    const text = JSON.stringify([...TENANT_USAGE_MONTH_EXAMPLES, ...TENANT_USAGE_DAY_EXAMPLES]);
    expect(EXAMPLE_HIDDEN_IDS.length).toBe(4);
    for (const id of EXAMPLE_HIDDEN_IDS) expect(text).not.toContain(id);
    expect(text).not.toMatch(/SYNTHETIC-EDGE|meter1|openems/i);
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
