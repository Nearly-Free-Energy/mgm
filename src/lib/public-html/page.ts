/**
 * One small, complete HTML page for responses served without the app: no
 * React, no JavaScript, no web font, and nothing to fetch after the page
 * itself. Pure (no database, no environment), so middleware and route
 * handlers can both use it.
 *
 * Every string a caller passes is plain text and is escaped here. A link
 * may point only at a path on this site or at a WhatsApp chat
 * (`https://wa.me/<digits>`); anything else throws, because it is a mistake
 * in the calling code, not something a visitor can cause.
 */
import { NextResponse } from "next/server";
import { PUBLIC_COPY, type PublicLanguage } from "./copy";
import { PALETTE, type PublicColour } from "./palette";

export type PublicTone = "neutral" | "warning";

export interface PublicBrand {
  /** The operator's name; cut to MAX_BRAND_CHARS. */
  name: string;
  /** A line under the name, such as the community; cut to MAX_BRAND_CHARS. */
  subtitle?: string;
  /** `#rrggbb` for the rule above the name; any other value is ignored. */
  accentHex?: string;
  /**
   * A PNG or JPEG as a base64 `data:` URI of at most MAX_LOGO_BYTES. Any
   * other value, an SVG or a URL included, is ignored.
   */
  logoDataUri?: string;
}

export interface PublicAction {
  /** A path on this site (`/…`) or `https://wa.me/<digits>`. */
  href: string;
  label: string;
}

export interface PublicPageInput {
  /** The language the strings below are written in. */
  lang: PublicLanguage;
  title: string;
  heading: string;
  paragraphs: readonly string[];
  /** "warning" draws the notice on the warning colours. */
  tone?: PublicTone;
  brand?: PublicBrand;
  actions?: readonly PublicAction[];
}

/** The largest logo a page embeds, so a branded page stays well under 15 KB. */
export const MAX_LOGO_BYTES = 6144;

/** The brand's name and subtitle are cut to this many characters, for the same reason. */
export const MAX_BRAND_CHARS = 200;

/**
 * The security headers publicHtmlResponse puts on every page. The policy
 * allows the page's own <style> and `data:` images and nothing else: no
 * script runs, nothing else is fetched, no form submits and no <base>
 * applies, whatever the markup holds.
 */
export const PUBLIC_PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
});

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Plain text made safe for HTML text and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

const FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

// Layout first, then colours. Colours are written out per theme rather than
// read through var(): older mobile browsers ignore custom properties, and a
// literal keeps the page in its colours there. Spacing uses margins, not
// flex `gap`, for the same browsers.
const LAYOUT = [
  "*{box-sizing:border-box}",
  `body{margin:0;font:16px/1.5 ${FONT};-webkit-text-size-adjust:100%;word-wrap:break-word;overflow-wrap:anywhere}`,
  ".page{max-width:32rem;margin:0 auto;padding:24px 16px}",
  ".brand{display:flex;align-items:center;margin:0 0 24px;padding-top:16px;border-top:4px solid}",
  ".brand img{display:block;max-height:48px;max-width:96px;margin-right:12px}",
  ".brand div{min-width:0}",
  ".name{margin:0;font-size:18px;font-weight:600;line-height:1.25}",
  ".sub{margin:0}",
  "main{padding:20px 16px;border:1px solid;border-radius:8px}",
  "h1{margin:0 0 8px;font-size:22px;line-height:1.25}",
  "p{margin:0 0 12px}",
  ".actions{margin-top:16px}",
  ".btn{display:inline-block;min-height:44px;margin:0 8px 8px 0;padding:10px 16px;" +
    "border-radius:8px;font-weight:600;line-height:24px;text-decoration:none}",
  "footer{margin-top:24px;font-size:12px;text-align:center}",
].join("");

function colours(p: Readonly<Record<PublicColour, string>>): string {
  return [
    `body{background:${p.background};color:${p.foreground}}`,
    `.brand{border-top-color:${p.primary}}`,
    `.sub,footer{color:${p["muted-foreground"]}}`,
    `main{background:${p.card};border-color:${p.border}}`,
    `main.warning{background:${p["warning-muted"]};border-color:${p["warning-muted"]};color:${p["warning-fg"]}}`,
    `.btn{background:${p.primary};color:${p["primary-foreground"]}}`,
  ].join("");
}

