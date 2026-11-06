/**
 * The app icons in public/: each file is there at the size its name and the
 * page metadata promise, small, drawn in the brand colour, and reachable
 * without a session.
 *
 * scripts/icons/render-icons.mjs writes every file checked here. When one of
 * these tests fails after a brand colour or artwork change, re-run it (see
 * its header) rather than editing the files by hand.
 */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inflateSync } from "node:zlib";
import { PALETTE } from "@/lib/public-html/palette";

vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-inter" }),
}));
vi.mock("@/app/globals.css", () => ({}));

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PUBLIC = path.join(REPO_ROOT, "public");
const SCRIPT = path.join(REPO_ROOT, "scripts/icons/render-icons.mjs");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Square PNG icons: public path, side in pixels, whether it must be opaque. */
const PNG_ICONS = [
  // iOS fills transparent pixels with black, and a launcher crops a maskable
  // icon to its own shape: both must fill the whole square.
  { url: "/apple-touch-icon.png", size: 180, opaque: true },
  { url: "/icons/icon-192.png", size: 192, opaque: false },
  { url: "/icons/icon-512.png", size: 512, opaque: false },
  { url: "/icons/icon-maskable-512.png", size: 512, opaque: true },
] as const;

const ICON_URLS = ["/favicon.ico", "/icon.svg", ...PNG_ICONS.map((icon) => icon.url)];

function readPublic(url: string): Buffer {
  return readFileSync(path.join(PUBLIC, url));
}

function pngChunks(bytes: Buffer): { type: string; data: Buffer }[] {
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    chunks.push({
      type: bytes.toString("latin1", at + 4, at + 8),
      data: bytes.subarray(at + 8, at + 8 + length),
    });
    at += 12 + length;
  }
  return chunks;
}

function pngInfo(bytes: Buffer) {
  const chunks = new Map(pngChunks(bytes).map(({ type, data }) => [type, data]));
  const header = chunks.get("IHDR");
  expect(header).toBeDefined();
  return {
    width: header!.readUInt32BE(0),
    height: header!.readUInt32BE(4),
    colourType: header![9],
    chunks,
  };
}

/** The PNGs inside an .ico, with the size its directory gives each one. */
function icoImages(bytes: Buffer): { size: number; png: Buffer }[] {
  expect(bytes.readUInt16LE(0)).toBe(0); // reserved
  expect(bytes.readUInt16LE(2)).toBe(1); // type: icon
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
    const entry = 6 + 16 * i;
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    return { size: bytes[entry] || 256, png: bytes.subarray(offset, offset + length) };
  });
}

/**
 * What a PNG shows, without the compressed bytes, which can differ between
 * zlib builds: its header and palette chunks, and a hash of its rows.
 */
function pngPicture(bytes: Buffer) {
  const chunks = pngChunks(bytes);
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  return {
    chunks: chunks
      .filter((c) => c.type !== "IDAT")
      .map((c) => `${c.type} ${c.data.toString("hex")}`),
    rows: createHash("sha256").update(inflateSync(idat)).digest("hex"),
  };
}

function iconPicture(url: string, bytes: Buffer) {
  if (url.endsWith(".svg")) return bytes.toString("utf8");
  if (url.endsWith(".ico")) {
    return icoImages(bytes).map(({ size, png }) => ({ size, ...pngPicture(png) }));
  }
  return pngPicture(bytes);
}

function paletteColours(plte: Buffer): string[] {
  const colours: string[] = [];
  for (let at = 0; at + 3 <= plte.length; at += 3) {
    colours.push(`#${plte.subarray(at, at + 3).toString("hex")}`);
  }
  return colours;
}

