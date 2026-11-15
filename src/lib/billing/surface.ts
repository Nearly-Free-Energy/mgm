import "server-only";

/**
 * What billing contributes to GUIs (src/lib/gui/surface.ts): navigation to
 * its pages, which are served outside the GUI contract (`legacy: true`), with
 * the labels the current chrome uses, and the savings as the
 * `billing.savings` view, shown under the Operations day. A page that moves
 * to a view keeps its nav id.
 */
import type { Contribution } from "@/lib/gui/surface";
import { BILLING_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { SAVINGS_EXAMPLES } from "./surface/examples";
import { loadSavings } from "./surface/savings";
import { SavingsExt } from "./surface/savings-ext";
import { SAVINGS_EXT_SCHEMA, SAVINGS_KEYS } from "./surface/savings-model";

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
  views: [
    {
      id: "billing.savings",
      kind: "metrics",
      path: "/microgrids/[id]/operations/savings",
      params: { id: "microgrid" },
      entity: "id",
      // The day the Operations view shows, which the host passes on.
      query: ["date"],
      attach: { to: { view: "metering.site-day" }, order: 20, hint: "section" },
      // Reads up to a year of days from OpenEMS: refused while billing is
      // off, and never polled.
      cost: "vendor",
      declares: { keys: SAVINGS_KEYS },
      ext: { schema: SAVINGS_EXT_SCHEMA, zod: SavingsExt },
      examples: SAVINGS_EXAMPLES,
      load: loadSavings,
    },
  ],
};
