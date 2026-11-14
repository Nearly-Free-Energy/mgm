/**
 * The 404 routes of the folders the middleware matcher skips (src/middleware.ts):
 * Next.js's build output under /_next/static/ and the GUI stylesheets under
 * /gui-styles/. A file that exists there is served from disk before any
 * route is consulted; one that does not falls through to these routes,
 * which sit outside the (gui) route group, rather than to the (gui)
 * catch-all page, which would reach the (gui) layout without the
 * middleware (and get its bare 404). They answer as the middleware does for
 * a path outside the release, and read nothing.
 */
import { describe, expect, it } from "vitest";
import { renderNotReleasedPage } from "@/lib/public-html/not-released";
import { PUBLIC_PAGE_SECURITY_HEADERS } from "@/lib/public-html/page";
import * as nextStatic from "@/app/%5Fnext/static/[...file]/route";
import * as guiStyles from "@/app/gui-styles/[...file]/route";

describe.each([
  { folder: "/_next/static/", route: nextStatic, file: "/_next/static/chunks/missing.js" },
  { folder: "/gui-styles/", route: guiStyles, file: "/gui-styles/gridtop.0123456789ab.css" },
])("the 404 route for missing files under $folder", ({ route, file }) => {
  it("answers 404 with the not-released page and the security headers", async () => {
    const res = route.GET(new Request(`http://localhost${file}`, { headers: { "accept-language": "en-GB" } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(await res.text()).toBe(renderNotReleasedPage("en"));
  });

  it("handles GET only, so other methods get Next.js's 405", () => {
    expect(Object.keys(route).sort()).toEqual(["GET"]);
  });
});
