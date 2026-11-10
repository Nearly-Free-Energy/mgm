import type { NextRequest } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { hostFailure, hostOutcome, routeHostContext } from "@/lib/gui/host/server/http";
import { collectSignals } from "@/lib/gui/host/server/signals";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/signals?org=<id>: what contributed watchers report for the
 * signed-in person's organization. The session is checked with getUser()
 * before any watcher runs.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const host = routeHostContext(await getCurrentUserAccess(supabase), request.headers);
  if (!host.ok) return hostFailure(host.status, host.code, host.message);
  return hostOutcome(await collectSignals(host.ctx, { requested: request.nextUrl.searchParams.get("org") }));
}
