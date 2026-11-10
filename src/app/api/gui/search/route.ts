import type { NextRequest } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { hostFailure, hostOutcome, routeHostContext } from "@/lib/gui/host/server/http";
import { runSearch } from "@/lib/gui/host/server/search";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/search?q=<text>&prefix=@|#&org=<id>: hits from contributed
 * searches in the signed-in person's organization. The session is checked
 * with getUser() before the query is read or any search runs.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const host = routeHostContext(await getCurrentUserAccess(supabase), request.headers);
  if (!host.ok) return hostFailure(host.status, host.code, host.message);
  const params = request.nextUrl.searchParams;
  return hostOutcome(await runSearch(host.ctx, { q: params.get("q"), prefix: params.get("prefix"), org: params.get("org") }));
}
