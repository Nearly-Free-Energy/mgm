/**
 * Href checks that read nothing but the string, so code running in a browser
 * can check an href again before using it. The server's checks
 * (../server/hrefs.ts) start from these and add the released routes and the
 * plugin catalog.
 */
import type { Href, OutHref } from "../../contract";

export const MAX_HREF_LENGTH = 2048;
const BASE = "https://host.invalid";

/**
 * A same-origin path. Refused: anything not starting with one "/", a
 * backslash, a control character, an encoded "/" or "\", and any path the URL
 * parser would rewrite. That covers "." and ".." segments, encoded or not, and
 * characters a path must carry percent-encoded, such as a space or "é".
 */
export function isSameOriginPath(href: string): boolean {
  if (href.length > MAX_HREF_LENGTH || !href.startsWith("/") || href.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(href) || /%(?:2f|5c)/i.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href, BASE);
  } catch {
    return false;
  }
  const path = href.split(/[?#]/, 1)[0];
  return url.origin === BASE && url.pathname === path;
}

export function isHref(href: unknown): href is Href {
  return typeof href === "string" && isSameOriginPath(href);
}

/** Characters encodeURIComponent leaves, plus percent escapes. */
const ENCODED = "[A-Za-z0-9%\\-_.!~*'()]*";

/** The only targets outside MGM a view may carry: a WhatsApp chat, a call, an SMS. */
export const OUT_HREF_PATTERNS = {
  whatsapp: new RegExp(`^https://wa\\.me/\\d{6,15}(?:\\?text=${ENCODED})?$`),
  tel: /^tel:\+\d{6,15}$/,
  sms: new RegExp(`^sms:\\+\\d{6,15}(?:\\?body=${ENCODED})?$`),
} as const;

export function isOutHref(href: unknown): href is OutHref {
  return typeof href === "string" && Object.values(OUT_HREF_PATTERNS).some((re) => re.test(href));
}
