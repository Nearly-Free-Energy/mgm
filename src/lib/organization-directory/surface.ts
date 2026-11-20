import "server-only";

/**
 * What the organization directory contributes to GUIs
 * (src/lib/gui/surface.ts): Today (`org.today`), the home page on "/", and
 * navigation to its other pages, which are served outside the GUI contract
 * (`legacy: true`), with the labels the current chrome uses. A page that
 * moves to a view keeps its nav id, as Today kept `org.today` from the
 * Dashboard it replaces.
 *
 * Today lists the organization's signals (./today-model.ts), which the host
 * collects for it (`takesSignals`), and other plugins attach tiles to it
 * (attach { to: { view: "org.today" }, hint: "tile" }). The catalog serves
 * "/" by this view (`servedBy: "view"`), so the host's catch-all renders it.
 */
import type { Contribution } from "@/lib/gui/surface";
import { ORGANIZATION_DIRECTORY_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { loadToday } from "./today";
import { TODAY_EXAMPLES } from "./today-examples";
import { TODAY_KEYS, TODAY_TITLE, TODAY_VIEW } from "./today-model";

export const ORGANIZATION_DIRECTORY_SURFACE: Contribution = {
  plugin: ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  nav: [
    { id: "org.today", title: TODAY_TITLE, icon: "today", group: "operate", order: 10, view: TODAY_VIEW },
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
  views: [
    {
      id: TODAY_VIEW,
      kind: "collection",
      path: "/",
      params: {},
      // No `agent`: an assistant reads signals through their own route
      // when it comes (#133), not through the home page.
      // Reads nothing itself; the host collects the signals with the
      // person's own session, running each watcher only while its plugin is
      // on. The organization directory is core, so Today itself is never off.
      cost: "db",
      takesSignals: true,
      declares: { keys: TODAY_KEYS },
      examples: TODAY_EXAMPLES,
      load: loadToday,
    },
  ],
};
