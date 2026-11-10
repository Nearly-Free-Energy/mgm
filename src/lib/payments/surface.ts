import "server-only";

/**
 * What payments contributes to GUIs (src/lib/gui/surface.ts). Today:
 * navigation to its pages, which are served outside the GUI contract
 * (`legacy: true`), with the labels the current chrome uses. A page that
 * moves to a view keeps its nav id.
 */
import type { Contribution } from "@/lib/gui/surface";
import { PAYMENTS_PLUGIN_NAME } from "@/lib/plugins/bundled";

export const PAYMENTS_SURFACE: Contribution = {
  plugin: PAYMENTS_PLUGIN_NAME,
  nav: [
    {
      id: "payments.org-accounts",
      title: "Payment accounts",
      icon: "accounts",
      group: "configure",
      order: 40,
      href: "/organizations/[id]/payments",
      needs: ["organization"],
      legacy: true,
    },
  ],
};
