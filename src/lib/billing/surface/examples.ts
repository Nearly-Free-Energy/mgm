import "server-only";

/**
 * Examples of the `billing.savings` view, so every GUI can be tested against
 * it: generated figures with both savings counted, both warnings and an
 * estimated solar, the setup note, and the state the day above already
 * explains. Built at import the way the loader builds them.
 */
import type { ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { LoadedModel } from "@/lib/gui/surface";
import type { SavingsColumn } from "../site-savings";
import { buildSavingsModel } from "./savings-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site" };
const LOCALE = "en-GB";
const fmt = createFmt({ locale: LOCALE });

/**
 * What the host shows on a model whose Values are synthetic: a copy of
 * SYNTHETIC_NOTICE in src/lib/gui/host/server/view.ts, which
 * savings-model.test.ts compares with it. Not imported: that module reaches
 * this one through the runtime root (snapshot.ts), so an import would be a
 * cycle.
 */
const SYNTHETIC_NOTICE = {
  tone: "warning",
  text: "Synthetic data: these figures are generated for demonstration, not measured.",
} as const;

const column = (solarSavings: number | null, arbitrageGain: number | null, lightsOnPct: number | null, days: number): SavingsColumn => ({
  solarSavings,
  arbitrageGain,
  total: solarSavings === null && arbitrageGain === null ? null : (solarSavings ?? 0) + (arbitrageGain ?? 0),
  lightsOnPct,
  days,
});

/** The models as the loader returns them, before the host fills its fields. */
export const SAVINGS_LOADED_EXAMPLES: readonly LoadedModel<"metrics">[] = [
  buildSavingsModel({
    state: "ready",
    summary: {
      columns: {
        day: column(4216.4, null, 98.25, 1),
        month: column(21_480.6, -310.2, 96.5, 5),
        sinceStart: column(1_204_310, 18_220.75, null, 366),
      },
      sinceStartDate: "2025-11-06",
      missingTariffDays: 3,
    },
    date: "2026-11-05",
    currency: "UGX",
    locale: LOCALE,
    fmt,
    solarFrom: "2025-10-01",
    arbitrageFrom: "2026-01-01",
    cappedFrom: "2025-11-06",
    solarEstimated: true,
    synthetic: true,
  }),
  buildSavingsModel({ state: "setup", microgridId: MICROGRID.id, fmt }),
  buildSavingsModel({ state: "unavailable" }),
];

/** Each loaded model with the fields the host fills, as a GUI receives it. */
export const SAVINGS_EXAMPLES: readonly ModelOf<"metrics">[] = SAVINGS_LOADED_EXAMPLES.map((loaded) => {
  const synthetic = (loaded.ext?.data as { synthetic?: boolean } | undefined)?.synthetic === true;
  return {
    ...loaded,
    type: "view",
    view: "billing.savings",
    kind: "metrics",
    org: ORG,
    // The host fills the entity from the path when a loader gives none.
    entity: { kind: "microgrid", id: MICROGRID.id, label: MICROGRID.name },
    trail: [{ label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` }],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    ...(synthetic ? { notice: { ...SYNTHETIC_NOTICE } } : {}),
  };
});
