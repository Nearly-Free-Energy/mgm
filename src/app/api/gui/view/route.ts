import type { NextRequest } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { hostFailure, hostOutcome, routeHostContext } from "@/lib/gui/host/server/http";
import { dispatchView } from "@/lib/gui/host/server/view";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/view?href=<page href>: one contributed view, for the signed-in
 * person. The session is checked with getUser() before any view is looked up.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const host = routeHostContext(await getCurrentUserAccess(supabase), request.headers);
  if (!host.ok) return hostFailure(host.status, host.code, host.message);
  const href = request.nextUrl.searchParams.get("href");
  if (!href) return hostFailure(400, "gui_bad_request", "href is required.");
  return hostOutcome(await dispatchView(host.ctx, href));
}
