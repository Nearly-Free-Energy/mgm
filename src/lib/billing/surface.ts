import "server-only";

/**
 * What billing contributes to GUIs (src/lib/gui/surface.ts): navigation to
 * its pages, which are served outside the GUI contract (`legacy: true`), with
 * the labels the current chrome uses; a microgrid's billing periods as the
 * `billing.periods` view, with creating a period and deleting a draft; and
 * the savings as the `billing.savings` view, shown under the Operations day,
 * with the writes that change what it counts. A page that moves to a view
 * keeps its nav id.
 *
 * `billing.periods` has the Billing page's own path, which the legacy page
 * still serves: the catalog gives that page no servedBy, so the view is
 * reached through GET /api/gui/view until #201's "Serve the billing pages
 * through the GUI host" moves the page and its nav entry to the view.
 */
import type { Contribution } from "@/lib/gui/surface";
import { BILLING_PLUGIN_NAME } from "@/lib/plugins/bundled";
import {
  ADD_GRID_TARIFF_BODY_VERSION,
  AddGridTariffBody,
  CREATE_PERIOD_BODY_VERSION,
  CreatePeriodBody,
  DELETE_PERIOD_BODY_VERSION,
  DeletePeriodBody,
  SAVE_SAVINGS_SETTINGS_BODY_VERSION,
  SaveSavingsSettingsBody,
} from "./schemas";
import { SAVINGS_EXAMPLES } from "./surface/examples";
import { deletePeriodAvailable, loadPeriods, prepareDeletePeriod } from "./surface/periods";
import { PERIODS_EXAMPLES } from "./surface/periods-examples";
import { CREATE_PERIOD_ACTION, DELETE_PERIOD_ACTION, PERIODS_KEYS } from "./surface/periods-model";
import { loadSavings } from "./surface/savings";
import { SavingsExt } from "./surface/savings-ext";
import { GRID_TARIFF_ADD_ACTION, SAVINGS_EXT_SCHEMA, SAVINGS_KEYS, SAVINGS_SETTINGS_ACTION } from "./surface/savings-model";

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
      id: "billing.periods",
      kind: "collection",
      path: "/microgrids/[id]/billing",
      params: { id: "microgrid" },
      entity: "id",
      // Read through the person's own client; still loads while billing is
      // off, with the gate's notice and create disabled.
      cost: "db",
      declares: { keys: PERIODS_KEYS },
      examples: PERIODS_EXAMPLES,
      load: loadPeriods,
    },
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
  // Both human-only: no assistant proposes them (decision 6 on #115).
  // Deleting a tariff version is not contributed (decision 6): it stays on
  // the Rates page. A DELETE would need typed or ceremony confirmation and a
  // prepare step.
  // Both `targeted: false`: offered only by the savings view, whose loader
  // prefills them with the stored settings and the newest tariff's bands
  // (savingsActions in ./surface/savings-model.ts). Appended to another
  // plugin's view of the microgrid they would open empty, and the settings
  // PUT replaces the whole row, so saving would clear both stored dates. If
  // the host's prepare comes to supply starting values, or the route stops
  // replacing the row, revisit.
  actions: [
    // Human-only, as no assistant proposes a period yet (#201).
    // `targeted: false`: offered only by billing.periods. Appended to another
    // plugin's view of the microgrid (metering.site-day) it would open an
    // empty date form there. Revisit when the billing pages are served
    // through the GUI host.
    {
      ...CREATE_PERIOD_ACTION,
      target: "microgrid",
      input: CreatePeriodBody,
      inputVersion: CREATE_PERIOD_BODY_VERSION,
      method: "POST",
      path: "/api/billing-periods",
      bind: { body: { microgrid_id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    },
    // A DELETE: typed confirmation, the period's name, from prepare.
    {
      ...DELETE_PERIOD_ACTION,
      target: "billingPeriod",
      input: DeletePeriodBody,
      inputVersion: DELETE_PERIOD_BODY_VERSION,
      method: "DELETE",
      path: "/api/billing-periods/[periodId]",
      bind: { path: { periodId: "billingPeriod" } },
      risk: "destructive",
      confirm: "typed",
      humanOnly: true,
      prepare: prepareDeletePeriod,
      available: deletePeriodAvailable,
    },
    {
      ...SAVINGS_SETTINGS_ACTION,
      target: "microgrid",
      input: SaveSavingsSettingsBody,
      inputVersion: SAVE_SAVINGS_SETTINGS_BODY_VERSION,
      method: "PUT",
      path: "/api/microgrids/[id]/savings-settings",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "none",
      humanOnly: true,
      targeted: false,
    },
    {
      ...GRID_TARIFF_ADD_ACTION,
      target: "microgrid",
      input: AddGridTariffBody,
      inputVersion: ADD_GRID_TARIFF_BODY_VERSION,
      method: "POST",
      path: "/api/microgrids/[id]/grid-tariffs",
      bind: { path: { id: "microgrid" } },
      risk: "write",
      confirm: "confirm",
      humanOnly: true,
      targeted: false,
    },
  ],
};
