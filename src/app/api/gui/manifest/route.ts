import type { NextRequest } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { hostFailure, hostOutcome, routeHostContext } from "@/lib/gui/host/server/http";
import { readManifestQuery, serveManifest } from "@/lib/gui/host/server/manifest";
import { ORG_COOKIE } from "@/lib/gui/host/server/organization";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/manifest?path=<page>&org=<id>: the signed-in person's
 * manifest (places, navigation and the views it names), as the (gui) layout
 * renders it, for a client other than the page (RFC #259 § 3). Reads only.
 * The session is checked with getUser() before the query is read.
 *
 * The organization the person last used (the org cookie) is a hint, as the
 * layout passes it (manifestHints); like `org`, it only chooses among the
 * organizations the person can see. If the layout stops passing it, stop
 * here too.
 *
 * Not released until the CLI ships (RFC #259 § 7): GUI_HOST_API_ROUTES in
 * src/lib/mgm/released-routes.ts does not name it, so middleware answers
 * 404 for it before this runs.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const host = routeHostContext(await getCurrentUserAccess(supabase), request.headers);
  if (!host.ok) return hostFailure(host.status, host.code, host.message);
  const query = readManifestQuery(request.nextUrl.searchParams);
  if (!query.ok) return hostOutcome(query);
  const preferred = request.cookies.get(ORG_COOKIE)?.value ?? null;
  return hostOutcome(await serveManifest(host.ctx, { ...query.value, preferred }));
}
