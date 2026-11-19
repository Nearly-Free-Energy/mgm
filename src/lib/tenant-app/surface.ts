import "server-only";

/**
 * What the tenant app contributes to GUIs (src/lib/gui/surface.ts), RFC
 * mgm#197 § 3–4: the tenant's home as the `tenant.home` view, a tenant view
 * about the caller's own unit, with its nav entry for the tenant audience.
 * Gridtop draws it with its kit; the month and day of use join it in PR 3.
 *
 * Its page, /my, is in the catalog but not released (RFC mgm#197: released
 * by PR 5), so neither the entry nor the page is offered yet: the manifest
 * lists released pages only, and middleware answers others with 404.
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
  ],
};
