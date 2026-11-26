/**
 * The views Gridtop draws with a bespoke renderer, each with the `ext`
 * versions it reads: the one table the entry (../index.ts) hands the host,
 * the content frame (AttachedSections in ../shell/shell.tsx) draws attached
 * sections with, and the window bar (../shell/window-bar.tsx) asks through
 * drawnBespoke. Each Component is a small wrapper that loads its renderer as
 * a chunk of its own, so this module costs the shell's first load only the
 * wrappers.
 */
import type { ViewModel } from "@/lib/gui/contract";
import type { GuiPlugin } from "@/lib/gui/contract-react";
import { PeriodReviewRenderer } from "./period-review";
import { SavingsRenderer } from "./savings";
import { SendQueueRenderer } from "./send-queue";
import { SiteDayRenderer } from "./site-day";
import { UsageDayRenderer, UsageMonthRenderer } from "./tenant-usage";

export const GRIDTOP_RENDERERS = {
  "billing.period-review": { reads: [1], Component: PeriodReviewRenderer },
  "billing.savings": { reads: [1], Component: SavingsRenderer },
  "billing.send-queue": { reads: [1], Component: SendQueueRenderer },
  "metering.site-day": { reads: [1, 2], Component: SiteDayRenderer },
  "tenant.usage-month": { reads: [1], Component: UsageMonthRenderer },
  "tenant.usage-day": { reads: [1], Component: UsageDayRenderer },
} satisfies NonNullable<GuiPlugin["renderers"]>;

/**
 * The renderers that place the page's actions and links themselves when
 * they draw the page's own view. The savings renderer is not one: on its own
 * page it leaves them, and the setup link, to the window bar
 * (./savings/savings-view.tsx); if it starts placing them, list it here.
 * The period-review renderer places the period's actions and links in its
 * own toolbar (./period-review/view.tsx), so the empty state can own
 * Generate, which the window bar would draw a second time. The send-queue
 * renderer is not one either: it leaves the period's links to the window bar
 * on its own page (./send-queue/view.tsx).
 */
const PLACE_PAGE_CONTROLS: readonly (keyof typeof GRIDTOP_RENDERERS)[] = [
  "billing.period-review",
  "metering.site-day",
  "tenant.usage-month",
  "tenant.usage-day",
];

/**
 * Whether Gridtop draws the page's `model` with a renderer that places its
 * own actions and links, so the window bar leaves them out. The version test
 * copies the host's choice (pickRenderer in
 * src/lib/gui/host/shared/pick-renderer.ts), which a GUI package may not
 * import; if that rule changes, change this too.
 */
export function drawnBespoke(model: Pick<ViewModel, "view" | "ext">): boolean {
  const view = PLACE_PAGE_CONTROLS.find((id) => id === model.view);
  if (!view || !model.ext) return false;
  const at = model.ext.schema.lastIndexOf("@");
  const version = at < 0 ? NaN : Number(model.ext.schema.slice(at + 1));
  return Number.isInteger(version) && version >= 0 && GRIDTOP_RENDERERS[view].reads.includes(version);
}
