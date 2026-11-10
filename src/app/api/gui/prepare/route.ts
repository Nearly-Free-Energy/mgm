import type { NextRequest } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { hostFailure, hostOutcome, routeHostContext } from "@/lib/gui/host/server/http";
import { prepareAction, readPrepareBody } from "@/lib/gui/host/server/prepare";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/gui/prepare with { action, params, body?, provenance? }: an
 * action's form and confirmation, for the signed-in person. Writes nothing;
 * the write goes to the action's own route. The session is checked with
 * getUser() before the body is read.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const host = routeHostContext(await getCurrentUserAccess(supabase), request.headers);
  if (!host.ok) return hostFailure(host.status, host.code, host.message);
  const body = await readPrepareBody(request);
  if (!body.ok) return hostOutcome(body);
  return hostOutcome(await prepareAction(host.ctx, body.value));
}
