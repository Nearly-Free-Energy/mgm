/**
 * current-periods-model.ts — each of an organization's microgrids with its
 * newest billing period, as a `collection` view model
 * (`billing.current-periods`). A tile on Today (org.today), and a page of
 * its own at /billing.
 *
 * Pure: no server-only import, no clock, no I/O. Each row is a microgrid
 * and leads to its newest period's review, or to its billing periods when
 * it has none. Rows carry no entity, so the host appends no other plugin's
 * action on a microgrid to the tile. No tenant's name or amount reaches the
 * model: a period's name, its status and how many bills it holds.
 */
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import { periodLabel } from "./period-label";

export const CURRENT_PERIODS_VIEW = "billing.current-periods";
export const CURRENT_PERIODS_TITLE = "Current billing periods";
/** Every cell key the view emits. */
export const CURRENT_PERIODS_KEYS = ["microgrid", "period", "status", "bills"] as const;
/** The most microgrids the view lists; the loader reads one more, to tell when there are more. */
export const MAX_CURRENT_PERIODS = 100;

export type CurrentPeriodInput = {
  microgridId: string;
  microgridName: string;
  /** The microgrid's newest period by start date, or null when it has none. */
  period: { id: string; start_date: string; end_date: string; status: "draft" | "closed"; bills: number } | null;
};

/** `microgrids` in the loader's order; past MAX_CURRENT_PERIODS, the rest are left out with a notice. */
export function buildCurrentPeriodsModel(fmt: Fmt, microgrids: readonly CurrentPeriodInput[]): LoadedModel<"collection"> {
  return {
    title: CURRENT_PERIODS_TITLE,
    actions: [],
    body: {
      columns: [
        { key: "microgrid", label: "Microgrid", type: "text", priority: 1 },
        { key: "period", label: "Period", type: "text", priority: 2 },
        { key: "status", label: "Status", type: "status", priority: 1 },
        { key: "bills", label: "Bills", type: "number", priority: 3 },
      ],
      rows: microgrids.slice(0, MAX_CURRENT_PERIODS).map(({ microgridId, microgridName, period }) => {
        const billing = `/microgrids/${microgridId}/billing` as const;
        return {
          id: microgridId,
          href: period ? `${billing}/${period.id}` : billing,
          cells: {
            microgrid: fmt.text(microgridName),
            period: period ? fmt.text(periodLabel(fmt, period.start_date, period.end_date)) : fmt.empty(),
            status: period ? fmt.status("billingPeriod", period.status) : fmt.text("No periods yet"),
            bills: period ? fmt.number(period.bills) : fmt.empty(),
          },
          actions: [],
        };
      }),
      empty: { title: "No microgrids yet", text: "A microgrid's billing periods show here once it is set up." },
    },
    ...(microgrids.length > MAX_CURRENT_PERIODS
      ? { notice: { tone: "info" as const, text: `The first ${MAX_CURRENT_PERIODS} microgrids are shown.` } }
      : {}),
  };
}
