/**
 * bundled.ts — trusted MGM plugin catalog for Release 1 (issue #3).
 *
 * Client-safe: no server imports. Server routes and UI share these definitions
 * so Settings, navigation, and mutation gates cannot drift from each other.
 * Database state lives in `mgm_plugins`. A missing row means the plugin's
 * `defaultEnabled`, which is "enabled" for every plugin but the tenant app,
 * so existing deployments keep working without a backfill.
 */

export const ORGANIZATION_DIRECTORY_PLUGIN_NAME =
  "organization-directory" as const;
export const COMMUNITY_MANAGEMENT_PLUGIN_NAME =
  "community-management" as const;
export const METERING_PLUGIN_NAME = "metering" as const;
export const BILLING_PLUGIN_NAME = "billing" as const;
export const PAYMENTS_PLUGIN_NAME = "payments" as const;
export const PESAPAL_PLUGIN_NAME = "pesapal" as const;
export const TENANT_APP_PLUGIN_NAME = "tenant-app" as const;

export type MgmPluginName =
  | typeof ORGANIZATION_DIRECTORY_PLUGIN_NAME
  | typeof COMMUNITY_MANAGEMENT_PLUGIN_NAME
  | typeof METERING_PLUGIN_NAME
  | typeof BILLING_PLUGIN_NAME
  | typeof PAYMENTS_PLUGIN_NAME
  | typeof PESAPAL_PLUGIN_NAME
  | typeof TENANT_APP_PLUGIN_NAME;

export const ORGANIZATION_DIRECTORY_PLUGIN_VERSION = "0.1.0";
export const COMMUNITY_MANAGEMENT_PLUGIN_VERSION = "0.1.0";
export const METERING_PLUGIN_VERSION = "0.1.0";
export const BILLING_PLUGIN_VERSION = "0.1.0";
export const PAYMENTS_PLUGIN_VERSION = "0.1.0";
export const PESAPAL_PLUGIN_VERSION = "0.1.0";
export const TENANT_APP_PLUGIN_VERSION = "0.1.0";

/**
 * The kinds of core record whose owning organization MGM can resolve. Kept
 * here, in a file with no imports, so client code can name a kind.
 * GateTarget in src/lib/runtime/gate.ts has one case per kind, and
 * gate.test.ts fails while the two lists differ, so add a kind to both in
 * the same change.
 */
export const CORE_ENTITY_KINDS = [
  "organization",
  "community",
  "microgrid",
  "edge",
  "device",
  "tenant",
  "rateSchedule",
  "billingPeriod",
  "lineItem",
  "paymentAttempt",
] as const;

export type CoreEntityKind = (typeof CORE_ENTITY_KINDS)[number];

/** A signed-in page a plugin owns, with the entity kind of each segment. */
export interface CatalogPage {
  /** The route as spelled under src/app, with route-group folders left out. */
  path: string;
  /** The kind of every bracketed segment, keyed by its name, in path order. */
  params: Readonly<Record<string, CoreEntityKind>>;
  /**
   * "view" when a contributed GUI view serves the path and no page.tsx
   * exists; absent when a page.tsx serves it. catalog-pages.test.ts checks
   * this against src/app.
   */
  servedBy?: "view";
}

export interface BundledPlugin {
  name: MgmPluginName;
  /**
   * Short prefix for the ids this plugin names, as in "billing.period":
   * lowercase letters, digits and hyphens, starting with a letter, and
   * unique in the catalog. bundled.test.ts checks both. getPluginByAlias
   * finds the plugin from it.
   */
  alias: string;
  version: string;
  displayName: string;
  description: string;
  dependencies: MgmPluginName[];
  /** Core plugins own the admin surface itself and cannot be disabled. */
  core: boolean;
  /**
   * Whether the plugin is on for an organization that has no `mgm_plugins`
   * row for it. Absent means true. `false` makes the plugin off until an
   * operator turns it on for each organization (the tenant app, RFC
   * mgm#197 § 3). The database answers the same question in
   * `mgm_plugin_enabled_for_org`, which lists these plugins by name; the
   * gate, the GUI host and the composers read plugin state there, Settings →
   * Plugins reads it here (resolvePluginStatuses). If a plugin's default
   * changes, change that function's list in a new migration in the same
   * commit: default-off-plugins.test.ts fails while the two lists differ.
   */
  defaultEnabled?: false;
  provides: string[];
  routes: string[];
  /**
   * The signed-in pages this plugin owns. getRouteOwner reads each path as
   * an ownership prefix too; matchCatalogPage finds the page for a URL.
   */
  pages: readonly CatalogPage[];
  tables: string[];
}

