import { notReleasedResponse } from "@/lib/public-html/not-released";

/**
 * A missing file under /_next/static/ (the folder name's %5F is an
 * underscore: Next.js treats a folder starting with "_" as private). The
 * middleware matcher skips this folder so build output is served without it
 * (src/middleware.ts), and without this route such a request would reach
 * the (gui) catch-all page with no middleware, whose layout then answers a
 * bare 404 (src/lib/gui/host/server/middleware-path.ts). A file that exists is
 * served from disk before any route, so this answers only for one that does
 * not, as the middleware answers a path outside the release. If the matcher
 * stops skipping /_next/static/, this route can go.
 */
export function GET(request: Request) {
  return notReleasedResponse(request.headers.get("accept-language"));
}
