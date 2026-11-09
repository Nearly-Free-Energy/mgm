/**
 * Where to send a person after they sign in (#126).
 *
 * The middleware sends a signed-out page request to `/login?next=<path>`,
 * and the login page reads `next` back. `next` arrives in a URL anyone can
 * write, so it is followed only when it stays on this site; anything else
 * goes to the start page.
 */

/** The query parameter that carries the page to return to. */
export const RETURN_PATH_PARAM = "next";

const START_PAGE = "/";

// Only used to resolve `next` the way a browser would. Any origin works as
// long as it is the one the result is compared against.
const BASE = "http://mgm.invalid";

/**
 * The path, query and fragment of `value` when it is a same-site relative
 * path, otherwise `/`.
 *
 * Rejected:
 * - anything not starting with exactly one `/` (`https://…`, `//host`,
 *   `javascript:…`, `evil.com`);
 * - backslashes, which browsers read as `/`, so `/\host` is `//host`;
 * - control characters and whitespace, which browsers strip from URLs, so
 *   `/<tab>/host` is `//host`;
 * - a value whose resolved path starts with `//` (`/.//host` resolves to
 *   `//host`), since the result is handed to the router as it is;
 * - `/login` itself, which would only show the form again.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return START_PAGE;
  }
  if (value.includes("\\") || /[\u0000- \u007f]/.test(value)) {
    return START_PAGE;
  }
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return START_PAGE;
  }
  if (url.origin !== BASE || url.pathname.startsWith("//")) {
    return START_PAGE;
  }
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) {
    return START_PAGE;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The value to put in `next` for a request to `pathname` with `search`, or
 * null when there is nothing to return to (the start page itself).
 */
export function returnPathFor(pathname: string, search: string): string | null {
  const path = `${pathname}${search}`;
  return path === START_PAGE ? null : path;
}
