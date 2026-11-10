import "server-only";

/**
 * What community management contributes to GUIs (src/lib/gui/surface.ts).
 * Today: navigation to its pages, which are served outside the GUI contract
 * (`legacy: true`), with the labels the current chrome uses. A page that
 * moves to a view keeps its nav id.
 */
import type { Contribution } from "@/lib/gui/surface";
import { COMMUNITY_MANAGEMENT_PLUGIN_NAME } from "@/lib/plugins/bundled";

export const COMMUNITY_MANAGEMENT_SURFACE: Contribution = {
  plugin: COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  nav: [
    { id: "community.microgrids", title: "Microgrids", icon: "sites", group: "operate", order: 20, href: "/microgrids", needs: [], legacy: true },
    { id: "community.communities", title: "Communities", icon: "communities", group: "operate", order: 30, href: "/communities", needs: [], legacy: true },
    {
      id: "community.households",
      title: "Households",
      icon: "households",
      group: "operate",
      order: 50,
      href: "/microgrids/[id]/setup/households",
      needs: ["microgrid"],
      legacy: true,
    },
  ],
};