export const ORGANIZATION_DIRECTORY_PLUGIN: BundledPlugin = {
  name: ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  alias: "org",
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
    // Sign-in by email link (RFC #186).
    "/api/auth",
    "/api/organizations",
    "/api/users",
    "/api/org-api-tokens",
    // The GUI host's routes, which serve every plugin's contributions to the signed-in person.
    "/api/gui",
    // The GUI host's page that opens any plugin's navigation entry by its id.
    "/go",
  ],
  pages: [
    // Today, the home page, as the org.today view.
    { path: "/", params: {}, servedBy: "view" },
    { path: "/organizations", params: {} },
    { path: "/organizations/[id]", params: { id: "organization" } },
    { path: "/organizations/[id]/email", params: { id: "organization" } },
    { path: "/settings/profile", params: {} },
    { path: "/settings/users", params: {} },
    { path: "/settings/plugins", params: {} },
    { path: "/settings/api-tokens", params: {} },
  ],
  tables: ["organizations", "user_roles", "user_profiles", "mgm_plugins", "organization_email_senders"],
};

export const COMMUNITY_MANAGEMENT_PLUGIN: BundledPlugin = {
  name: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  alias: "community",
  version: COMMUNITY_MANAGEMENT_PLUGIN_VERSION,
  displayName: "Community management",
  description:
    "Communities, microgrids, tenants, and hierarchy operations for one organization.",
  dependencies: [ORGANIZATION_DIRECTORY_PLUGIN_NAME],
  core: false,
  provides: [
    "communities",
    "microgrids",
    "tenants",
    "hierarchy navigation",
  ],
  routes: [
    "/communities",
    "/microgrids",
    "/api/communities",
    "/api/microgrids",
    "/api/tenants",
    "/api/v1/microgrids",
  ],
  pages: [
    { path: "/communities", params: {} },
    { path: "/communities/[id]", params: { id: "community" } },
    { path: "/microgrids", params: {} },
    // The setup index redirects to the first setup tab, whichever plugin owns
    // that tab, so it stays with the plugin that owns the microgrid.
    { path: "/microgrids/[id]/setup", params: { id: "microgrid" } },
    { path: "/microgrids/[id]/setup/tenants", params: { id: "microgrid" } },
    {
      path: "/microgrids/[id]/setup/tenants/[tenantId]",
      params: { id: "microgrid", tenantId: "tenant" },
    },
  ],
  tables: ["communities", "microgrids", "tenants"],
};

export const METERING_PLUGIN: BundledPlugin = {
  name: METERING_PLUGIN_NAME,
  alias: "metering",
  version: METERING_PLUGIN_VERSION,
  displayName: "Metering",
  description:
    "OpenEMS connection testing, meter discovery and registration, meter-to-tenant assignments, and consumption reads for one organization.",
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
    "/api/microgrids/[id]/edges",
    "/api/edges",
    "/api/devices",
    "/api/tenants/[id]/assignments",
    "/api/metering",
    "/api/meter-readings",
    "/api/openems",
  ],
  pages: [
    // The Operations day, as the metering.site-day view.
    {
      path: "/microgrids/[id]/operations",
      params: { id: "microgrid" },
      servedBy: "view",
    },
    { path: "/microgrids/[id]/setup/edges", params: { id: "microgrid" } },
    {
      path: "/microgrids/[id]/setup/edges/[edgeId]",
      params: { id: "microgrid", edgeId: "edge" },
    },
    { path: "/microgrids/[id]/setup/edges/shared", params: { id: "microgrid" } },
    {
      path: "/microgrids/[id]/setup/openems-backend",
      params: { id: "microgrid" },
    },
  ],
  tables: ["devices", "edges", "tenant_devices", "meter_readings"],
};

