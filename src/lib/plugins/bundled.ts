/**
 * bundled.ts — trusted MGM plugin catalog for Release 1 (issue #3).
 *
 * Client-safe: no server imports. Server routes and UI share these definitions
 * so Settings, navigation, and mutation gates cannot drift from each other.
 * Database state lives in `mgm_plugins`; a missing row means "enabled", which
 * keeps existing deployments working without a backfill.
 */

export const ORGANIZATION_DIRECTORY_PLUGIN_NAME =
  "organization-directory" as const;
export const COMMUNITY_MANAGEMENT_PLUGIN_NAME =
  "community-management" as const;
export const METERING_PLUGIN_NAME = "metering" as const;

export type MgmPluginName =
  | typeof ORGANIZATION_DIRECTORY_PLUGIN_NAME
  | typeof COMMUNITY_MANAGEMENT_PLUGIN_NAME
  | typeof METERING_PLUGIN_NAME;

export const ORGANIZATION_DIRECTORY_PLUGIN_VERSION = "0.1.0";
export const COMMUNITY_MANAGEMENT_PLUGIN_VERSION = "0.1.0";
export const METERING_PLUGIN_VERSION = "0.1.0";

export interface BundledPlugin {
  name: MgmPluginName;
  version: string;
  displayName: string;
  description: string;
  dependencies: MgmPluginName[];
  /** Core plugins own the admin surface itself and cannot be disabled. */
  core: boolean;
  provides: string[];
  routes: string[];
  tables: string[];
}

export const ORGANIZATION_DIRECTORY_PLUGIN: BundledPlugin = {
  name: ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  version: ORGANIZATION_DIRECTORY_PLUGIN_VERSION,
  displayName: "Organization directory",
  description:
    "Organizations, membership roles, user invitations, and organization settings.",
  dependencies: [],
  core: true,
  provides: [
    "organizations",
    "organization membership",
    "user invitations",
    "organization settings",
  ],
  routes: [
    "/",
    "/organizations",
    "/settings",
    "/setup",
    "/api/mgm/bootstrap",
    "/api/organizations",
    "/api/users",
  ],
  tables: ["organizations", "user_roles", "user_profiles", "mgm_plugins"],
};

export const COMMUNITY_MANAGEMENT_PLUGIN: BundledPlugin = {
  name: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  version: COMMUNITY_MANAGEMENT_PLUGIN_VERSION,
  displayName: "Community management",
  description:
    "Communities, microgrids, households, and hierarchy operations for one organization.",
  dependencies: [ORGANIZATION_DIRECTORY_PLUGIN_NAME],
  core: false,
  provides: [
    "communities",
    "microgrids",
    "households",
    "hierarchy navigation",
  ],
  routes: [
    "/communities",
    "/microgrids",
    "/api/communities",
    "/api/microgrids",
    "/api/households",
  ],
  tables: ["communities", "microgrids", "households"],
};

export const METERING_PLUGIN: BundledPlugin = {
  name: METERING_PLUGIN_NAME,
  version: METERING_PLUGIN_VERSION,
  displayName: "Metering",
  description:
    "OpenEMS connection testing, meter discovery and registration, meter-to-household assignments, and consumption reads for one organization.",
  dependencies: [COMMUNITY_MANAGEMENT_PLUGIN_NAME],
  core: false,
  // Plugin-enabled and connection-ready are separate states (issue #4): the
  // toggle below gates the metering surface, while per-microgrid readiness
  // is derived from the stored OpenEMS configuration plus a successful
  // connection test or discovery run. Disabling preserves all stored
  // configuration, assignments, and readings.
  provides: [
    "connection testing",
    "meter discovery and registration",
    "meter assignments",
    "consumption reads",
  ],
  routes: [
    "/api/microgrids/[id]/openems-backend",
    "/api/meter-readings",
  ],
  tables: ["devices", "edges", "household_devices", "meter_readings"],
};

