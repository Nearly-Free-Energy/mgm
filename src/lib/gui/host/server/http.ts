import "server-only";

/**
 * What the GUI host's routes (src/app/api/gui/) share: the request's host
 * context and JSON responses that no cache keeps. Each answer is for one
 * person in one organization at one moment, so every response says
 * `Cache-Control: no-store, private`.
 */
import { NextResponse } from "next/server";
import type { CurrentUserAccess } from "@/lib/auth/access";
import { createClient } from "@/lib/supabase/server";
import type { HostFailureBody } from "../../contract";
import { createFmt } from "../../fmt";
import { hostContext } from "./access";

export const NO_STORE = "no-store, private";

/**
 * The host context for a route, on clients bound to this request's cookies.
 * `access` must come from getCurrentUserAccess on this request (see hostContext).
 */
export function routeHostContext(access: CurrentUserAccess, headers: Headers) {
  return hostContext(access, headers, { newClient: createClient, makeFmt: (locale) => createFmt({ locale }) });
}

export function hostJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

/**
 * A refusal as a HostFailureBody (../../contract.ts): ActionResult's failure
 * shape, which the kit already reads, with `error` beside `message`,
 * carrying the same text, so every host failure also has the
 * `{ error, code }` shape the plugin gate and the action routes answer with
 * (gateResponse in src/lib/runtime/gate.ts), and a client other than a GUI
 * reads one shape across MGM's routes (#275). failureOf
 * (../client/invoke.ts) reads `error` before `message`, and loadView
 * (../client/kit-runtime.tsx) reads only `error`; if the two keys could
 * ever differ, revisit which one each reads.
 */
export function hostFailure(status: number, code: string, message: string): NextResponse {
  const body: HostFailureBody = { type: "result", ok: false, status, code, message, error: message };
  return hostJson(body, status);
}

export function hostOutcome<T>(
  out: { ok: true; value: T } | { ok: false; status: number; code: string; message: string },
): NextResponse {
  return out.ok ? hostJson(out.value) : hostFailure(out.status, out.code, out.message);
}
