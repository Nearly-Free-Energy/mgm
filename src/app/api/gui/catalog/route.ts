import type { NextRequest } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { buildActionCatalog, readCatalogQuery } from "@/lib/gui/host/server/catalog";
import { hostFailure, hostOutcome, routeHostContext } from "@/lib/gui/host/server/http";
import { ORG_COOKIE } from "@/lib/gui/host/server/organization";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/catalog?org=<id> or ?entity=<kind>:<id> (repeatable): the
 * contributed actions the signed-in person may see, with each one's input
 * schema and whether it is available, and why not (RFC #259 § 3). Reads
 * only: it asks each action's available() but never prepares or sends one.
 * The session is checked with getUser() before the query is read.
 *
 * The organization the person last used (the org cookie) is a hint when
 * neither `org` nor an entity names one, as for a view.
 *
 * Not released until the CLI ships (RFC #259 § 7): GUI_HOST_API_ROUTES in
 * src/lib/mgm/released-routes.ts does not name it, so middleware answers
 * 404 for it before this runs.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const host = routeHostContext(await getCurrentUserAccess(supabase), request.headers);
  if (!host.ok) return hostFailure(host.status, host.code, host.message);
  const preferred = request.cookies.get(ORG_COOKIE)?.value ?? null;
  const query = readCatalogQuery(request.nextUrl.searchParams, preferred);
  if (!query.ok) return hostOutcome(query);
  return hostOutcome(await buildActionCatalog(host.ctx, query.value));
}
