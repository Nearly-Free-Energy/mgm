import { notReleasedResponse } from "@/lib/public-html/not-released";

/**
 * A missing stylesheet under /gui-styles/. The middleware matcher skips
 * this folder so the compiled GUI stylesheets in public/gui-styles/ are
 * served without it (src/middleware.ts), and without this route such a
 * request would reach the (gui) catch-all page with no middleware, whose
 * layout then answers a bare 404 (src/lib/gui/host/server/middleware-path.ts).
 * A file that exists is served from disk before any route, so this answers only
 * for one that does not, as the middleware answers a path outside the
 * release. If the matcher stops skipping /gui-styles/, this route can go.
 */
export function GET(request: Request) {
  return notReleasedResponse(request.headers.get("accept-language"));
}
