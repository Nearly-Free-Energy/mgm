import "server-only";

/**
 * What metering contributes to GUIs (src/lib/gui/surface.ts). Today:
 * navigation to its pages, which are served outside the GUI contract
 * (`legacy: true`), with the labels the current chrome uses. A page that
 * moves to a view keeps its nav id. `metering.live` is reserved for a later
 * live view of a microgrid; the Operations day is `metering.operations`.
 */
import type { Contribution } from "@/lib/gui/surface";
import { METERING_PLUGIN_NAME } from "@/lib/plugins/bundled";

export const METERING_SURFACE: Contribution = {
  plugin: METERING_PLUGIN_NAME,
  nav: [
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
};
