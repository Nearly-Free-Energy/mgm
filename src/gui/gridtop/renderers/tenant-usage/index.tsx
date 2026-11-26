"use client";

/**
 * Gridtop's renderers for a tenant's use (RFC mgm#197 § 4), as the GUI hands
 * them to the host. Both views are one chunk of their own (./renderer.tsx),
 * loaded only on a page that draws one of them: they are visited together
 * and share their parts. Gridtop's index is imported by the interface
 * layout, so importing the renderer directly would put it in every page's
 * first-load JavaScript (scripts/budgets/limits.json), as
 * ../site-day/index.tsx says.
 */
import { lazy, Suspense } from "react";
import type { ViewProps } from "@/lib/gui/contract";
import type { SyncNode } from "@/lib/gui/contract-react";
import { kit } from "@/lib/gui/kit";

const MonthView = lazy(() => import("./renderer").then((m) => ({ default: m.UsageMonthView })));
const DayView = lazy(() => import("./renderer").then((m) => ({ default: m.UsageDayView })));

export function UsageMonthRenderer(props: ViewProps): SyncNode {
  return (
    <Suspense fallback={null}>
      <MonthView {...props} kit={kit} />
    </Suspense>
  );
}

export function UsageDayRenderer(props: ViewProps): SyncNode {
  return (
    <Suspense fallback={null}>
      <DayView {...props} kit={kit} />
    </Suspense>
  );
}
