import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  MAX_BRAND_CHARS,
  MAX_LOGO_BYTES,
  PUBLIC_PAGE_SECURITY_HEADERS,
  publicHtmlResponse,
  renderPublicPage,
  type PublicPageInput,
} from "../page";
import { PALETTE } from "../palette";

const PLAIN: PublicPageInput = {
  lang: "en",
  title: "Title",
  heading: "Heading",
  paragraphs: ["First paragraph.", "Second paragraph."],
};

/** A base64 data URI of `bytes` bytes that starts with the format's signature. */
function rasterDataUri(format: "png" | "jpeg", bytes: number): string {
  const signature =
    format === "png" ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff, 0xe0];
  const body = Buffer.alloc(bytes, 0x41);
  Buffer.from(signature).copy(body);
  return `data:image/${format};base64,${body.toString("base64")}`;
}

function styleOf(html: string): string {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (!m) throw new Error("no <style> block");
  return m[1];
}

const count = (text: string, ch: string) => text.split(ch).length - 1;

const HOSTILE = [
  "</title><script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  "<style>body{display:none}</style>",
  "&lt;already escaped&gt; & raw",
  "</main><a href=\"https://evil.example\">Pay here</a>",
  "\u0000 <!-- -->",
];

describe("escapeHtml", () => {
  it("escapes the five characters that can end text or an attribute", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes an ampersand that already starts an entity", () => {
    expect(escapeHtml("&lt;b&gt;")).toBe("&amp;lt;b&amp;gt;");
  });

  it("leaves other text as it is", () => {
    expect(escapeHtml("Example Community — UGX 4,216,800 / 07 Nov")).toBe(
      "Example Community — UGX 4,216,800 / 07 Nov",
    );
  });
});