export const BILLING_PLUGIN: BundledPlugin = {
  name: BILLING_PLUGIN_NAME,
  alias: "billing",
  version: BILLING_PLUGIN_VERSION,
  displayName: "Billing",
  description:
    "Tariffs, billing periods, tenant bills, invoices, and manual payments for one organization.",
  dependencies: [METERING_PLUGIN_NAME],
  core: false,
  // Billing reads metering data through the metering capability — never a
  // vendor client. Disabling preserves tariffs, periods, bills, invoices,
  // and payment history.
  provides: [
    "tariffs",
    "billing periods",
    "bill generation",
    "invoices",
    "manual payments",
  ],
  routes: [
    "/api/rate-schedules",
    "/api/billing",
    "/api/billing-periods",
    "/api/billing-line-items",
    "/api/billing-review",
    "/api/communities/[id]/invoice-config",
    "/api/communities/[id]/invoice-preview",
    "/api/communities/[id]/invoice-logo",
    // Grid tariffs and savings settings value a microgrid's own operations
    // (solar savings, battery arbitrage) against what it pays the grid.
    "/api/microgrids/[id]/grid-tariffs",
    "/api/microgrids/[id]/savings-settings",
    "/api/v1/billing-periods",
    "/api/v1/billing",
  ],
  pages: [
    // Each microgrid's newest period, as the billing.current-periods view,
    // a tile on Today.
    { path: "/billing", params: {}, servedBy: "view" },
    // A microgrid's billing periods, as the billing.periods view.
    { path: "/microgrids/[id]/billing", params: { id: "microgrid" }, servedBy: "view" },
    // A period's review stays its page.tsx while a parity row of the
    // period-review screen is pending (src/lib/billing/parity.ts, enforced by
    // parity.test.ts); once none is, it becomes the billing.period-review view.
    {
      path: "/microgrids/[id]/billing/[periodId]",
      params: { id: "microgrid", periodId: "billingPeriod" },
    },
    // A period's audit history, as the billing.period-history view.
    {
      path: "/microgrids/[id]/billing/[periodId]/history",
      params: { id: "microgrid", periodId: "billingPeriod" },
      servedBy: "view",
    },
    // The close checklist, as the billing.close-checklist view.
    {
      path: "/microgrids/[id]/billing/[periodId]/close",
      params: { id: "microgrid", periodId: "billingPeriod" },
      servedBy: "view",
    },
    // The send queue, as the billing.send-queue view.
    {
      path: "/microgrids/[id]/billing/[periodId]/send",
      params: { id: "microgrid", periodId: "billingPeriod" },
      servedBy: "view",
    },
    // The tenants with no bill for a period, as the billing.not-billed view,
    // a section of the period review.
    {
      path: "/microgrids/[id]/billing/[periodId]/not-billed",
      params: { id: "microgrid", periodId: "billingPeriod" },
      servedBy: "view",
    },
    { path: "/microgrids/[id]/setup/rates", params: { id: "microgrid" } },
    { path: "/communities/[id]/invoice", params: { id: "community" } },
    // The savings under the Operations day, as the billing.savings view.
    {
      path: "/microgrids/[id]/operations/savings",
      params: { id: "microgrid" },
      servedBy: "view",
    },
  ],
  tables: [
    "rate_schedules",
    "billing_periods",
    "billing_line_items",
    "billing_audit_log",
    "payment_events",
    "grid_tariffs",
    "microgrid_savings_settings",
  ],
};

