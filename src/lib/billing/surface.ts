import "server-only";

/**
 * What billing contributes to GUIs (src/lib/gui/surface.ts). Today:
 * navigation to its pages, which are served outside the GUI contract
 * (`legacy: true`), with the labels the current chrome uses. A page that
 * moves to a view keeps its nav id.
 */
import type { Contribution } from "@/lib/gui/surface";
import { BILLING_PLUGIN_NAME } from "@/lib/plugins/bundled";

export const BILLING_SURFACE: Contribution = {
  plugin: BILLING_PLUGIN_NAME,
  nav: [
    {
      id: "billing.periods",
      title: "Billing",
      icon: "billing",
      group: "money",
      order: 10,
      href: "/microgrids/[id]/billing",
      needs: ["microgrid"],
      legacy: true,
    },
    {
      id: "billing.tariff",
      title: "Rate Schedule",
      icon: "tariff",
      group: "configure",
      order: 10,
      href: "/microgrids/[id]/setup/rates",
      needs: ["microgrid"],
      legacy: true,
    },
    {
      id: "billing.invoice-branding",
      title: "Invoice branding",
      icon: "branding",
      group: "configure",
      order: 30,
      href: "/communities/[id]/invoice",
      needs: ["community"],
      legacy: true,
    },
  ],
};
