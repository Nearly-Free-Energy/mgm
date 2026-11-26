"use client";

/**
 * Gridtop's renderer for the Operations day, as the GUI hands it to the host.
 * The renderer itself (./renderer.tsx) is a chunk of its own, loaded only on
 * a page that draws the view: Gridtop's index is imported by the interface
 * layout, so importing it directly would put it in every page's first-load
 * JavaScript (scripts/budgets/limits.json). The server render streams the
 * drawn view in the same response; the browser loads the chunk before
 * hydrating it, and shows nothing in its place meanwhile on a soft navigation.
 */
import { lazy, Suspense } from "react";
import type { ViewProps } from "@/lib/gui/contract";
import type { SyncNode } from "@/lib/gui/contract-react";
import { kit } from "@/lib/gui/kit";

const SiteDayView = lazy(() => import("./renderer").then((m) => ({ default: m.SiteDayView })));

export function SiteDayRenderer(props: ViewProps): SyncNode {
  return (
    <Suspense fallback={null}>
      <SiteDayView {...props} kit={kit} />
    </Suspense>
  );
}