export const PAYMENTS_PLUGIN: BundledPlugin = {
  name: PAYMENTS_PLUGIN_NAME,
  alias: "payments",
  version: PAYMENTS_PLUGIN_VERSION,
  displayName: "Payments",
  description:
    "Online payment checkout attempts, verification, receipts, and reconciliation for one organization. Billing stays usable without an online provider.",
  dependencies: [BILLING_PLUGIN_NAME],
  core: false,
  // Payments owns checkout attempts, reconciliation and audit history.
  // Disabling stops new checkouts but preserves history and reconciliation
  // of existing attempts.
  provides: [
    "checkout attempts",
    "payment verification",
    "payment receipts",
    "reconciliation",
  ],
  routes: [
    "/api/payments",
    "/api/billing-line-items/[id]/pay",
    "/api/billing-line-items/[id]/url",
    "/api/organizations/[id]/payment-accounts",
    "/api/communities/[id]/payment",
  ],
  pages: [
    { path: "/organizations/[id]/payments", params: { id: "organization" } },
    { path: "/communities/[id]/payment", params: { id: "community" } },
    // A billing period's bills and one bill's payment attempts, as the
    // payments.bill-attempts view, shown as a tab of billing's period review.
    {
      path: "/microgrids/[id]/billing/[periodId]/payments",
      params: { id: "microgrid", periodId: "billingPeriod" },
      servedBy: "view",
    },
    // The community's payment readiness, with the link to its Payment page,
    // as the payments.payment-setup view, a section of billing's send queue.
    {
      path: "/microgrids/[id]/billing/[periodId]/payment-setup",
      params: { id: "microgrid", periodId: "billingPeriod" },
      servedBy: "view",
    },
  ],
  tables: [
    "payment_merchant_accounts",
    "community_payment_overrides",
    "payment_attempts",
    "payment_receipts",
    "payment_notifications",
  ],
};

export const PESAPAL_PLUGIN: BundledPlugin = {
  name: PESAPAL_PLUGIN_NAME,
  alias: "pesapal",
  version: PESAPAL_PLUGIN_VERSION,
  displayName: "Pesapal",
  description:
    "Pesapal provider implementation for the Payments capability (sandbox/live checkout, transaction lookup, notification parsing).",
  dependencies: [PAYMENTS_PLUGIN_NAME],
  core: false,
  // Pesapal supplies the provider implementation; credentials, API types and
  // status mappings stay inside this plugin. Disabling stops new Pesapal
  // checkouts but preserves history.
  provides: [
    "pesapal checkout",
    "pesapal transaction lookup",
    "pesapal notifications",
  ],
  routes: ["/api/payments/ipn"],
  pages: [],
  tables: [],
};

export const TENANT_APP_PLUGIN: BundledPlugin = {
  name: TENANT_APP_PLUGIN_NAME,
  alias: "tenant",
  version: TENANT_APP_PLUGIN_VERSION,
  displayName: "Tenant app",
  description:
    "A tenant's own view of their unit, its meters and their use by day and hour, for the tenants the organization gives access to. Off until it is turned on for the organization.",
  dependencies: [METERING_PLUGIN_NAME, COMMUNITY_MANAGEMENT_PLUGIN_NAME],
  core: false,
  // The only plugin that is off without a state row: an operator turns it
  // on for the organizations whose tenants get the app (RFC mgm#197 § 3).
  defaultEnabled: false,
  // Read-only for tenants. It reads tenants and their meter assignments
  // through the tenant's own row-level access, and its meters' use through
  // the metering provider registry; what that read takes on the service
  // role, and why, is in src/lib/tenant-app/infrastructure/usage-source.ts.
  // It owns no API route: its views are read through /api/gui/view. Giving
  // a tenant access is community management's (/api/tenants).
  provides: ["tenant home", "tenant usage"],
  routes: [],
  // Each page's unit comes from the query, not the path, so no page has a
  // bracketed segment.
  pages: [
    // The tenant's home, as the tenant.home view.
    { path: "/my", params: {}, servedBy: "view" },
    // The unit's use per day, as the tenant.usage-month view (?month=YYYY-MM).
    { path: "/my/usage", params: {}, servedBy: "view" },
    // One day's use per hour, as the tenant.usage-day view (?date=YYYY-MM-DD).
    { path: "/my/usage/day", params: {}, servedBy: "view" },
  ],
  tables: [],
};

export const MGM_BUNDLED_PLUGINS: readonly BundledPlugin[] = [
  ORGANIZATION_DIRECTORY_PLUGIN,
  COMMUNITY_MANAGEMENT_PLUGIN,
  METERING_PLUGIN,
  BILLING_PLUGIN,
  PAYMENTS_PLUGIN,
  PESAPAL_PLUGIN,
  TENANT_APP_PLUGIN,
] as const;

/** Whether `plugin` is on for an organization with no `mgm_plugins` row for it. */
export function isEnabledByDefault(plugin: BundledPlugin): boolean {
  return plugin.defaultEnabled ?? true;
}

