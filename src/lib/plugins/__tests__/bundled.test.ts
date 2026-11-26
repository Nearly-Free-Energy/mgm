import { describe, expect, it } from "vitest";
import {
  BILLING_PLUGIN_NAME,
  COMMUNITY_MANAGEMENT_PLUGIN,
  COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  CORE_ENTITY_KINDS,
  METERING_PLUGIN,
  METERING_PLUGIN_NAME,
  MGM_BUNDLED_PLUGINS,
  OPERATIONS_PLUGIN,
  OPERATIONS_PLUGIN_NAME,
  ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  PAYMENTS_PLUGIN_NAME,
  PESAPAL_PLUGIN_NAME,
  TENANT_APP_PLUGIN,
  TENANT_APP_PLUGIN_NAME,
  DEFAULT_OFF_PLUGIN_NAMES,
  getPluginByAlias,
  getRouteOwner,
  matchCatalogPage,
  resolvePluginStatuses,
  validatePluginToggle,
} from "../bundled";

describe("MGM bundled plugins", () => {
  it("defaults missing state rows to enabled, except the tenant app's and the operations plugin's", () => {
    const statuses = resolvePluginStatuses();
    expect(
      statuses.map((status) => [status.plugin.name, status.enabled, status.ready])
    ).toEqual([
      [ORGANIZATION_DIRECTORY_PLUGIN_NAME, true, true],
      [COMMUNITY_MANAGEMENT_PLUGIN_NAME, true, true],
      [METERING_PLUGIN_NAME, true, true],
      [BILLING_PLUGIN_NAME, true, true],
      [PAYMENTS_PLUGIN_NAME, true, true],
      [PESAPAL_PLUGIN_NAME, true, true],
      [TENANT_APP_PLUGIN_NAME, false, true],
      [OPERATIONS_PLUGIN_NAME, false, true],
    ]);
  });

  it("lists the tenant app and the operations plugin as the plugins off by default", () => {
    expect(DEFAULT_OFF_PLUGIN_NAMES).toEqual([TENANT_APP_PLUGIN_NAME, OPERATIONS_PLUGIN_NAME]);
  });

  it("turns the tenant app on only from a state row", () => {
    const tenantApp = (states?: Parameters<typeof resolvePluginStatuses>[0]) =>
      resolvePluginStatuses(states).find((s) => s.plugin.name === TENANT_APP_PLUGIN_NAME);
    expect(tenantApp({ [TENANT_APP_PLUGIN_NAME]: { enabled: true } })?.enabled).toBe(true);
    expect(tenantApp({ [TENANT_APP_PLUGIN_NAME]: { enabled: false } })?.enabled).toBe(false);
    expect(tenantApp({ [TENANT_APP_PLUGIN_NAME]: { enabled: null } })?.enabled).toBe(false);
  });

  it("the tenant app depends on metering and community management", () => {
    expect(TENANT_APP_PLUGIN).toMatchObject({
      core: false,
      dependencies: [METERING_PLUGIN_NAME, COMMUNITY_MANAGEMENT_PLUGIN_NAME],
      routes: [],
    });
    expect(
      validatePluginToggle({
        pluginName: TENANT_APP_PLUGIN_NAME,
        enabled: true,
        states: { [METERING_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_disabled",
      message: expect.stringContaining("Metering"),
    });
    expect(
      validatePluginToggle({ pluginName: TENANT_APP_PLUGIN_NAME, enabled: true })
    ).toEqual({ ok: true });
  });

  it("does not let a tenant app with no state row block its dependencies", () => {
    const allOff = {
      [BILLING_PLUGIN_NAME]: { enabled: false },
      [PAYMENTS_PLUGIN_NAME]: { enabled: false },
      [PESAPAL_PLUGIN_NAME]: { enabled: false },
    };
    expect(
      validatePluginToggle({ pluginName: METERING_PLUGIN_NAME, enabled: false, states: allOff })
    ).toEqual({ ok: true });
    // Turned on, it blocks them like any dependent.
    expect(
      validatePluginToggle({
        pluginName: METERING_PLUGIN_NAME,
        enabled: false,
        states: { ...allOff, [TENANT_APP_PLUGIN_NAME]: { enabled: true } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Tenant app"),
    });
    expect(
      validatePluginToggle({
        pluginName: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
        enabled: false,
        states: {
          ...allOff,
          [METERING_PLUGIN_NAME]: { enabled: false },
          [TENANT_APP_PLUGIN_NAME]: { enabled: true },
        },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Tenant app"),
    });
  });

  it("metering depends on community management, not the reverse", () => {
    // Disabling metering never blocks community management — but it is
    // blocked while its own dependent (billing) is enabled.
    expect(
      validatePluginToggle({
        pluginName: METERING_PLUGIN_NAME,
        enabled: false,
        states: { [BILLING_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({ ok: true });
    expect(
      validatePluginToggle({
        pluginName: METERING_PLUGIN_NAME,
        enabled: false,
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Billing"),
    });
    // Disabling community management is blocked while metering is enabled.
    expect(
      validatePluginToggle({
        pluginName: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
        enabled: false,
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Metering"),
    });
  });

  it("marks community management not ready when its dependency is disabled", () => {
    const statuses = resolvePluginStatuses({
      [ORGANIZATION_DIRECTORY_PLUGIN_NAME]: { enabled: false },
    });
    const community = statuses.find(
      (status) => status.plugin.name === COMMUNITY_MANAGEMENT_PLUGIN_NAME
    );
    expect(community?.enabled).toBe(true);
    expect(community?.ready).toBe(false);
    expect(community?.disabledDependencies).toEqual([
      ORGANIZATION_DIRECTORY_PLUGIN_NAME,
    ]);
  });

  it("rejects unknown plugins", () => {
    expect(
      validatePluginToggle({ pluginName: "online-payments", enabled: true })
    ).toEqual({
      ok: false,
      code: "unknown_plugin",
      message: expect.stringContaining("Only bundled MGM plugins"),
    });
  });

  it("locks the organization directory against disable", () => {
    expect(
      validatePluginToggle({
        pluginName: ORGANIZATION_DIRECTORY_PLUGIN_NAME,
        enabled: false,
      })
    ).toEqual({
      ok: false,
      code: "plugin_core_locked",
      message: expect.stringContaining("cannot be disabled"),
    });
  });

  it("rejects enabling community management while its dependency is disabled", () => {
    expect(
      validatePluginToggle({
        pluginName: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
        enabled: true,
        states: { [ORGANIZATION_DIRECTORY_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_disabled",
      message: expect.stringContaining("Organization directory"),
    });
  });

  it("allows disabling community management when nothing depends on it", () => {
    expect(
      validatePluginToggle({
        pluginName: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
        enabled: false,
        states: {
          [METERING_PLUGIN_NAME]: { enabled: false },
          [BILLING_PLUGIN_NAME]: { enabled: false },
          [PAYMENTS_PLUGIN_NAME]: { enabled: false },
          [PESAPAL_PLUGIN_NAME]: { enabled: false },
        },
      })
    ).toEqual({ ok: true });
  });

  it("the operations plugin depends on community management only and owns nothing yet", () => {
    expect(OPERATIONS_PLUGIN).toMatchObject({
      core: false,
      defaultEnabled: false,
      displayName: "Investigations",
      dependencies: [COMMUNITY_MANAGEMENT_PLUGIN_NAME],
      routes: [],
      pages: [],
      tables: [],
    });
    // On with metering off: an investigation records metering's refusal as
    // evidence (docs/investigation-cases.md, case C14).
    expect(
      validatePluginToggle({
        pluginName: OPERATIONS_PLUGIN_NAME,
        enabled: true,
        states: {
          [METERING_PLUGIN_NAME]: { enabled: false },
          [BILLING_PLUGIN_NAME]: { enabled: false },
          [PAYMENTS_PLUGIN_NAME]: { enabled: false },
          [PESAPAL_PLUGIN_NAME]: { enabled: false },
        },
      })
    ).toEqual({ ok: true });
    expect(
      validatePluginToggle({
        pluginName: OPERATIONS_PLUGIN_NAME,
        enabled: true,
        states: { [COMMUNITY_MANAGEMENT_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_disabled",
      message: expect.stringContaining("Community management"),
    });
  });

  it("lets community management be turned off while the operations plugin has no row, and not while it is on", () => {
    const othersOff = {
      [METERING_PLUGIN_NAME]: { enabled: false },
      [BILLING_PLUGIN_NAME]: { enabled: false },
      [PAYMENTS_PLUGIN_NAME]: { enabled: false },
      [PESAPAL_PLUGIN_NAME]: { enabled: false },
    };
    expect(
      validatePluginToggle({ pluginName: COMMUNITY_MANAGEMENT_PLUGIN_NAME, enabled: false, states: othersOff })
    ).toEqual({ ok: true });
    expect(
      validatePluginToggle({
        pluginName: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
        enabled: false,
        states: { ...othersOff, [OPERATIONS_PLUGIN_NAME]: { enabled: true } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Investigations"),
    });
  });

  it("payments depends on billing; pesapal depends on payments", () => {
    expect(
      validatePluginToggle({
        pluginName: PAYMENTS_PLUGIN_NAME,
        enabled: false,
        states: { [PESAPAL_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({ ok: true });
    expect(
      validatePluginToggle({
        pluginName: PAYMENTS_PLUGIN_NAME,
        enabled: false,
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Pesapal"),
    });
    expect(
      validatePluginToggle({
        pluginName: BILLING_PLUGIN_NAME,
        enabled: false,
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Payments"),
    });
    expect(
      validatePluginToggle({
        pluginName: PESAPAL_PLUGIN_NAME,
        enabled: true,
        states: { [PAYMENTS_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_disabled",
      message: expect.stringContaining("Payments"),
    });
    expect(
      validatePluginToggle({
        pluginName: PAYMENTS_PLUGIN_NAME,
        enabled: true,
        states: { [BILLING_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_disabled",
      message: expect.stringContaining("Billing"),
    });
  });

  it("billing depends on metering, not the reverse", () => {
    // Disabling billing never blocks metering — but it is blocked while its
    // own dependent (payments) is enabled.
    expect(
      validatePluginToggle({
        pluginName: BILLING_PLUGIN_NAME,
        enabled: false,
        states: {
          [PAYMENTS_PLUGIN_NAME]: { enabled: false },
          [PESAPAL_PLUGIN_NAME]: { enabled: false },
        },
      })
    ).toEqual({ ok: true });
    // Disabling metering is blocked while billing is enabled.
    expect(
      validatePluginToggle({
        pluginName: METERING_PLUGIN_NAME,
        enabled: false,
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_required",
      message: expect.stringContaining("Billing"),
    });
  });

  it("rejects enabling billing while metering is disabled", () => {
    expect(
      validatePluginToggle({
        pluginName: BILLING_PLUGIN_NAME,
        enabled: true,
        states: { [METERING_PLUGIN_NAME]: { enabled: false } },
      })
    ).toEqual({
      ok: false,
      code: "plugin_dependency_disabled",
      message: expect.stringContaining("Metering"),
    });
  });
});

describe("getRouteOwner", () => {
  it.each([
    ["/api/organizations/abc/plugins", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/api/organizations/abc/payment-accounts", PAYMENTS_PLUGIN_NAME],
    ["/api/communities/abc", COMMUNITY_MANAGEMENT_PLUGIN_NAME],
    ["/api/communities/abc/invoice-config", BILLING_PLUGIN_NAME],
    ["/api/communities/abc/payment/override", PAYMENTS_PLUGIN_NAME],
    ["/api/tenants/abc", COMMUNITY_MANAGEMENT_PLUGIN_NAME],
    ["/api/tenants/abc/assignments", METERING_PLUGIN_NAME],
    ["/api/microgrids/[id]/openems-backend/discover", METERING_PLUGIN_NAME],
    ["/api/billing-line-items/[lineItemId]/pdf", BILLING_PLUGIN_NAME],
    ["/api/billing-line-items/[lineItemId]/pay", PAYMENTS_PLUGIN_NAME],
    ["/api/payments/ipn", PESAPAL_PLUGIN_NAME],
    ["/", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/api/gui/view", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/api/gui/prepare", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/api/gui/signals", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/api/gui/search", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/api/gui/manifest", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/api/gui/catalog", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
  ])("%s belongs to %s", async (route, plugin) => {
    const { getRouteOwner } = await import("../bundled");
    expect(getRouteOwner(route)?.name).toBe(plugin);
  });

  it.each([
    ["/microgrids/[id]/operations", METERING_PLUGIN_NAME],
    ["/microgrids/[id]/billing/[periodId]/history", BILLING_PLUGIN_NAME],
    ["/microgrids/[id]/billing/[periodId]/close", BILLING_PLUGIN_NAME],
    ["/microgrids/[id]/billing/[periodId]/send", BILLING_PLUGIN_NAME],
    // Payments' own page under a period, which outranks billing's period page.
    ["/microgrids/[id]/billing/[periodId]/payments", PAYMENTS_PLUGIN_NAME],
    ["/microgrids/[id]/setup/rates", BILLING_PLUGIN_NAME],
    ["/microgrids/[id]/setup/edges/shared", METERING_PLUGIN_NAME],
    ["/microgrids/[id]/setup/tenants", COMMUNITY_MANAGEMENT_PLUGIN_NAME],
    ["/microgrids/[id]/setup", COMMUNITY_MANAGEMENT_PLUGIN_NAME],
    ["/microgrids/[id]", COMMUNITY_MANAGEMENT_PLUGIN_NAME],
    ["/organizations/[id]/payments", PAYMENTS_PLUGIN_NAME],
    ["/communities/[id]/payment", PAYMENTS_PLUGIN_NAME],
    ["/communities/[id]/invoice", BILLING_PLUGIN_NAME],
    ["/settings/plugins", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
    ["/go/[nav]", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
  ])("page %s belongs to %s", (route, plugin) => {
    expect(getRouteOwner(route)?.name).toBe(plugin);
  });

  it("does not let the root page claim every route", async () => {
    const { getRouteOwner } = await import("../bundled");
    expect(getRouteOwner("/api/unclaimed")).toBeUndefined();
  });
});

describe("getRouteOwner with a plugin list", () => {
  it("reads ownership from the list it is given", () => {
    const plugins = [
      COMMUNITY_MANAGEMENT_PLUGIN,
      { ...METERING_PLUGIN, routes: ["/api/communities/[id]/readings"] },
    ];
    expect(getRouteOwner("/api/communities/abc/readings", plugins)?.name).toBe(
      METERING_PLUGIN_NAME
    );
    expect(getRouteOwner("/api/communities/abc", plugins)?.name).toBe(
      COMMUNITY_MANAGEMENT_PLUGIN_NAME
    );
    // The bundled catalog gives the same path to community management.
    expect(getRouteOwner("/api/communities/abc/readings")?.name).toBe(
      COMMUNITY_MANAGEMENT_PLUGIN_NAME
    );
  });

  it("finds no owner in an empty list", () => {
    expect(getRouteOwner("/api/communities/abc", [])).toBeUndefined();
  });
});

describe("plugin aliases", () => {
  it("gives each plugin its alias", () => {
    expect(MGM_BUNDLED_PLUGINS.map((plugin) => [plugin.name, plugin.alias])).toEqual([
      [ORGANIZATION_DIRECTORY_PLUGIN_NAME, "org"],
      [COMMUNITY_MANAGEMENT_PLUGIN_NAME, "community"],
      [METERING_PLUGIN_NAME, "metering"],
      [BILLING_PLUGIN_NAME, "billing"],
      [PAYMENTS_PLUGIN_NAME, "payments"],
      [PESAPAL_PLUGIN_NAME, "pesapal"],
      [TENANT_APP_PLUGIN_NAME, "tenant"],
      [OPERATIONS_PLUGIN_NAME, "operations"],
    ]);
  });

  it("uses lowercase letters, digits and hyphens, starting with a letter", () => {
    for (const plugin of MGM_BUNDLED_PLUGINS) {
      expect(plugin.alias, plugin.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("is unique in the catalog", () => {
    const aliases = MGM_BUNDLED_PLUGINS.map((plugin) => plugin.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("finds a plugin by its alias and not by its name", () => {
    for (const plugin of MGM_BUNDLED_PLUGINS) {
      expect(getPluginByAlias(plugin.alias)).toBe(plugin);
    }
    expect(getPluginByAlias("org")?.name).toBe(ORGANIZATION_DIRECTORY_PLUGIN_NAME);
    expect(getPluginByAlias("community")?.name).toBe(COMMUNITY_MANAGEMENT_PLUGIN_NAME);
    expect(getPluginByAlias(ORGANIZATION_DIRECTORY_PLUGIN_NAME)).toBeUndefined();
    expect(getPluginByAlias("")).toBeUndefined();
  });
});

describe("core entity kinds", () => {
  it("lists each kind once", () => {
    expect(new Set(CORE_ENTITY_KINDS).size).toBe(CORE_ENTITY_KINDS.length);
  });
});

describe("matchCatalogPage", () => {
  it("returns the page, its plugin and the segment values", () => {
    const match = matchCatalogPage("/microgrids/abc/billing/p1/history");
    expect(match?.plugin.name).toBe(BILLING_PLUGIN_NAME);
    expect(match?.page.path).toBe("/microgrids/[id]/billing/[periodId]/history");
    expect(match?.values).toEqual({ id: "abc", periodId: "p1" });
  });

  it("prefers a fixed segment to a bracketed one", () => {
    const match = matchCatalogPage("/microgrids/abc/setup/edges/shared");
    expect(match?.page.path).toBe("/microgrids/[id]/setup/edges/shared");
    expect(match?.values).toEqual({ id: "abc" });
  });

  it.each([
    ["listed first", [{ path: "/x/shared", params: {} }, { path: "/x/[id]", params: { id: "edge" } }]],
    ["listed last", [{ path: "/x/[id]", params: { id: "edge" } }, { path: "/x/shared", params: {} }]],
  ] as const)("prefers a fixed segment whether it is %s", (_order, pages) => {
    const plugins = [{ ...METERING_PLUGIN, pages }];
    expect(matchCatalogPage("/x/shared", plugins)?.page.path).toBe("/x/shared");
    expect(matchCatalogPage("/x/e1", plugins)?.page.path).toBe("/x/[id]");
  });

  it("ignores a trailing slash, the query and the fragment", () => {
    expect(matchCatalogPage("/microgrids/abc/setup/edges/e1/")?.values).toEqual({
      id: "abc",
      edgeId: "e1",
    });
    const operations = matchCatalogPage("/microgrids/abc/operations?date=2026-11-01#top");
    expect(operations?.plugin.name).toBe(METERING_PLUGIN_NAME);
    expect(operations?.values).toEqual({ id: "abc" });
    expect(matchCatalogPage("/microgrids/abc/operations#top")?.values).toEqual({ id: "abc" });
  });

  it("returns segment values as they appear in the URL", () => {
    expect(matchCatalogPage("/microgrids/a%2Fb/operations")?.values.id).toBe("a%2Fb");
  });

  it("matches the root page", () => {
    const match = matchCatalogPage("/");
    expect(match?.plugin.name).toBe(ORGANIZATION_DIRECTORY_PLUGIN_NAME);
    expect(match?.values).toEqual({});
  });

  it.each([
    "/api/microgrids/abc/edges",
    "/microgrids/abc",
    "/microgrids/abc/operations/extra",
    "/login",
  ])("finds no page for %s", (pathname) => {
    expect(matchCatalogPage(pathname)).toBeUndefined();
  });

  it("reads pages from the list it is given", () => {
    expect(matchCatalogPage("/communities/abc/payment", [COMMUNITY_MANAGEMENT_PLUGIN])).toBeUndefined();
  });
});
