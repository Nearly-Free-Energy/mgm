/**
 * Whether a LinkRef's href may be drawn as a real anchor: a page on this site
 * or one of the contract's outside targets (OutHref). An anchor's href is
 * followed without kit.open on a middle click or "open in new tab", so it
 * must pass the same checks kit.open makes first.
 *
 * These copy isSameOriginPath and OUT_HREF_PATTERNS from
 * src/lib/gui/host/shared/href.ts, which a GUI package may not import
 * (gui-boundary.test.ts, rule 6). If those change, change these with them;
 * if the kit comes to export its own check, use that instead.
 */
const MAX_HREF_LENGTH = 2048;
const BASE = "https://host.invalid";

const OUT_HREFS = [
  /^https:\/\/wa\.me\/\d{6,15}(?:\?text=[A-Za-z0-9%\-_.!~*'()]*)?$/,
  /^tel:\+\d{6,15}$/,
  /^sms:\+\d{6,15}(?:\?body=[A-Za-z0-9%\-_.!~*'()]*)?$/,
];

function isSameOriginPath(href: string): boolean {
  if (href.length > MAX_HREF_LENGTH || !href.startsWith("/") || href.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(href) || /%(?:2f|5c)/i.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href, BASE);
  } catch {
    return false;
  }
  return url.origin === BASE && url.pathname === href.split(/[?#]/, 1)[0];
}

export function openable(href: unknown): boolean {
  return typeof href === "string" && (isSameOriginPath(href) || OUT_HREFS.some((re) => re.test(href)));
}