describe("app icon files", () => {
  it.each(PNG_ICONS)("$url is a $size px square PNG of at most 16 KB", ({ url, size }) => {
    const bytes = readPublic(url);
    const info = pngInfo(bytes);
    expect([info.width, info.height]).toEqual([size, size]);
    expect(bytes.length).toBeLessThanOrEqual(16 * 1024);
  });

  it.each(PNG_ICONS.filter((icon) => icon.opaque))("$url has no transparent pixels", ({ url }) => {
    const info = pngInfo(readPublic(url));
    // Palette (3) or RGB (2) with no tRNS chunk carries no alpha at all.
    expect([2, 3]).toContain(info.colourType);
    expect(info.chunks.has("tRNS")).toBe(false);
  });

  it.each(PNG_ICONS)("$url is drawn in the brand primary from palette.ts", ({ url }) => {
    const info = pngInfo(readPublic(url));
    // The script writes these as palette PNGs, so the colours can be read
    // without decoding pixels.
    expect(info.colourType).toBe(3);
    const colours = paletteColours(info.chunks.get("PLTE")!);
    expect(colours).toContain(PALETTE.light.primary);
    expect(colours).toContain("#ffffff");
  });

  it("favicon.ico holds 16, 32 and 48 px PNGs in at most 8 KB", () => {
    const bytes = readPublic("/favicon.ico");
    expect(bytes.length).toBeLessThanOrEqual(8 * 1024);
    const images = icoImages(bytes);
    for (const { size, png } of images) {
      const info = pngInfo(png);
      expect([info.width, info.height]).toEqual([size, size]);
    }
    expect(images.map((image) => image.size)).toEqual([16, 32, 48]);
  });

  it("icon.svg is a small, self-contained drawing in the brand primary", () => {
    const svg = readPublic("/icon.svg").toString("utf8");
    expect(svg.length).toBeLessThanOrEqual(2 * 1024);
    expect(svg).toContain(`fill="${PALETTE.light.primary}"`);
    // Shapes only: nothing that loads, links or runs.
    const elements = new Set([...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((match) => match[1]));
    expect([...elements].sort()).toEqual(["polygon", "rect", "svg"]);
    expect(svg).not.toMatch(/href|url\(|\son[a-z]+=/i);
  });

  it("matches, pixel for pixel, what the script draws with its default colour", { timeout: 60_000 }, () => {
    // Together with the brand-primary checks above, this also keeps the
    // script's default colour equal to palette.ts.
    const out = mkdtempSync(path.join(os.tmpdir(), "mgm-icons-"));
    try {
      execFileSync(process.execPath, [SCRIPT, "--out", out], { stdio: "pipe" });
      for (const url of ICON_URLS) {
        const drawn = readFileSync(path.join(out, url));
        expect(iconPicture(url, readPublic(url)), url).toEqual(iconPicture(url, drawn));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("has no Next.js file-convention icons in src/app", () => {
    // A favicon.ico, icon.* or apple-icon.* in src/app replaces the icons
    // declared in the root layout's metadata, and a favicon.ico there
    // collides with public/favicon.ico.
    const conventionIcons = readdirSync(path.join(REPO_ROOT, "src/app")).filter((name) =>
      /^(favicon\.ico|icon\d*\.|apple-icon\d*\.)/.test(name),
    );
    expect(conventionIcons).toEqual([]);
  });
});

describe("app icon metadata", () => {
  it("the root layout declares the favicon, the SVG icon and the Apple touch icon", async () => {
    const { metadata } = await import("@/app/layout");
    const icons = metadata.icons as {
      icon: { url: string; sizes?: string; type?: string }[];
      apple: { url: string; sizes?: string; type?: string }[];
    };
    expect(icons.icon).toEqual([
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ]);
    expect(icons.apple).toEqual([{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]);
    for (const { url } of [...icons.icon, ...icons.apple]) {
      expect(existsSync(path.join(PUBLIC, url)), url).toBe(true);
    }
  });

  it("every icon loads without the middleware running, so a signed-out browser gets it", async () => {
    const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
    const { config } = await import("@/middleware");
    for (const url of ICON_URLS) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
    }
    // The check can fail: pages still go through the middleware.
    expect(unstable_doesMiddlewareMatch({ config, url: "/login" })).toBe(true);
  });
});
