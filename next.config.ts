import { readFileSync } from "node:fs";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// The GUI stylesheets' URLs by GUI name, written by
// scripts/gui/build-stylesheets.mjs, which `npm run build` and `npm run dev`
// run first. A production build stops without them, or when a URL is not
// content-hashed (the manifest `npm run dev` writes), because headers()
// below caches every /gui-styles/ file for a year. In development the
// interface layout falls back to the unhashed names.
const HASHED = /^\/gui-styles\/([a-z][a-z0-9-]{1,30})\.[0-9a-f]{12}\.css$/;

function guiStylesheets(phase: string): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync("src/gui/.generated/stylesheets.json", "utf8"));
  } catch (error) {
    if (phase !== PHASE_PRODUCTION_BUILD) return undefined;
    throw new Error(
      "src/gui/.generated/stylesheets.json is missing or unreadable: run `npm run build`, which builds the GUI stylesheets first",
      { cause: error },
    );
  }
  if (phase === PHASE_PRODUCTION_BUILD) {
    const entries = manifest && typeof manifest === "object" ? Object.entries(manifest) : [];
    if (entries.some(([name, url]) => typeof url !== "string" || HASHED.exec(url)?.[1] !== name)) {
      throw new Error(
        "src/gui/.generated/stylesheets.json does not name content-hashed stylesheets: run `npm run build`, not `next build` after `npm run dev`",
      );
    }
  }
  return JSON.stringify(manifest);
}

export default function nextConfig(phase: string): NextConfig {
  const stylesheets = guiStylesheets(phase);
  return {
    output: "standalone",
    // guiStylesheetHref() in src/lib/config/gui.ts reads this constant, a
    // string of JSON (Next.js quotes a string value itself).
    compiler: stylesheets === undefined ? {} : { defineServer: { __MGM_GUI_STYLESHEETS__: stylesheets } },
    // A production build names each stylesheet by its content's hash.
    async headers() {
      if (phase !== PHASE_PRODUCTION_BUILD) return [];
      return [
        {
          source: "/gui-styles/:file*",
          headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
        },
      ];
    },
    // PDF1b (#203): the PDF renderer registers Inter Regular/Bold via
    // `fontkit.open(<absolute-fs-path>)` at module-init (see
    // src/lib/invoices/render.tsx). Next.js's tracer cannot detect these
    // reads (no static `import` of the .ttf), so the deployed function would
    // ship without the fonts unless they are listed here explicitly.
    //
    // The PDF2 preview route (#204) shares the same renderer module and is
    // listed pre-emptively so #204's implementer doesn't have to retouch
    // this file. The two route globs are matched against route paths via
    // picomatch (`*` matches the `[lineItemId]` / `[id]` segments).
    outputFileTracingIncludes: {
      "/api/billing-line-items/*/pdf": ["./src/lib/invoices/fonts/**/*"],
      "/api/communities/*/invoice-preview": ["./src/lib/invoices/fonts/**/*"],
    },
  };
}
