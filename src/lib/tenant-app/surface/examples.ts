import "server-only";

/**
 * Examples of the `tenant.home` view, so every GUI can be tested against
 * it: a unit with a primary and a secondary meter and its month's use so
 * far (with a day missing), and a unit with no meter assigned today, built
 * the way the loader builds them. The month is the usage examples' November
 * (./usage-examples.ts), so "today" is theirs.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import type { TenantHome } from "../types";
import { buildTenantHomeModel } from "./home-model";
import { EXAMPLE_MONTHS_SO_FAR, EXAMPLE_SYNTHETIC_NOTICE } from "./usage-examples";
import { monthSoFar } from "./usage-model";

const LOCALE = "en-GB";

const HOME: TenantHome = {
  tenant: { id: "00000000-0000-4000-8000-0000000000b1", displayName: "Example tenant", unitLabel: "Unit 4" },
  microgrid: { name: "Example site", timezone: "Africa/Kampala", currency: "UGX" },
  date: "2026-11-18",
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
const fmt = createFmt({ locale: LOCALE });

export const TENANT_HOME_LOADED_EXAMPLES: readonly LoadedModel<"record">[] = [
  buildTenantHomeModel(HOME, fmt, monthSoFar(EXAMPLE_MONTHS_SO_FAR.november, { fmt, locale: LOCALE })),
  buildTenantHomeModel(NO_METER, fmt, monthSoFar(EXAMPLE_MONTHS_SO_FAR.noMeter, { fmt, locale: LOCALE })),
];

/** Whether any field's Value is marked synthetic, as the host decides its notice (hasSynthetic in @/lib/gui/host/server/view). */
const synthetic = (loaded: LoadedModel<"record">) =>
  loaded.body.sections.some((section) => section.fields.some((field) => field.value.synthetic === true));

/**
 * Each loaded model with the fields the host fills for a tenant view, as a
 * GUI receives it: no organization, trail or attached views, and the
 * synthetic notice when a figure is generated (dispatchTenantView in
 * src/lib/gui/host/server/view.ts).
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
  ...(synthetic(loaded) ? { notice: { ...EXAMPLE_SYNTHETIC_NOTICE } } : {}),
}));
