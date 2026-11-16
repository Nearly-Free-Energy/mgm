// What a signed-in page shows when it, or a layout below (gui)/layout.tsx,
// calls notFound(): another organization's microgrid, an id that names
// nothing, a path no view serves.
//
// It renders inside the shell. Without this file Next.js puts its built-in
// not-found page at the same place (the first route group under the root
// layout gets one when src/app has no not-found.tsx: next-app-loader), so
// the shell stayed then too. What this file adds is ViewUnavailable: on a
// page a contributed view serves, the (gui) layout names the view for the
// first paint before the page has loaded it (resolveInitialView), and the
// window bar waits for its model. ViewUnavailable tells the shell this page
// will publish none, so the bar stops waiting. If the file goes, the bar
// stays busy over the not-found page; if src/app gains its own
// not-found.tsx, Next.js stops inserting one here and this file still holds.
//
// notFound() below (gui)/loading.tsx answers HTTP 200 on a full page load
// (loading.tsx says why); this file does not change that.

import { ViewUnavailable } from "@/lib/gui/host/client/view-boundary";

export default function GuiNotFound() {
  return (
    <ViewUnavailable>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This page does not exist, or your account cannot see it.
        </p>
      </div>
    </ViewUnavailable>
  );
}
