import "server-only";

/**
 * Which pages a person whose rows are all tenant rows may open (RFC mgm#197
 * § 4): the pages a contributed tenant view serves, and nothing else. Such a
 * person is sent home from any other page by keepTenantOnlyToTenantPages,
 * which every page under src/app/(gui) calls before it reads anything, and
 * by the (gui) layout. The page's call is the one that holds: the layout
 * does not render on a client-side navigation within the group, and a page
 * always does. It sends them away; it grants nothing, and what they may read
 * is still decided by RLS and dispatchView.
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
import { redirect } from "next/navigation";
import { rolesAreTenantOnly } from "@/lib/auth/access";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { matchCatalogPage } from "@/lib/plugins/bundled";
import type { UserRole } from "@/lib/types/domain";
import { TENANT_START_PAGE } from "../shared/tenant-units";
import { parseHref } from "./hrefs";
import { requireMiddlewarePath } from "./middleware-path";
import { surfaceSnapshot } from "./snapshot";
import { matchView } from "./view";

/** True iff `pathWithQuery` (a path, with or without its query) is a page a tenant view serves. */
export async function isTenantPage(pathWithQuery: string): Promise<boolean> {
  const parsed = parseHref(pathWithQuery);
  if (!parsed || matchCatalogPage(parsed.path)?.page.servedBy !== "view") return false;
  const snapshot = await surfaceSnapshot();
  return matchView(snapshot.views, parsed.path)?.view.def.scope === "tenant";
}

/**
 * Where a person holding `roles` is sent from `pathWithQuery`, or null when
 * they may open it: anyone with a staff row may (staff pages check access
 * themselves), and a person whose rows are all tenant rows may open only a
 * tenant page. Otherwise they go to their home while it is a released route
 * a tenant view serves, and to /no-access until then: an unreleased home is
 * answered by the static "not in this release" page, which has no sign-out
 * and links back to "/", which would send them round again. /no-access has
 * Log out and is outside the (gui) group, so it cannot send them round
 * either. This reads src/lib/mgm/released-routes.ts, so it follows the
 * release of TENANT_START_PAGE with no edit here.
 */
export async function tenantOnlyRedirect(
  pathWithQuery: string,
  roles: readonly { role: UserRole }[],
): Promise<string | null> {
  if (!rolesAreTenantOnly(roles) || (await isTenantPage(pathWithQuery))) return null;
  const home = isReleasedRoute(TENANT_START_PAGE) && (await isTenantPage(TENANT_START_PAGE));
  return home ? TENANT_START_PAGE : "/no-access";
}

/**
 * The first thing every page under src/app/(gui) does: a person whose rows
 * are all tenant rows is redirected from any page that is not a tenant page
 * (tenantOnlyRedirect), before the page reads anything. A page renders on
 * every request for it, a client-side navigation included, which the (gui)
 * layout does not (CLAUDE.md, "Session checks before privilege").
 *
 * A render the middleware did not see answers 404 first, before the read of
 * the user and their rows (middleware-path.ts). That read is this render's
 * shared one (getRequestUserAccess), so a page that reads it too, and the
 * layout on a full load, pay for it once. Nothing happens for a person with
 * no session or no rows: the layout and the page's own checks answer them.
 * `src/app/(gui)/__tests__/tenant-only-pages.test.tsx` calls every page as
 * such a person and fails when one reads before this.
 */
export async function keepTenantOnlyToTenantPages(): Promise<void> {
  const path = await requireMiddlewarePath();
  const { roles } = await getRequestUserAccess();
  const to = await tenantOnlyRedirect(path, roles);
  if (to) redirect(to);
}
