import { notFound, redirect } from "next/navigation";
import { INSTALLED_GUIS } from "@/gui/installed";
import { getRequestUserAccess } from "@/lib/auth/request-access";
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
  // Next.js 16 hands catch-all segments over percent-encoded
  // (next/dist/shared/lib/router/utils/get-dynamic-param.js). If it starts
  // decoding them, drop this decode.
  let path: string[] = [];
  try {
    path = (await params).path.map(decodeURIComponent);
  } catch {
    notFound();
  }
  // An /api path with no route handler would otherwise render as a page.
  if (path.length === 0 || path[0] === "api") notFound();
  // Middleware applies the release allowlist, but its matcher skips
  // static-file paths (src/middleware.ts), and a missing file there lands
  // here; such a path is never released. If the matcher stops skipping
  // them, this check is redundant but stays correct.
  if (!isReleasedRoute(`/${path.map(encodeURIComponent).join("/")}`)) notFound();

  // Its own session check: App Router renders the layout alongside the page.
  const access = await getRequestUserAccess();
  if (!access.user) redirect("/login");

  return renderView({ path, search: await searchParams, access, gui: INSTALLED_GUIS[readGuiName()] });
}
