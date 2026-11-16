"use client";

// What a signed-in page shows when it, or a layout below (gui)/layout.tsx,
// throws. It renders inside the shell, so the navigation stays usable;
// without it the error reached Next.js's built-in global error page, which
// replaces the whole document. An error in (gui)/layout.tsx itself still
// does, since a segment's error.tsx covers only what its layout wraps.
//
// ViewUnavailable tells the shell this page will publish no model: on a
// page a contributed view serves, the (gui) layout names the view for the
// first paint before the page has loaded it (resolveInitialView), and the
// window bar waits for the model until a ViewBoundary or a ViewUnavailable
// settles it. If this file goes, a throw under a view's page leaves the bar
// busy. A view loader that throws does not come here while dispatchView
// turns it into a refusal, which renderView shows as a banner; if that
// changes, it lands here and the bar still settles.
//
// `retry` asks the server for the page again and then re-renders it; `reset`
// alone would re-render the same failed server response. Next.js 16.4 passes
// both; `reset` is the fallback should a release pass only that.

import { ViewUnavailable } from "@/lib/gui/host/client/view-boundary";

export default function GuiError({
  error,
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
}) {
  return (
    <ViewUnavailable>
      <div className="flex flex-col items-start gap-2">
        <h1 className="text-2xl font-semibold text-foreground">This page could not be shown</h1>
        <p className="text-sm text-muted-foreground">Something went wrong while loading it.</p>
        {error.digest && <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>}
        <button
          type="button"
          onClick={() => (retry ?? reset)()}
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    </ViewUnavailable>
  );
}