const STYLE = `${LAYOUT}${colours(PALETTE.light)}@media (prefers-color-scheme:dark){${colours(PALETTE.dark)}}`;

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const RASTER_DATA_URI = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
/** The bytes each format starts with. */
const RASTER_SIGNATURE = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
} as const;
const SAME_SITE_PATH = /^\/(?![/\\])[!-~]*$/;
const WHATSAPP_CHAT = /^https:\/\/wa\.me\/\d+$/;

function acceptedLogo(uri: string | undefined): string | undefined {
  const m = uri === undefined ? null : RASTER_DATA_URI.exec(uri);
  if (!m) return undefined;
  const signature: readonly number[] = m[1] === "png" ? RASTER_SIGNATURE.png : RASTER_SIGNATURE.jpeg;
  const data = m[2];
  if (data.length % 4 !== 0) return undefined;
  const head = atob(data.slice(0, 12));
  if (!signature.every((byte, i) => head.charCodeAt(i) === byte)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding <= MAX_LOGO_BYTES ? uri : undefined;
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_BRAND_CHARS ? text : `${chars.slice(0, MAX_BRAND_CHARS - 1).join("")}…`;
}

function renderBrand(brand: PublicBrand): { html: string; css: string } {
  const accent = brand.accentHex !== undefined && HEX_COLOUR.test(brand.accentHex) ? brand.accentHex : undefined;
  const logo = acceptedLogo(brand.logoDataUri);
  const html = [
    '<header class="brand">',
    logo ? `<img src="${escapeHtml(logo)}" alt="">` : "",
    "<div>",
    `<p class="name">${escapeHtml(clip(brand.name))}</p>`,
    brand.subtitle ? `<p class="sub">${escapeHtml(clip(brand.subtitle))}</p>` : "",
    "</div></header>",
  ].join("");
  // After the dark block, so the operator's colour wins in both themes.
  return { html, css: accent ? `.brand{border-top-color:${accent}}` : "" };
}

function renderAction({ href, label }: PublicAction): string {
  const external = WHATSAPP_CHAT.test(href);
  // A backslash or control character can turn "/x" into another origin in
  // a browser's URL parser, so the path is printable ASCII without one.
  if (!external && !(SAME_SITE_PATH.test(href) && !href.includes("\\"))) {
    throw new Error("A public page link must be a path on this site or https://wa.me/<digits>");
  }
  const rel = external ? ' rel="noreferrer noopener"' : "";
  return `<a class="btn" href="${escapeHtml(href)}"${rel}>${escapeHtml(label)}</a>`;
}

/** The page as a complete HTML document. */
export function renderPublicPage(input: PublicPageInput): string {
  const actions = (input.actions ?? []).map(renderAction);
  const brand = input.brand ? renderBrand(input.brand) : { html: "", css: "" };
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(input.lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${STYLE}${brand.css}</style>`,
    "</head>",
    '<body><div class="page">',
    brand.html,
    input.tone === "warning" ? '<main class="warning">' : "<main>",
    `<h1>${escapeHtml(input.heading)}</h1>`,
    ...input.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`),
    actions.length > 0 ? `<div class="actions">${actions.join("")}</div>` : "",
    "</main>",
    `<footer>${escapeHtml(PUBLIC_COPY[input.lang].productName)}</footer>`,
    "</div></body>",
    "</html>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * An HTML response for a page from renderPublicPage. It always carries
 * `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store` and
 * PUBLIC_PAGE_SECURITY_HEADERS; `headers` adds to those and cannot replace
 * them.
 */
export function publicHtmlResponse(
  status: number,
  html: string,
  headers: Readonly<Record<string, string>> = {},
): NextResponse {
  const merged = new Headers(headers);
  merged.set("Content-Type", "text/html; charset=utf-8");
  merged.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) merged.set(name, value);
  return new NextResponse(html, { status, headers: merged });
}