describe("renderPublicPage", () => {
  it("renders a complete document with its metadata, notice and footer", () => {
    const html = renderPublicPage(PLAIN);
    expect(html.startsWith("<!doctype html>\n")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain("<title>Title</title>");
    expect(html).toContain("<main>\n<h1>Heading</h1>\n<p>First paragraph.</p>\n<p>Second paragraph.</p>\n</main>");
    expect(html).toContain("<footer>Microgrid Manager</footer>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(count(html, "<style>")).toBe(1);
  });

  it("loads nothing and runs nothing: no script, handler, external URL, stylesheet or font", () => {
    const html = renderPublicPage({
      ...PLAIN,
      brand: { name: "Operator", subtitle: "Community", accentHex: "#336699", logoDataUri: rasterDataUri("png", 64) },
      actions: [
        { href: "/", label: "Start" },
        { href: "https://wa.me/256700000000", label: "WhatsApp" },
      ],
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<link|<iframe|<object|<embed|<form|<base/i);
    expect(html).not.toMatch(/http:\/\//);
    expect(html).not.toMatch(/@import|@font-face|url\(/);
    expect([...html.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1].slice(0, 15))).toEqual(["data:image/png;"]);
    expect([...html.matchAll(/\shref="(https:[^"]*)"/g)].map((m) => m[1])).toEqual([
      "https://wa.me/256700000000",
    ]);
  });

  it.each(HOSTILE)("escapes %j wherever a caller's text appears", (text) => {
    const shape = (s: string): PublicPageInput => ({
      lang: "en",
      title: s,
      heading: s,
      paragraphs: [s, s],
      brand: { name: s, subtitle: s },
      actions: [{ href: "/", label: s }],
    });
    const benign = renderPublicPage(shape("x"));
    const hostile = renderPublicPage(shape(text));
    // The caller's text adds no tag and no attribute quote.
    expect(count(hostile, "<")).toBe(count(benign, "<"));
    expect(count(hostile, '"')).toBe(count(benign, '"'));
    expect(count(hostile, "'")).toBe(count(benign, "'"));
    expect(hostile).not.toMatch(/<script|<img|<a href="https:|<!--/i);
    expect(hostile).toContain(`<title>${escapeHtml(text)}</title>`);
    expect(hostile).toContain(`<p class="name">${escapeHtml(text)}</p>`);
  });

  it("draws the notice in the warning colours only for the warning tone", () => {
    expect(renderPublicPage({ ...PLAIN, tone: "warning" })).toContain('<main class="warning">');
    expect(renderPublicPage({ ...PLAIN, tone: "neutral" })).toContain("<main>");
    expect(renderPublicPage(PLAIN)).toContain("<main>");
  });

  describe("colours", () => {
    it("uses the palette, with the dark values under the system's dark setting", () => {
      const style = styleOf(renderPublicPage(PLAIN));
      const darkAt = style.indexOf("@media (prefers-color-scheme:dark){");
      expect(darkAt).toBeGreaterThan(0);
      const light = new Set(style.slice(0, darkAt).match(/#[0-9a-f]{6}\b/gi));
      const dark = new Set(style.slice(darkAt).match(/#[0-9a-f]{6}\b/gi));
      expect([...light].sort()).toEqual([...new Set(Object.values(PALETTE.light))].sort());
      expect([...dark].sort()).toEqual([...new Set(Object.values(PALETTE.dark))].sort());
    });

    it("writes colours out instead of reading custom properties", () => {
      const style = styleOf(renderPublicPage(PLAIN));
      expect(style).not.toMatch(/var\(|--[a-z]/);
      expect(style).not.toMatch(/oklch|color-mix/);
    });

    it("draws the operator's colour above the brand in both themes", () => {
      const style = styleOf(renderPublicPage({ ...PLAIN, brand: { name: "Op", accentHex: "#A1B2C3" } }));
      expect(style.endsWith("}.brand{border-top-color:#A1B2C3}")).toBe(true);
    });

    it.each(["red", "#abc", "#12345g", "#1234567", "#123456;}body{display:none", "url(x)", " #123456", ""])(
      "ignores the accent %j",
      (accentHex) => {
        const html = renderPublicPage({ ...PLAIN, brand: { name: "Op", accentHex } });
        expect(styleOf(html)).toBe(styleOf(renderPublicPage({ ...PLAIN, brand: { name: "Op" } })));
      },
    );
  });

  describe("brand", () => {
    it("shows the operator's name and subtitle above the notice", () => {
      const html = renderPublicPage({ ...PLAIN, brand: { name: "Watts & Co", subtitle: "Example Community" } });
      expect(html).toContain(
        '<header class="brand"><div><p class="name">Watts &amp; Co</p><p class="sub">Example Community</p></div></header>\n<main>',
      );
    });

    it("cuts a long name or subtitle short, whole characters only", () => {
      const long = "\u{1F31E}".repeat(MAX_BRAND_CHARS + 50);
      const html = renderPublicPage({ ...PLAIN, brand: { name: long, subtitle: `${"a".repeat(MAX_BRAND_CHARS)}b` } });
      const cut = `${"\u{1F31E}".repeat(MAX_BRAND_CHARS - 1)}\u2026`;
      expect(html).toContain(`<p class="name">${cut}</p>`);
      expect(html).toContain(`<p class="sub">${"a".repeat(MAX_BRAND_CHARS - 1)}\u2026</p>`);
      const exact = "a".repeat(MAX_BRAND_CHARS);
      expect(renderPublicPage({ ...PLAIN, brand: { name: exact } })).toContain(`<p class="name">${exact}</p>`);
    });

    it("leaves the header out without a brand, and the subtitle out without one", () => {
      expect(renderPublicPage(PLAIN)).not.toContain("<header");
      expect(renderPublicPage({ ...PLAIN, brand: { name: "Op" } })).not.toContain('class="sub"');
    });

    it.each([
      ["a PNG", rasterDataUri("png", 300)],
      ["a JPEG", rasterDataUri("jpeg", 300)],
      ["a logo of exactly the largest size", rasterDataUri("png", MAX_LOGO_BYTES)],
      ["a logo of the largest size less one byte", rasterDataUri("png", MAX_LOGO_BYTES - 1)],
    ])("embeds %s", (_, logoDataUri) => {
      const html = renderPublicPage({ ...PLAIN, brand: { name: "Op", logoDataUri } });
      expect(html).toContain(`<img src="${logoDataUri}" alt="">`);
    });

    it.each([
      ["a logo one byte too large", rasterDataUri("png", MAX_LOGO_BYTES + 1)],
      ["an SVG", `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`],
      ["SVG bytes labelled PNG", `data:image/png;base64,${Buffer.from("<svg onload=alert(1)></svg>").toString("base64")}`],
      ["JPEG bytes labelled PNG", rasterDataUri("jpeg", 300).replace("image/jpeg", "image/png")],
      ["a GIF", `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`],
      ["a URL", "https://storage.example/invoice-logos/logo.png"],
      ["a site path", "/api/communities/1/invoice-logo"],
      ["a URI with a quote", `${rasterDataUri("png", 30)}" onerror="alert(1)`],
      ["a URI with text after it", `${rasterDataUri("png", 30)} x`],
      ["base64 of a broken length", rasterDataUri("png", 30).slice(0, -1)],
      ["an empty value", ""],
    ])("ignores %s as a logo", (_, logoDataUri) => {
      const html = renderPublicPage({ ...PLAIN, brand: { name: "Op", logoDataUri } });
      expect(html).not.toContain("<img");
      expect(html).toContain('<p class="name">Op</p>');
    });
  });

  describe("links", () => {
    it.each(["/", "/api/billing-line-items/8a8c1d0e-5b7f-4c35-9a2e-1f0b6c3d2e10/pay", "/settings?tab=a&b=c"])(
      "links to the path %s on this site",
      (href) => {
        const html = renderPublicPage({ ...PLAIN, actions: [{ href, label: "Go" }] });
        expect(html).toContain(`<div class="actions"><a class="btn" href="${escapeHtml(href)}">Go</a></div>`);
      },
    );

    it("links to a WhatsApp chat without sending a referrer", () => {
      const html = renderPublicPage({ ...PLAIN, actions: [{ href: "https://wa.me/256700000000", label: "WhatsApp" }] });
      expect(html).toContain('<a class="btn" href="https://wa.me/256700000000" rel="noreferrer noopener">WhatsApp</a>');
    });

    it("leaves the actions out when there are none", () => {
      expect(renderPublicPage({ ...PLAIN, actions: [] })).not.toContain('<div class="actions">');
      expect(renderPublicPage(PLAIN)).not.toContain("<a ");
    });

    it.each([
      "",
      "relative/path",
      "//evil.example/",
      "/\\evil.example/",
      "/\\/evil.example",
      "/a\\b",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      " /leading-space",
      "/with space",
      "/café",
      "/\u0000",
      "/\u007f",
      "https://evil.example/",
      "https://wa.me.evil.example/256700000000",
      "https://wa.me/256700000000?text=hi",
      "https://wa.me/+256700000000",
      "https://wa.me/",
      "http://wa.me/256700000000",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "mailto:someone@example.com",
    ])("refuses the link %j", (href) => {
      expect(() => renderPublicPage({ ...PLAIN, actions: [{ href, label: "Go" }] })).toThrow(
        /path on this site or https:\/\/wa\.me/,
      );
    });
  });

  describe("size", () => {
    it("keeps a page without a brand under 4 KB", () => {
      const html = renderPublicPage({ ...PLAIN, tone: "warning", actions: [{ href: "/", label: "Go to the start page" }] });
      expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(4096);
    });

    it("keeps the largest branded page under 15 KB", () => {
      // The longest name and subtitle the brand keeps, in the character that
      // grows most when escaped. The name appears in a paragraph too, as a
      // page that offers a WhatsApp contact would show it.
      const name = '"'.repeat(MAX_BRAND_CHARS);
      const html = renderPublicPage({
        lang: "en",
        title: "Payment not confirmed yet",
        heading: "Payment not confirmed yet",
        paragraphs: [
          "Payment confirmation is pending. Please contact your operator before trying again.",
          `Questions about this payment? Message ${name} on WhatsApp.`,
        ],
        tone: "warning",
        brand: { name, subtitle: name, accentHex: "#123456", logoDataUri: rasterDataUri("png", MAX_LOGO_BYTES) },
        actions: [{ href: "https://wa.me/256700000000000", label: "WhatsApp +256 700 000 000 000" }],
      });
      expect(Buffer.byteLength(html, "utf8")).toBeLessThan(15 * 1024);
    });
  });
});

describe("publicHtmlResponse", () => {
  it("serves the page as uncached HTML with the security headers", async () => {
    const html = renderPublicPage(PLAIN);
    const res = publicHtmlResponse(409, html);
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(html);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
  });

  it("names exactly the four security headers", () => {
    expect(Object.keys(PUBLIC_PAGE_SECURITY_HEADERS).sort()).toEqual([
      "Content-Security-Policy",
      "Referrer-Policy",
      "X-Content-Type-Options",
      "X-Robots-Tag",
    ]);
    expect(Object.isFrozen(PUBLIC_PAGE_SECURITY_HEADERS)).toBe(true);
  });

  it("allows the page's own styles and data: images, and nothing else", () => {
    const policy = PUBLIC_PAGE_SECURITY_HEADERS["Content-Security-Policy"];
    const directives = Object.fromEntries(
      policy.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values.join(" ")];
      }),
    );
    expect(directives).toEqual({
      "default-src": "'none'",
      "img-src": "data:",
      "style-src": "'unsafe-inline'",
      "base-uri": "'none'",
      "form-action": "'none'",
    });
    expect(PUBLIC_PAGE_SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(PUBLIC_PAGE_SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(PUBLIC_PAGE_SECURITY_HEADERS["X-Robots-Tag"]).toBe("noindex, nofollow");
  });

  it("adds a caller's headers", () => {
    const res = publicHtmlResponse(429, "", { "Retry-After": "42", "Content-Language": "en", Vary: "Accept-Language" });
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("content-language")).toBe("en");
    expect(res.headers.get("vary")).toBe("Accept-Language");
  });

  it("does not let a caller's headers replace its own, in any case", () => {
    const res = publicHtmlResponse(200, "", {
      "content-type": "text/plain",
      "Cache-Control": "public, max-age=60",
      "content-security-policy": "default-src *",
      "REFERRER-POLICY": "unsafe-url",
      "x-robots-tag": "all",
    });
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(PUBLIC_PAGE_SECURITY_HEADERS["Content-Security-Policy"]);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
