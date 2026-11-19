import "server-only";

/**
 * Examples of the `tenant.home` view, so every GUI can be tested against
 * it: a unit with a primary and a secondary meter, and a unit with no meter
 * assigned today, built the way the loader builds them.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import type { TenantHome } from "../types";
import { buildTenantHomeModel } from "./home-model";

const LOCALE = "en-GB";

const HOME: TenantHome = {
  tenant: { id: "00000000-0000-4000-8000-0000000000b1", displayName: "Example tenant", unitLabel: "Unit 4" },
  microgrid: { name: "Example site", timezone: "Africa/Kampala", currency: "UGX" },
  date: "2026-11-06",
  meters: [
    {
      deviceId: "00000000-0000-4000-8000-0000000000b2",
      name: "House meter",
      deviceType: "consumption_meter",
      role: "primary_consumption_meter",
      effectiveFrom: "2026-03-01",
      effectiveTo: null,
    },
    {
      deviceId: "00000000-0000-4000-8000-0000000000b3",
      name: "Shop meter",
      deviceType: "consumption_meter",
      role: "secondary_meter",
      effectiveFrom: "2026-09-15",
      effectiveTo: null,
    },
  ],
};

const NO_METER: TenantHome = {
  ...HOME,
  tenant: { id: "00000000-0000-4000-8000-0000000000b4", displayName: "New tenant", unitLabel: null },
  meters: [],
};

/** The models as the loader returns them, before the host fills its fields. */
export const TENANT_HOME_LOADED_EXAMPLES: readonly LoadedModel<"record">[] = [HOME, NO_METER].map((home) =>
  buildTenantHomeModel(home, createFmt({ locale: LOCALE })),
);

/**
 * Each loaded model with the fields the host fills for a tenant view, as a
 * GUI receives it: no organization, trail or attached views
 * (dispatchTenantView in src/lib/gui/host/server/view.ts).
 */
export const TENANT_HOME_EXAMPLES: readonly ModelOf<"record">[] = TENANT_HOME_LOADED_EXAMPLES.map((loaded) => ({
  ...loaded,
  type: "view",
  view: "tenant.home",
  kind: "record",
  org: null,
  trail: [],
  actions: [],
  links: loaded.links ?? [],
  attached: [],
}));
