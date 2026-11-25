import "server-only";

/**
 * Examples of the `billing.period-missing` watcher's signals, built by its
 * own model with a fixed clock, so they are what it returns: two microgrids
 * with metered tenants and no period for October. All data is synthetic.
 */
import { createFmt } from "@/lib/gui/fmt";
import type { SignalOut } from "@/lib/gui/surface";
import { buildPeriodMissingSignals } from "./period-missing-model";

export const PERIOD_MISSING_EXAMPLES: readonly SignalOut[] = buildPeriodMissingSignals(
  createFmt({ locale: "en-GB" }),
  [
    { id: "00000000-0000-4000-8000-0000000000b1", name: "Kiwumu", timezone: "Africa/Kampala" },
    { id: "00000000-0000-4000-8000-0000000000b2", name: "Buvuma", timezone: "Africa/Kampala" },
  ],
  new Date("2026-11-20T09:00:00Z"),
);
