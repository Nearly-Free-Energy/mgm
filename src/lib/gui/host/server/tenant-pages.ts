import "server-only";

/**
 * Which pages a person whose rows are all tenant rows may open (RFC mgm#197
 * § 4): the pages a contributed tenant view serves, and nothing else. When
 * the (gui) layout renders for such a person on any other page, it sends
 * them home. The layout does not render on every request (a client-side
 * navigation within the group skips it), so this decides where they are
 * sent, not what they may read: staff pages' own checks, RLS and
 * dispatchView do that.
 *
 * The list is not kept here. A page is a tenant page when the catalog lists
 * it as served by a view (matchCatalogPage, `servedBy: "view"`, so no
 * page.tsx serves it and the catch-all page does) and the contributed view
 * whose path fits it, matched as dispatchView matches it (./view.ts), has
 * scope "tenant". A new tenant view is therefore a tenant page with no edit
 * here, and a staff page, catalog-listed or host-owned, never is. If
 * dispatchView stops choosing the view with matchView, choose it here the
 * same way.
 */
import { matchCatalogPage } from "@/lib/plugins/bundled";
import { parseHref } from "./hrefs";
import { surfaceSnapshot } from "./snapshot";
import { matchView } from "./view";

/** True iff `pathWithQuery` (a path, with or without its query) is a page a tenant view serves. */
export async function isTenantPage(pathWithQuery: string): Promise<boolean> {
  const parsed = parseHref(pathWithQuery);
  if (!parsed || matchCatalogPage(parsed.path)?.page.servedBy !== "view") return false;
  const snapshot = await surfaceSnapshot();
  return matchView(snapshot.views, parsed.path)?.view.def.scope === "tenant";
}
