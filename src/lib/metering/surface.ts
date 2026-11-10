import "server-only";

/**
 * What metering contributes to GUIs (src/lib/gui/surface.ts): navigation to
 * its pages, which are served outside the GUI contract (`legacy: true`),
 * with the labels the current chrome uses, and the Operations day as the
 * `metering.site-day` view. A page that moves to a view keeps its nav id.
 * `metering.live` is reserved for a later live view of a microgrid; the
 * Operations page's nav id is `metering.operations`.
 */
import type { Contribution } from "@/lib/gui/surface";
import { METERING_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { SITE_DAY_EXAMPLES } from "./surface/examples";
import { loadSiteDay } from "./surface/site-day";
import { SiteDayExt } from "./surface/site-day-ext";
import { SITE_DAY_EXT_SCHEMA, SITE_DAY_KEYS } from "./surface/site-day-model";

export const METERING_SURFACE: Contribution = {
  plugin: METERING_PLUGIN_NAME,
  nav: [
    // Stays a legacy entry, and the catalog page keeps its page.tsx, until the
    // Operations page is switched to the view.
    {
      id: "metering.operations",
      title: "Operations",
      icon: "live",
      group: "operate",
      order: 40,
      href: "/microgrids/[id]/operations",
      needs: ["microgrid"],
      legacy: true,
    },
    {
      id: "metering.devices",
      title: "Edges & Devices",
      icon: "devices",
      group: "operate",
      order: 60,
      href: "/microgrids/[id]/setup/edges",
      needs: ["microgrid"],
      legacy: true,
    },
    {
      id: "metering.data-source",
      title: "OpenEMS Backend",
      icon: "data-source",
      group: "configure",
      order: 20,
      href: "/microgrids/[id]/setup/openems-backend",
      needs: ["microgrid"],
      legacy: true,
    },
  ],
  views: [
    {
      id: "metering.site-day",
      kind: "metrics",
      path: "/microgrids/[id]/operations",
      params: { id: "microgrid" },
      entity: "id",
      query: ["date"],
      attach: { to: "microgrid", order: 10, hint: "tab" },
      // Reads OpenEMS: refused while metering is off, and never polled. A
      // finished day does not change; today's partial day is refreshed by
      // the person, as on the page.
      cost: "vendor",
      declares: { keys: SITE_DAY_KEYS },
      ext: { schema: SITE_DAY_EXT_SCHEMA, zod: SiteDayExt },
      examples: SITE_DAY_EXAMPLES,
      load: loadSiteDay,
    },
  ],
};
