import "server-only";

/**
 * Serves a contributed view on its own page: the (gui) catch-all page
 * (src/app/(gui)/[...path]/page.tsx) calls renderView, and the (gui) layout
 * calls resolveInitialView for the shell's first paint. Both load the view
 * through dispatchView (./view.ts), the code GET /api/gui/view runs, so a
 * page refuses what that route refuses; if that route adds a refusal outside
 * hostContext and dispatchView, add it here too. React cache() shares one load
 * between the layout and the page within one render; outside a render it
 * memoizes nothing.
 *
 * The path only names the view to load. What the view may show is settled
 * by dispatchView for the caller's own access, so a path from x-mgm-path
 * authorizes nothing.
 */
import { cache, type ReactNode } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { CurrentUserAccess } from "@/lib/auth/access";
import { Banner } from "@/components/ui/banner";
import { matchCatalogPage } from "@/lib/plugins/bundled";
import { createClient } from "@/lib/supabase/server";
import type { GuiPlugin, InitialView, Manifest, ViewModel } from "../../contract";
import { createFmt } from "../../fmt";
import { RawView } from "../../kit/raw-view";
import { ViewBoundary } from "../client/view-boundary";
import { contributedView } from "../shared/legacy-view";
import { pickRenderer } from "../shared/pick-renderer";
import { hostContext } from "./access";
import { dispatchView, type HostOutcome } from "./view";

export type PageSearch = Record<string, string | string[] | undefined>;

/**
 * The href of a page path and its query, spelled one way: each segment
 * encoded, the query sorted by name. The layout (from x-mgm-path) and the
 * page (from its params) then name the same load.
 */
export function pageHref(segments: readonly string[], search: URLSearchParams): string {
  const sorted = new URLSearchParams(search);
  sorted.sort();
  const query = sorted.toString();
  const path = `/${segments.map(encodeURIComponent).join("/")}`;
  return query ? `${path}?${query}` : path;
}

/** pageHref of a path with its query, or null when a segment does not decode. */
function hrefOfPath(pathWithQuery: string): string | null {
  const bare = pathWithQuery.split("#", 1)[0];
  const at = bare.indexOf("?");
  const path = at < 0 ? bare : bare.slice(0, at);
  const query = at < 0 ? "" : bare.slice(at + 1);
  try {
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    return pageHref(segments, new URLSearchParams(query));
  } catch {
    return null;
  }
}

/**
 * One view load per access read and href in a render. `access` must be what
 * getRequestUserAccess (@/lib/auth/request-access) returned in this render:
 * it asks Supabase Auth with getUser(), which hostContext relies on. If it
 * stops calling getUser(), revisit.
 */
const loadPageView = cache(async (access: CurrentUserAccess, href: string): Promise<HostOutcome<ViewModel>> => {
  const made = hostContext(access, await headers(), {
    newClient: createClient,
    makeFmt: (locale) => createFmt({ locale }),
  });
  return made.ok ? dispatchView(made.ctx, href) : made;
});

/**
 * The shell's view for the first paint of a page a contributed view serves
 * (a catalog page with `servedBy: "view"`), or null for any other path or a
 * view that does not load; the caller then uses resolveLegacyView.
 */
export async function resolveInitialView(
  access: CurrentUserAccess,
  pathWithQuery: string | null,
  manifest: Manifest,
): Promise<InitialView | null> {
  const href = pathWithQuery === null ? null : hrefOfPath(pathWithQuery);
  if (href === null || matchCatalogPage(href)?.page.servedBy !== "view") return null;
  const out = await loadPageView(access, href);
  return out.ok ? contributedView(href, out.value, manifest) : null;
}

/**
 * The contributed view at `path` (decoded segments), drawn by `gui` inside a
 * ViewBoundary, so the shell shows its title, trail and actions. No view, or
 * one the caller cannot see, is not found; a refusal with its own copy (a
 * disabled plugin, a loader's refusal) is shown as a banner.
 */
export async function renderView(input: {
  path: readonly string[];
  search: PageSearch;
  access: CurrentUserAccess;
  gui: Pick<GuiPlugin, "contract" | "View" | "renderers">;
}): Promise<ReactNode> {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(input.search)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(name, v);
  }
  const out = await loadPageView(input.access, pageHref(input.path, search));
  if (!out.ok) {
    if (out.status === 401) redirect("/login");
    if (out.code === "gui_no_access") redirect("/no-access");
    if (out.status === 400 || out.status === 404) notFound();
    return (
      <div className="flex flex-col gap-4">
        <h1 className="sr-only">This view could not be shown</h1>
        <Banner tone={out.status === 409 ? "warn" : "destructive"} title={out.message}>
          {null}
        </Banner>
      </div>
    );
  }
  const model = out.value;
  const choice = pickRenderer(input.gui, model);
  const View = choice.source === "raw" ? RawView : choice.Component;
  return (
    <ViewBoundary model={model}>
      <View model={model} />
    </ViewBoundary>
  );
}
