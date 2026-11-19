import "server-only";

/**
 * What the tenant app contributes to GUIs (src/lib/gui/surface.ts), RFC
 * mgm#197 § 3–5: tenant views about the caller's own unit, with nav entries
 * for the tenant audience. `tenant.home` is the unit and its meters;
 * `tenant.usage-month` and `tenant.usage-day` are its use per day of a month
 * and per hour of a day. Gridtop draws the usage views with its own
 * renderers (src/gui/gridtop/renderers/tenant-usage), which read the exts;
 * other GUIs, and Gridtop on an ext it cannot read, draw them with the kit.
 *
 * Their pages, /my, /my/usage and /my/usage/day, are in the catalog but not
 * released (RFC mgm#197: released by PR 5), so neither the entries nor the
 * pages are offered yet: the manifest lists released pages only, and
 * middleware answers others with 404.
 *
 * Not readable by an assistant, and never will be: a tenant view carries the
 * tenant's own name and unit, which #133's data boundary keeps from any
 * model. contribution-schema.ts refuses `agent` on any tenant view.
 */
import type { Contribution } from "@/lib/gui/surface";
import { TENANT_APP_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { TENANT_HOME_EXAMPLES } from "./surface/examples";
import { loadTenantHome } from "./surface/home";
import { TENANT_HOME_KEYS, TENANT_METER_PREFIX } from "./surface/home-model";
import { loadTenantUsageDay, loadTenantUsageMonth } from "./surface/usage";
import { TenantUsageDayExt, TenantUsageMonthExt } from "./surface/usage-ext";
import { TENANT_USAGE_DAY_EXAMPLES, TENANT_USAGE_MONTH_EXAMPLES } from "./surface/usage-examples";
import {
  TENANT_USAGE_DAY_EXT_SCHEMA,
  TENANT_USAGE_DAY_KEYS,
  TENANT_USAGE_DAY_PATH,
  TENANT_USAGE_MONTH_EXT_SCHEMA,
  TENANT_USAGE_MONTH_KEYS,
  TENANT_USAGE_MONTH_PATH,
} from "./surface/usage-model";

export const TENANT_APP_SURFACE: Contribution = {
  plugin: TENANT_APP_PLUGIN_NAME,
  nav: [
    {
      id: "tenant.home",
      title: "My home",
      icon: "tenants",
      group: "operate",
      order: 80,
      view: "tenant.home",
      audience: "tenant",
    },
    // The day view has no entry of its own: it is reached from the month,
    // and the shell counts /my/usage/day under this entry because /my/usage
    // is its longest prefix among the entries (currentApp in
    // @/lib/gui/host/shared/legacy-view and Gridtop's shell). If the shell
    // stops matching entries by prefix, the day view needs its own entry.
    {
      id: "tenant.usage",
      title: "My usage",
      icon: "readings",
      group: "operate",
      order: 81,
      view: "tenant.usage-month",
      audience: "tenant",
    },
  ],
  views: [
    {
      id: "tenant.home",
      kind: "record",
      scope: "tenant",
      path: "/my",
      params: {},
      // Reads the database only, through the tenant's own client; the usage
      // views, which read OpenEMS, are "vendor".
      cost: "db",
      declares: { keys: TENANT_HOME_KEYS, prefixes: [TENANT_METER_PREFIX] },
      examples: TENANT_HOME_EXAMPLES,
      load: loadTenantHome,
    },
    {
      id: "tenant.usage-month",
      kind: "collection",
      scope: "tenant",
      path: TENANT_USAGE_MONTH_PATH,
      params: {},
      query: ["month"],
      // Reads the microgrid's metering source (OpenEMS) through the provider
      // registry; never polled (no `live`), refreshed by the person, and
      // cached and limited per unit by the capability.
      cost: "vendor",
      declares: { keys: TENANT_USAGE_MONTH_KEYS },
      ext: { schema: TENANT_USAGE_MONTH_EXT_SCHEMA, zod: TenantUsageMonthExt },
      examples: TENANT_USAGE_MONTH_EXAMPLES,
      load: loadTenantUsageMonth,
    },
    {
      id: "tenant.usage-day",
      kind: "collection",
      scope: "tenant",
      path: TENANT_USAGE_DAY_PATH,
      params: {},
      query: ["date"],
      cost: "vendor",
      declares: { keys: TENANT_USAGE_DAY_KEYS },
      ext: { schema: TENANT_USAGE_DAY_EXT_SCHEMA, zod: TenantUsageDayExt },
      examples: TENANT_USAGE_DAY_EXAMPLES,
      load: loadTenantUsageDay,
    },
  ],
};