export const MGM_BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  ORGANIZATION_DIRECTORY_PLUGIN,
  COMMUNITY_MANAGEMENT_PLUGIN,
  METERING_PLUGIN,
] as const;

export function getBundledPlugin(
  pluginName: string
): BundledPlugin | undefined {
  return MGM_BUNDLED_PLUGINS.find((plugin) => plugin.name === pluginName);
}

export function getPluginDependents(
  pluginName: MgmPluginName
): BundledPlugin[] {
  return MGM_BUNDLED_PLUGINS.filter((plugin) =>
    plugin.dependencies.includes(pluginName)
  );
}

export type PluginStateInput = {
  enabled?: boolean | null;
  version?: string | null;
};

export type ResolvedPluginStatus = {
  plugin: BundledPlugin;
  enabled: boolean;
  version: string;
  /** Readiness is dependency readiness in this release. */
  ready: boolean;
  disabledDependencies: MgmPluginName[];
};

export function resolvePluginStatuses(
  states: Partial<Record<MgmPluginName, PluginStateInput>> = {}
): ResolvedPluginStatus[] {
  const enabledByName = new Map<MgmPluginName, boolean>(
    MGM_BUNDLED_PLUGINS.map((plugin) => [
      plugin.name,
      states[plugin.name]?.enabled ?? true,
    ])
  );

  return MGM_BUNDLED_PLUGINS.map((plugin) => {
    const disabledDependencies = plugin.dependencies.filter(
      (dependency) => !enabledByName.get(dependency)
    );
    return {
      plugin,
      enabled: enabledByName.get(plugin.name) ?? true,
      version: states[plugin.name]?.version?.trim()
        ? (states[plugin.name]?.version as string).trim()
        : plugin.version,
      ready: disabledDependencies.length === 0,
      disabledDependencies,
    };
  });
}

export type PluginToggleValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function validatePluginToggle(input: {
  pluginName: string;
  enabled: boolean;
  states?: Partial<Record<MgmPluginName, PluginStateInput>>;
}): PluginToggleValidation {
  const plugin = getBundledPlugin(input.pluginName);
  if (!plugin) {
    return {
      ok: false,
      code: "unknown_plugin",
      message: `Unknown plugin: ${input.pluginName}. Only bundled MGM plugins can be changed.`,
    };
  }

  if (plugin.core && !input.enabled) {
    return {
      ok: false,
      code: "plugin_core_locked",
      message: `${plugin.displayName} cannot be disabled because it owns organizations, membership, and settings.`,
    };
  }

  const statuses = resolvePluginStatuses(input.states);
  const statusByName = new Map(statuses.map((status) => [status.plugin.name, status]));

  if (input.enabled) {
    // Re-resolve with the requested enable applied: enabling a plugin cannot
    // succeed while one of its dependencies remains disabled.
    const nextStates = {
      ...input.states,
      [plugin.name]: { enabled: true },
    };
    const nextDisabled = resolvePluginStatuses(nextStates).find(
      (status) => status.plugin.name === plugin.name
    )?.disabledDependencies;
    if (nextDisabled && nextDisabled.length > 0) {
      const names = nextDisabled
        .map((name) => getBundledPlugin(name)?.displayName ?? name)
        .join(", ");
      return {
        ok: false,
        code: "plugin_dependency_disabled",
        message: `${plugin.displayName} cannot be enabled while ${names} is disabled.`,
      };
    }
    return { ok: true };
  }

  const blockingDependents = getPluginDependents(plugin.name).filter(
    (dependent) => statusByName.get(dependent.name)?.enabled ?? true
  );
  if (blockingDependents.length > 0) {
    const names = blockingDependents
      .map((dependent) => dependent.displayName)
      .join(", ");
    return {
      ok: false,
      code: "plugin_dependency_required",
      message: `${plugin.displayName} cannot be disabled while ${names} is enabled. Disable ${names} first.`,
    };
  }

  return { ok: true };
}
