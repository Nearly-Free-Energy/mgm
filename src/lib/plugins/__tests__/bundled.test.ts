import { describe, expect, it } from "vitest";
import {
  BILLING_PLUGIN_NAME,
  COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  METERING_PLUGIN_NAME,
  ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  PAYMENTS_PLUGIN_NAME,
  PESAPAL_PLUGIN_NAME,
  SYNTHETIC_METERING_PLUGIN_NAME,
  resolvePluginStatuses,
  validatePluginToggle,
} from "../bundled";

describe("MGM bundled plugins", () => {
  it("defaults missing state rows to enabled, except demonstration plugins", () => {
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
      [SYNTHETIC_METERING_PLUGIN_NAME, false, true],
    ]);
  });

  it("synthetic metering is off by default and needs metering to enable", () => {
    expect(
      validatePluginToggle({ pluginName: SYNTHETIC_METERING_PLUGIN_NAME, enabled: true })
    ).toEqual({ ok: true });
    const withoutMetering = validatePluginToggle({
      pluginName: SYNTHETIC_METERING_PLUGIN_NAME,
      enabled: true,
      states: { [METERING_PLUGIN_NAME]: { enabled: false } },
    });
    expect(withoutMetering).toMatchObject({ ok: false, code: "plugin_dependency_disabled" });
  });

  it("an enabled synthetic plugin blocks disabling metering", () => {
    expect(
      validatePluginToggle({
        pluginName: METERING_PLUGIN_NAME,
        enabled: false,
        states: {
          [BILLING_PLUGIN_NAME]: { enabled: false },
          [SYNTHETIC_METERING_PLUGIN_NAME]: { enabled: true },
        },
      })
    ).toMatchObject({ ok: false, code: "plugin_dependency_required" });
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
    ["/api/households/abc", COMMUNITY_MANAGEMENT_PLUGIN_NAME],
    ["/api/households/abc/assignments", METERING_PLUGIN_NAME],
    ["/api/microgrids/[id]/openems-backend/discover", METERING_PLUGIN_NAME],
    ["/api/billing-line-items/[lineItemId]/pdf", BILLING_PLUGIN_NAME],
    ["/api/billing-line-items/[lineItemId]/pay", PAYMENTS_PLUGIN_NAME],
    ["/api/payments/ipn", PESAPAL_PLUGIN_NAME],
    ["/", ORGANIZATION_DIRECTORY_PLUGIN_NAME],
  ])("%s belongs to %s", async (route, plugin) => {
    const { getRouteOwner } = await import("../bundled");
    expect(getRouteOwner(route)?.name).toBe(plugin);
  });

  it("does not let the root page claim every route", async () => {
    const { getRouteOwner } = await import("../bundled");
    expect(getRouteOwner("/api/unclaimed")).toBeUndefined();
  });
});
