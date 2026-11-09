import "server-only";

/**
 * The href checks a view's output must pass before it leaves the server.
 * They start from the string checks in ../shared/href.ts, which a browser
 * runs as well, and add what only the server knows: the released routes
 * (src/lib/mgm/released-routes.ts) and the plugin catalog.
 */
import { getRouteOwner } from "@/lib/plugins/bundled";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { Href, OutHref } from "../../contract";
import { isOutHref, isSameOriginPath } from "../shared/href";

export { isOutHref };

/** A same-origin href split into its path and search parameters, or null. */
export function parseHref(raw: string): { path: string; search: URLSearchParams } | null {
  if (!isSameOriginPath(raw)) return null;
  const url = new URL(raw, "https://host.invalid");
  return { path: url.pathname, search: url.searchParams };
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/** A page a person can open: same origin, not under /api, and released. */
export function isPageHref(href: string): href is Href {
  const parsed = parseHref(href);
  return parsed !== null && !isApiPath(parsed.path) && isReleasedRoute(parsed.path);
}

/**
 * What a LinkRef may point at: a page, a released /api path that a catalog
 * plugin owns (a download such as a bill PDF), or an OutHref.
 */
export function isLinkHref(href: string): href is Href | OutHref {
  if (isOutHref(href)) return true;
  const parsed = parseHref(href);
  if (!parsed || !isReleasedRoute(parsed.path)) return false;
  return !isApiPath(parsed.path) || getRouteOwner(parsed.path) !== undefined;
}
