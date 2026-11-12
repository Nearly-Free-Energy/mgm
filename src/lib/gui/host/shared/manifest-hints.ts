/**
 * The hints getManifest (../server/manifest.ts) takes after the GUI's name,
 * read from a request's headers and cookies. The (gui) layout and /go/<nav>
 * read them alike, so a page and its layout share one cached manifest. Each
 * hint only chooses among the organizations the person can see; none of
 * them authorizes anything.
 */
import { ORG_COOKIE } from "./org-cookie";

/** The request's path and query, which middleware forwards (src/middleware.ts). */
export const MGM_PATH_HEADER = "x-mgm-path";

export interface ManifestHints {
  path: string | null;
  /** The path's `?org=`. */
  requested: string | null;
  /** The organization the person last used. */
  preferred: string | null;
}

/** The `?org=` of a path with its query, or null. */
function requestedOrganization(path: string | null): string | null {
  const query = path?.split("#", 1)[0].split("?")[1];
  return query ? new URLSearchParams(query).get("org") : null;
}

export function manifestHints(
  headers: { get(name: string): string | null },
  cookies: { get(name: string): { value: string } | undefined },
): ManifestHints {
  const path = headers.get(MGM_PATH_HEADER);
  return { path, requested: requestedOrganization(path), preferred: cookies.get(ORG_COOKIE)?.value ?? null };
}
