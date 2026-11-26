import type { NextRequest } from "next/server";
import { hostOutcome, openHostRequest } from "@/lib/gui/host/server/http";
import { prepareAction, readPrepareBody } from "@/lib/gui/host/server/prepare";

export const dynamic = "force-dynamic";

/**
 * POST /api/gui/prepare with { action, params, body?, provenance? }: an
 * action's form and confirmation, for the signed-in person. Writes nothing;
 * the write goes to the action's own route. The session is checked with
 * getUser() before the body is read.
 */
export async function POST(request: NextRequest) {
  const host = await openHostRequest(request.headers);
  if (!host.ok) return host.response;
  const body = await readPrepareBody(request);
  if (!body.ok) return hostOutcome(body);
  return hostOutcome(await prepareAction(host.ctx, body.value));
}
