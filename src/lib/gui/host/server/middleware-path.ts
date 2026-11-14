import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";

/** The request header src/middleware.ts forwards a page request's path and query in. */
export const MGM_PATH_HEADER = "x-mgm-path";

/**
 * The request's path and query as src/middleware.ts forwarded them, or a
 * 404 when the middleware did not run for this request. The (gui) layout
 * and the catch-all page call this before they read anything.
 *
 * The middleware sets this header on every page request it passes on and
 * replaces any value the client sent, and a browser never sends it, so a
 * request without it reached the page without the middleware: no content
 * security policy, no release allowlist, no session check. That happens
 * when the middleware's matcher skips a path no file answers, and which
 * paths it skips can depend on the host: Vercel's routing appears to match
 * the matcher without regard to case, so a missing /FAVICON.ICO would be
 * skipped there. Answering 404 here keeps the outcome the same on every
 * host.
 *
 * A client that sends the header itself on such a request gets past this
 * check, but only for its own request, with its own session: it reaches
 * what a normal request reaches, and the page's own checks still apply. A
 * page cannot make another person's browser send the header: a
 * cross-origin request with a custom header needs a CORS preflight, which
 * this app does not answer; if it starts to, revisit. If the middleware
 * stops setting the header on some page path, that page answers 404 here;
 * if that becomes intended, revisit.
 */
export async function requireMiddlewarePath(): Promise<string> {
  const path = (await headers()).get(MGM_PATH_HEADER);
  // The middleware's value always starts with "/", so an empty one is a
  // client's too.
  if (!path) notFound();
  return path;
}
