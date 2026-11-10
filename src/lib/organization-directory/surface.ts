import "server-only";

/**
 * What the organization directory contributes to GUIs
 * (src/lib/gui/surface.ts). Today: navigation to its pages, which are served
 * outside the GUI contract (`legacy: true`), with the labels the current
 * chrome uses. A page that moves to a view keeps its nav id.
 */
import type { Contribution } from "@/lib/gui/surface";
import { ORGANIZATION_DIRECTORY_PLUGIN_NAME } from "@/lib/plugins/bundled";

export const ORGANIZATION_DIRECTORY_SURFACE: Contribution = {
  plugin: ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  nav: [
    { id: "org.today", title: "Dashboard", icon: "today", group: "operate", order: 10, href: "/", needs: [], legacy: true },
    { id: "org.plugins", title: "Plugins", icon: "plugins", group: "system", order: 10, href: "/settings/plugins", needs: [], legacy: true },
    { id: "org.users", title: "Users", icon: "users", group: "system", order: 20, href: "/settings/users", needs: [], legacy: true },
    { id: "org.profile", title: "Profile", icon: "profile", group: "system", order: 30, href: "/settings/profile", needs: [], legacy: true },
    {
      id: "org.organizations",
      title: "Organizations",
      icon: "organizations",
      group: "system",
      order: 40,
      audience: "super-admin",
      href: "/organizations",
      needs: [],
      legacy: true,
    },
  ],
};
