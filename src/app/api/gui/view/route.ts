import type { NextRequest } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { hostFailure, hostOutcome, routeHostContext } from "@/lib/gui/host/server/http";
import { dispatchView } from "@/lib/gui/host/server/view";
import { ORG_COOKIE } from "@/lib/gui/host/shared/org-cookie";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/view?href=<page href>: one contributed view, for the signed-in
 * person. The session is checked with getUser() before any view is looked up.
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
  const supabase = await createClient();
  const host = routeHostContext(await getCurrentUserAccess(supabase), request.headers);
  if (!host.ok) return hostFailure(host.status, host.code, host.message);
  const href = request.nextUrl.searchParams.get("href");
  if (!href) return hostFailure(400, "gui_bad_request", "href is required.");
  const preferred = request.cookies.get(ORG_COOKIE)?.value ?? null;
  return hostOutcome(await dispatchView(host.ctx, href, { preferred }));
}
