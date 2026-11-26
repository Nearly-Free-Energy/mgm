import type { NextRequest } from "next/server";
import { hostOutcome, openHostRequest } from "@/lib/gui/host/server/http";
import { collectSignals } from "@/lib/gui/host/server/signals";

export const dynamic = "force-dynamic";

/**
 * GET /api/gui/signals?org=<id>: what contributed watchers report for the
 * signed-in person's organization. The session is checked with getUser()
 * before any watcher runs.
 */
export async function GET(request: NextRequest) {
  const host = await openHostRequest(request.headers);
  if (!host.ok) return host.response;
  return hostOutcome(await collectSignals(host.ctx, { requested: request.nextUrl.searchParams.get("org") }));
}
