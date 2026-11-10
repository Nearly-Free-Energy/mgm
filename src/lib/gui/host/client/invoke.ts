"use client";

/**
 * The one request that writes: a prepared action sent to its own route.
 * Only the action host (./action-host.tsx) imports this module, and the kit
 * does not export it (write-path.test.ts), so a GUI cannot write except
 * through the host's form and confirmation.
 */
import type { ActionResult, Confirm, Confirmation, Json } from "../../contract";
import type { PreparedAction } from "../server/prepare";
import { isApiPath, isHref } from "../shared/href";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Only typed and ceremony routes read `confirmation`, so only they are sent it. */
export const sendsConfirmation = (level: Confirm) => level === "typed" || level === "ceremony";

/** A failure in ActionResult's shape from a route's JSON: `{ error | message, code?, field? }`. */
export function failureOf(status: number, body: unknown): ActionResult & { ok: false } {
  const json = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const text = (key: string) => (typeof json[key] === "string" ? (json[key] as string) : undefined);
  return {
    type: "result",
    ok: false,
    status,
    code: text("code") ?? `http_${status}`,
    message: (text("error") ?? text("message") ?? "Request failed").slice(0, 300),
    ...(text("field") === undefined ? {} : { field: text("field") }),
  };
}

export async function invoke(
  prepared: PreparedAction,
  form: Json | null,
  options: { level: Confirm; confirmation?: Confirmation; proposal?: string },
  fetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<ActionResult> {
  if (!WRITE_METHODS.has(prepared.method) || !isApiPath(prepared.path)) {
    return failureOf(0, { code: "gui_bad_action", error: "This action cannot be sent." });
  }
  const values = form !== null && typeof form === "object" && !Array.isArray(form) ? form : {};
  const body: Record<string, unknown> = { ...values, ...prepared.bound };
  delete body.confirmation;
  if (sendsConfirmation(options.level) && options.confirmation) body.confirmation = options.confirmation;
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Inert until a route reads it.
  if (options.proposal !== undefined && UUID_RE.test(options.proposal)) headers["x-mgm-proposal"] = options.proposal;

  let response: Response;
  try {
    response = await fetch(prepared.path, {
      method: prepared.method,
      headers,
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    return failureOf(0, { code: "network", error: "The request could not be completed. Check your connection." });
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) return failureOf(response.status, json);
  const out = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
  return {
    type: "result",
    ok: true,
    ...(typeof out.message === "string" ? { message: out.message.slice(0, 300) } : {}),
    ...(isHref(out.href) ? { href: out.href } : {}),
  };
}
