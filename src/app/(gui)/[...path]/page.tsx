import { notFound, redirect } from "next/navigation";
import { INSTALLED_GUIS } from "@/gui/installed";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { requireMiddlewarePath } from "@/lib/gui/host/server/middleware-path";
import { keepTenantOnlyToTenantPages } from "@/lib/gui/host/server/tenant-pages";
import { readGuiName } from "@/lib/config/gui";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { renderView, type PageSearch } from "@/lib/gui/host/server/render-view";

/**
 * A contributed view on its own path. Next.js prefers every other page's
 * static or dynamic segments over this catch-all, so it answers only paths
 * no page.tsx serves, and never "/". Kept short on purpose: CODEOWNERS
 * cannot name this path, so the logic lives in the code-owned
 * src/lib/gui/host/server/render-view.tsx.
 */
export default async function ContributedViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<PageSearch>;
}) {
  // A render the middleware did not see answers 404 before any read
  // (middleware-path.ts says why). The path comes from params below.
  await requireMiddlewarePath();

  // Next.js 16 hands catch-all segments over percent-encoded, one level
  // (next/dist/shared/lib/router/utils/get-dynamic-param.js): a request for
  // /a%20b arrives as "a%20b". If it starts decoding them, drop this decode;
  // the page test's %20, %2F and %25 cases then fail.
  let path: string[] = [];
  try {
    path = (await params).path.map(decodeURIComponent);
  } catch {
    notFound();
  }
  // An /api path with no route handler would otherwise render as a page.
  if (path.length === 0 || path[0] === "api") notFound();
  // Middleware has already applied the release allowlist to this path
  // (requireMiddlewarePath above shows it ran). The check is repeated here
  // so a request that sent x-mgm-path itself still answers 404 before any
  // read for a path outside the release.
  if (!isReleasedRoute(`/${path.map(encodeURIComponent).join("/")}`)) notFound();

  // A person whose rows are all tenant rows is sent home from a staff view's
  // page, as from every page under (gui), before the view loads.
  // dispatchView would answer such a view 404 for them anyway; this keeps a
  // client-side navigation's answer the same as a full load's.
  await keepTenantOnlyToTenantPages();

  // Its own session check: App Router renders the layout alongside the page.
  const access = await getRequestUserAccess();
  if (!access.user) redirect("/login");

  return renderView({ path, search: await searchParams, access, gui: INSTALLED_GUIS[readGuiName()] });
}
