import "server-only";

/**
 * Examples of the `billing.period-due` watcher's signals, built by its own
 * model with a fixed clock, so they are what it returns: a period with
 * bills that ended days ago and is not closed (a warning), an older one with
 * bills a week or more past its end (critical), and an older one still with
 * no bills. All data is synthetic.
 */
import { createFmt } from "@/lib/gui/fmt";
import type { SignalOut } from "@/lib/gui/surface";
import { buildPeriodDueSignals } from "./period-due-model";

const MICROGRID = "00000000-0000-4000-8000-0000000000b1";

export const PERIOD_DUE_EXAMPLES: readonly SignalOut[] = buildPeriodDueSignals(
  createFmt({ locale: "en-GB" }),
  [
    {
      id: "00000000-0000-4000-8000-0000000000c1",
      microgridId: MICROGRID,
      microgridName: "Kiwumu",
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      timezone: "Africa/Kampala",
      bills: 42,
    },
    {
      id: "00000000-0000-4000-8000-0000000000c3",
      microgridId: MICROGRID,
      microgridName: "Kiwumu",
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      timezone: "Africa/Kampala",
      bills: 40,
    },
    {
      id: "00000000-0000-4000-8000-0000000000c2",
      microgridId: MICROGRID,
      microgridName: "Kiwumu",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      timezone: "Africa/Kampala",
      bills: 0,
    },
  ],
  new Date("2026-11-20T09:00:00Z"),
);
