import type { NextRequest } from "next/server";
import { hostOutcome, openHostRequest } from "@/lib/gui/host/server/http";
import { runSearch } from "@/lib/gui/host/server/search";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/search?q=<text>&prefix=@|#&org=<id>: hits from contributed
 * searches in the signed-in person's organization. The session is checked
 * with getUser() before the query is read or any search runs.
 */
export async function GET(request: NextRequest) {
  const host = await openHostRequest(request.headers);
  if (!host.ok) return host.response;
  const params = request.nextUrl.searchParams;
  return hostOutcome(await runSearch(host.ctx, { q: params.get("q"), prefix: params.get("prefix"), org: params.get("org") }));
}