/**
 * The plugins that are off without a state row, by name. The database's
 * `mgm_plugin_enabled_for_org` keeps the same list; see `defaultEnabled`.
 */
export const DEFAULT_OFF_PLUGIN_NAMES: readonly MgmPluginName[] = MGM_BUNDLED_PLUGINS.filter(
  (plugin) => !isEnabledByDefault(plugin)
).map((plugin) => plugin.name);

export function getBundledPlugin(
  pluginName: string
): BundledPlugin | undefined {
  return MGM_BUNDLED_PLUGINS.find((plugin) => plugin.name === pluginName);
}

export function getPluginByAlias(alias: string): BundledPlugin | undefined {
  return MGM_BUNDLED_PLUGINS.find((plugin) => plugin.alias === alias);
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
      states[plugin.name]?.enabled ?? isEnabledByDefault(plugin),
    ])
  );

  return MGM_BUNDLED_PLUGINS.map((plugin) => {
    const disabledDependencies = plugin.dependencies.filter(
      (dependency) => !enabledByName.get(dependency)
    );
    return {
      plugin,
      enabled: enabledByName.get(plugin.name) ?? isEnabledByDefault(plugin),
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
    (dependent) => statusByName.get(dependent.name)?.enabled ?? isEnabledByDefault(dependent)
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

function routeSegments(route: string): string[] {
  return route
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => (/^\[.+\]$/.test(segment) ? "[]" : segment));
}

/**
 * The bundled plugin that owns an API or page route: the plugin whose
 * `routes` entry or page path is the longest segment-prefix of the path.
 * No page path starts with /api (catalog-pages.test.ts checks this), so
 * pages decide only pages. Bracketed segments (`[id]`) match any one
 * segment. Undefined when no plugin claims the route. `plugins` defaults
 * to the bundled catalog; a test passes its own list to check ownership
 * against a catalog with other routes.
 */
export function getRouteOwner(
  route: string,
  plugins: readonly BundledPlugin[] = MGM_BUNDLED_PLUGINS
): BundledPlugin | undefined {
  const path = routeSegments(route);
  let best: { plugin: BundledPlugin; length: number } | undefined;
  for (const plugin of plugins) {
    for (const pattern of [
      ...plugin.routes,
      ...plugin.pages.map((page) => page.path),
    ]) {
      const segments = routeSegments(pattern);
      if (segments.length > path.length) continue;
      // The root page ("/") owns only itself, not every route.
      if (segments.length === 0 && path.length > 0) continue;
      const matches = segments.every(
        (segment, index) => segment === "[]" || segment === path[index]
      );
      if (matches && (!best || segments.length > best.length)) {
        best = { plugin, length: segments.length };
      }
    }
  }
  return best?.plugin;
}

export type CatalogPageMatch = {
  plugin: BundledPlugin;
  page: CatalogPage;
  /** Each bracketed segment's value by name, as it appears in the URL: not decoded or checked. */
  values: Record<string, string>;
};

/**
 * The catalog page a URL path is, with its segment values. Where two pages
 * fit, a fixed segment beats a bracketed one at the first position they
 * differ, as in Next.js, so ".../setup/edges/shared" is not an edge id.
 * Undefined for API routes and for paths no plugin lists as a page.
 */
export function matchCatalogPage(
  pathname: string,
  plugins: readonly BundledPlugin[] = MGM_BUNDLED_PLUGINS
): CatalogPageMatch | undefined {
  const path = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
  let best: { match: CatalogPageMatch; rank: string } | undefined;
  for (const plugin of plugins) {
    for (const page of plugin.pages) {
      const segments = page.path.split("/").filter(Boolean);
      if (segments.length !== path.length) continue;
      const values: Record<string, string> = {};
      let rank = "";
      const matches = segments.every((segment, index) => {
        const name = /^\[(.+)\]$/.exec(segment)?.[1];
        rank += name ? "0" : "1";
        if (name) values[name] = path[index];
        return name !== undefined || segment === path[index];
      });
      if (matches && (!best || rank > best.rank)) {
        best = { match: { plugin, page, values }, rank };
      }
    }
  }
  return best?.match;
}
