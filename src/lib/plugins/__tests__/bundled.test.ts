import { describe, expect, it } from "vitest";
import {
  COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  resolvePluginStatuses,
  validatePluginToggle,
} from "../bundled";

describe("MGM bundled plugins", () => {
  it("defaults missing state rows to enabled", () => {
    const statuses = resolvePluginStatuses();
    expect(
      statuses.map((status) => [status.plugin.name, status.enabled, status.ready])
    ).toEqual([
      [ORGANIZATION_DIRECTORY_PLUGIN_NAME, true, true],
      [COMMUNITY_MANAGEMENT_PLUGIN_NAME, true, true],
    ]);
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
      validatePluginToggle({ pluginName: "billing", enabled: true })
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
      })
    ).toEqual({ ok: true });
  });
});
