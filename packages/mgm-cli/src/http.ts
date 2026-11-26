/**
 * Requests: addresses the CLI will talk to, a timeout on every request, and
 * how MGM's refusals are read.
 */
import { Unreachable, messageOf } from "./errors.ts";

/** The fetch the CLI uses; tests pass their own. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Every request gives up after this long. A refresh therefore ends well
 * inside the token file's stale-lock time (lock.ts), so no command ever
 * takes over the lock of one still refreshing.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * True for an address the CLI sends a token or a code to: https, or http on
 * this computer (a local installation).
 */
export function isSecureOrLoopback(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
}

/** `url` parsed, or null when it is not an address the CLI may use. */
export function usableUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return isSecureOrLoopback(url) && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

/**
 * `fetch` with the CLI's timeout. A request that fails or times out, and an
 * answer of 500 or more, throw Unreachable; every other answer is returned.
 * Redirects are never followed for the caller: a 3xx is returned as it is.
 * Only the discovery request, which carries no credential, follows them, by
 * hand and checking each address (discovery.ts).
 */
export async function send(fetch: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Unreachable(`${new URL(url).origin} did not answer (${messageOf(error)})`);
  }
  if (res.status >= 500) {
    const refusal = await readRefusal(res);
    throw new Unreachable(`${new URL(url).origin} answered ${res.status}${refusal.error ? `: ${refusal.error}` : ""}`);
  }
  return res;
}

/**
 * What a refusal says. MGM answers `{ error, code }` from most routes, but
 * `{ error }` alone from some and plain text for a path the installation's
 * release does not include, so `code` is read only when it is there.
 */
export async function readRefusal(res: Response): Promise<{ status: number; error: string; code: string | null }> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = [body.error_description, body.error, body.msg, body.message].find((v) => typeof v === "string" && v !== "");
    const code = [body.code, body.error_code, body.error].find((v) => typeof v === "string" && v !== "");
    return { status: res.status, error: (error as string | undefined) ?? text.trim(), code: (code as string | undefined) ?? null };
  } catch {
    return { status: res.status, error: text.trim().slice(0, 300), code: null };
  }
}

/** The JSON body of a successful answer, or null when it is not a JSON object. */
export async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
