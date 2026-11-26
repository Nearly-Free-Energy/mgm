import type { NextRequest } from "next/server";
import { hostFailure, hostOutcome, openHostRequest } from "@/lib/gui/host/server/http";
import { ORG_COOKIE } from "@/lib/gui/host/server/organization";
import { dispatchView } from "@/lib/gui/host/server/view";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/view?href=<page href>: one contributed view, for the signed-in
 * person. The session is checked with getUser() before any view is looked up.
 * One of the two routes an agent client may call (AGENT_ROUTES in
 * @/lib/runtime/agent-routes): it gets only an organization's view marked
 * agent: "read" (dispatchView).
 *
 * The organization the person last used (the org cookie) is passed as a
 * hint, as renderView (src/lib/gui/host/server/render-view.tsx) passes it
 * for the page itself, so a client reload of a view whose path names no
 * organization, such as Today on "/" without ?org=, opens in the
 * organization the shell shows rather than the person's first. Like ?org=,
 * it only chooses among the organizations the person can see
 * (pickOrganization). If renderView stops passing it, stop here too.
 */
export async function GET(request: NextRequest) {
  const host = await openHostRequest(request.headers, { agent: "view" });
  if (!host.ok) return host.response;
  const href = request.nextUrl.searchParams.get("href");
  if (!href) return hostFailure(400, "gui_bad_request", "href is required.");
  const preferred = request.cookies.get(ORG_COOKIE)?.value ?? null;
  return hostOutcome(await dispatchView(host.ctx, href, { preferred }));
}
