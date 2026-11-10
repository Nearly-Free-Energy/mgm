/**
 * next.config.ts carries the GUI stylesheet manifest into the server bundle
 * and caches the published stylesheets. These tests read its default export
 * with the manifest file replaced, so they need no build.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guiStylesheetHref } from "@/lib/config/gui";
import { MANIFEST } from "../../../scripts/gui/build-stylesheets.mjs";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((file: string, ...rest: unknown[]) => {
    if (typeof file === "string" && !path.isAbsolute(file)) {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return text;
    }
    return (fs.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

const { default: nextConfig } = await import("../../../next.config");

const REPO_ROOT = path.resolve(__dirname, "../../..");
// The identifier src/lib/config/gui.ts declares for the compiled-in manifest.
const CONSTANT = /declare const (\w+)/.exec(readFileSync(path.join(REPO_ROOT, "src/lib/config/gui.ts"), "utf8"))![1];
const HASHED = { gridtop: "/gui-styles/gridtop.3f9a1c2e4b5d.css" };
const constant = globalThis as Record<string, unknown>;

afterEach(() => {
  files.clear();
  delete constant[CONSTANT];
});

describe("next.config.ts and the GUI stylesheets", () => {
  it("compiles the manifest in under the name src/lib/config/gui.ts reads", () => {
    files.set(MANIFEST, JSON.stringify(HASHED));
    const defined = nextConfig(PHASE_PRODUCTION_BUILD).compiler?.defineServer ?? {};
    expect(Object.keys(defined)).toEqual([CONSTANT]);
    constant[CONSTANT] = defined[CONSTANT];
    expect(guiStylesheetHref("gridtop")).toBe(HASHED.gridtop);
  });

  it("stops a production build without the manifest, and not a development server", () => {
    expect(() => nextConfig(PHASE_PRODUCTION_BUILD)).toThrow(/npm run build/);
    expect(nextConfig(PHASE_DEVELOPMENT_SERVER).compiler).toEqual({});
  });

  it.each([
    ["the unhashed names a development build writes", { gridtop: "/gui-styles/gridtop.css" }],
    ["a URL under another GUI's name", { gridtop: "/gui-styles/other.3f9a1c2e4b5d.css" }],
    ["a URL elsewhere", { gridtop: "//elsewhere.example/gridtop.3f9a1c2e4b5d.css" }],
  ])("stops a production build on %s", (_case, manifest) => {
    files.set(MANIFEST, JSON.stringify(manifest));
    expect(() => nextConfig(PHASE_PRODUCTION_BUILD)).toThrow(/content-hashed/);
    expect(() => nextConfig(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
  });

  it("caches the stylesheets for a year in a production build only", async () => {
    files.set(MANIFEST, JSON.stringify(HASHED));
    expect(await nextConfig(PHASE_PRODUCTION_BUILD).headers?.()).toEqual([
      {
        source: "/gui-styles/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ]);
    expect(await nextConfig(PHASE_DEVELOPMENT_SERVER).headers?.()).toEqual([]);
  });
});
