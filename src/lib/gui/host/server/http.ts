import "server-only";

/**
 * What the GUI host's routes (src/app/api/gui/) share: the request's host
 * context and JSON responses that no cache keeps. Each answer is for one
 * person in one organization at one moment, so every response says
 * `Cache-Control: no-store, private`.
 */
import { NextResponse } from "next/server";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { callerOf } from "@/lib/runtime/caller";
import { createClient } from "@/lib/supabase/server";
import type { HostFailureBody } from "../../contract";
import { createFmt } from "../../fmt";
import { hostContext, type HostContext } from "./access";
import { AGENT_REFUSED } from "./agent";

export const NO_STORE = "no-store, private";

/**
 * The host context for one of the host's routes, or the response that
 * refuses the request. Every route under src/app/api/gui/ opens its request
 * here, first, before it reads its query or body.
 *
 * The session is checked with getUser() (getCurrentUserAccess) on a client
 * from createClient, the request's cookie session or the bearer token
 * middleware accepted (@/lib/runtime/request-session), and the caller is
 * read from that same client (callerOf), so it comes from claims Supabase
 * Auth has just accepted. Every later read gets a new client from
 * createClient (see hostContext).
 *
 * An agent client is refused (403 `gui_agent_refused`) unless the route
 * names itself in `agent`: only the catalog and the view route do, the two
 * routes of AGENT_ROUTES (@/lib/runtime/agent-routes), which middleware
 * already limits an agent client to. This is the second fence: a route
 * added to that list without opting in here still refuses.
 */
export async function openHostRequest(
  headers: Headers,
  opts: { agent?: "catalog" | "view" } = {},
): Promise<{ ok: true; ctx: HostContext } | { ok: false; response: NextResponse }> {
  const supabase = await createClient();
  const caller = callerOf(supabase);
  const host = hostContext(await getCurrentUserAccess(supabase), headers, {
    newClient: createClient,
    makeFmt: (locale) => createFmt({ locale }),
    caller,
  });
  if (!host.ok) return { ok: false, response: hostFailure(host.status, host.code, host.message) };
  if (caller.kind === "agent" && opts.agent === undefined) {
    return { ok: false, response: hostFailure(403, AGENT_REFUSED.code, AGENT_REFUSED.message) };
  }
  return { ok: true, ctx: host.ctx };
}

export function hostJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

/**
 * A refusal as a HostFailureBody (../../contract.ts): ActionResult's failure
 * shape, which the kit already reads, with `error` beside `message`,
 * carrying the same text, so every host failure also has the
 * `{ error, code }` shape the plugin gate and parseJsonBody answer with
 * (gateResponse in src/lib/runtime/gate.ts), and a client other than a GUI
 * reads the host's refusals as it reads theirs (#275). An action route's
 * own refusals are not all alike (ActionRefusal in ./openapi.ts). failureOf
 * (../client/invoke.ts) reads `error` before `message`, and loadView
 * (../client/kit-runtime.tsx) reads only `error`; if the two keys could
 * ever differ, revisit which one each reads.
 */
export function hostFailure(status: number, code: string, message: string, retryAfter?: number): NextResponse {
  const body: HostFailureBody = { type: "result", ok: false, status, code, message, error: message };
  const response = hostJson(body, status);
  // A rate limit's refusal (HostFailure in ./view.ts) says when to ask again.
  if (retryAfter !== undefined) response.headers.set("Retry-After", String(retryAfter));
  return response;
}

export function hostOutcome<T>(
  out: { ok: true; value: T } | { ok: false; status: number; code: string; message: string; retryAfter?: number },
): NextResponse {
  return out.ok ? hostJson(out.value) : hostFailure(out.status, out.code, out.message, out.retryAfter);
}
