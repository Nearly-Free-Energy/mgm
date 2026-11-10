/**
 * The GUI stylesheet build (scripts/gui/build-stylesheets.mjs): each
 * compiled-in GUI's stylesheet is built on its own sources into a
 * content-hashed file, and globals.css leaves those sources to it. Both
 * import the host's tokens, so the two stylesheets agree on every value.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { afterEach, describe, expect, it } from "vitest";
import { GUI_META } from "@/gui/meta";
import {
  buildStylesheets,
  compileStylesheet,
  findGuis,
  MANIFEST,
  OUT_DIR,
  scanStylesheet,
  writeStylesheets,
} from "../../../scripts/gui/build-stylesheets.mjs";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const GLOBALS = path.join(REPO_ROOT, "src/app/globals.css");
const TOKENS = path.join(REPO_ROOT, "src/styles/tokens.css");

// Fixture packages live under node_modules/.cache so that their stylesheets
// resolve `tailwindcss` from the project's own node_modules.
const fixtures: string[] = [];
function fixtureRoot(packages: Record<string, Record<string, string>>): string {
  const cache = path.join(REPO_ROOT, "node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "gui-stylesheets-test-"));
  fixtures.push(root);
  for (const [dir, files] of Object.entries(packages)) {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(root, "src/gui", dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

const meta = (fields: string) => `export const META = { ${fields}, dependencies: [] } as const;\n`;

/** The rules inside the first `@layer <name>{…}` block of minified CSS. */
function layerBlock(css: string, name: string): string {
  const start = css.indexOf(`@layer ${name}{`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start + `@layer ${name}`.length; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return "";
}

/** Gridtop's styles.css, its tokens import made absolute, as a fixture package. */
function demoPackage(view: string): Record<string, string> {
  const styles = readFileSync(path.join(REPO_ROOT, "src/gui/gridtop/styles.css"), "utf8").replace(
    "../../styles/tokens.css",
    TOKENS,
  );
  return { "meta.ts": meta('name: "demo", styles: "./styles.css"'), "styles.css": styles, "view.tsx": view };
}

/** Of these candidates, the ones a compiler generates CSS for. */
function generated(compiler: { build(candidates: string[]): string }, candidates: Iterable<string>): string[] {
  let size = compiler.build([]).length;
  const out: string[] = [];
  for (const candidate of candidates) {
    const next = compiler.build([candidate]).length;
    if (next !== size) out.push(candidate);
    size = next;
  }
  return out;
}

describe("the GUI stylesheet build", () => {
  it("builds every compiled-in GUI under a content-hashed name, the same on every build", async () => {
    const first = await buildStylesheets(REPO_ROOT);
    const second = await buildStylesheets(REPO_ROOT);
    expect(first.map((b: { name: string }) => b.name)).toEqual(Object.keys(GUI_META).sort());
    for (const built of first) expect(built.file).toMatch(new RegExp(`^${built.name}\\.[0-9a-f]{12}\\.css$`));
    expect(second).toEqual(first);
  });

  it("uses the unhashed name in development", async () => {
    const built = await buildStylesheets(REPO_ROOT, { dev: true });
    expect(built.map((b: { file: string }) => b.file)).toContain("gridtop.css");
  });

  it("gives Gridtop the tokens and its own utilities only, within its budget", async () => {
    const css = await compileStylesheet(path.join(REPO_ROOT, "src/gui/gridtop/styles.css"));
    expect(css).toContain("--surface-1:");
    expect(css).toContain("--brand-hue:");
    // No preflight, and nothing the (gui) layout under src/app uses.
    expect(css).not.toContain("box-sizing:border-box");
    expect(css).not.toContain("md\\:w-64");
    expect(gzipSync(css, { level: 9 }).length).toBeLessThan(20 * 1024);
  });

  it("names each file by its content's hash", async () => {
    const root = fixtureRoot({ demo: demoPackage('export const View = () => <div className="bg-card" />;\n') });
    const [before] = await buildStylesheets(root);
    writeFileSync(path.join(root, "src/gui/demo/view.tsx"), 'export const View = () => <div className="bg-muted" />;\n');
    const [after] = await buildStylesheets(root);
    expect(after.file).not.toBe(before.file);
    for (const built of [before, after]) {
      const hash = createHash("sha256").update(built.css).digest("hex").slice(0, 12);
      expect(built.file).toBe(`demo.${hash}.css`);
    }
  });

  it("compiles a package's own classes into Tailwind's layers, with its breakpoints and theme attribute", async () => {
    const root = fixtureRoot({
      demo: demoPackage('export const View = () => <div className="bg-card dark:bg-card medium:flex" />;\n'),
    });
    const [built] = await buildStylesheets(root);
    const css: string = built.css;
    // The whole layer order comes first, whichever stylesheet loads first.
    expect(css).toMatch(/^\/\*![^]*?\*\/\s*@layer theme,base,components[,;]/);
    const utilities = layerBlock(css, "utilities");
    expect(utilities).toContain(".bg-card{background-color:var(--card)}");
    expect(utilities).toMatch(/@media \(min-width:37\.5rem\)\{\.medium\\:flex\{display:flex\}\}/);
    // dark: follows data-theme, as in globals.css, not the system setting.
    expect(utilities).toMatch(/\.dark\\:bg-card:where\(\[data-theme=dark\]/);
    expect(css).not.toContain("prefers-color-scheme");
  });

  it.each(['@import "tailwindcss";\n', '@import "tailwindcss" source("../../");\n'])(
    "refuses a stylesheet that scans more than its own sources: %s",
    async (styles) => {
      const root = fixtureRoot({ demo: { "meta.ts": meta('name: "demo", styles: "./styles.css"'), "styles.css": styles } });
      await expect(buildStylesheets(root)).rejects.toThrow(/source\(none\)/);
    },
  );

  it.each([
    ["Demo_X", meta('name: "Demo_X", styles: "./styles.css"'), /"Demo_X" is not a GUI name/],
    ["a", meta('name: "a", styles: "./styles.css"'), /"a" is not a GUI name/],
  ])("refuses a package named %s", (dir, text, error) => {
    const root = fixtureRoot({ [dir]: { "meta.ts": text } });
    expect(() => findGuis(root)).toThrow(error);
  });

  it.each([
    ["names no stylesheet", meta('name: "demo"'), /demo\/meta\.ts: names no stylesheet/],
    ["names a stylesheet outside its package", meta('name: "demo", styles: "../x.css"'), /inside the package/],
    ["names a stylesheet in a sibling package", meta('name: "demo", styles: "../demo2/x.css"'), /inside the package/],
    ["names a file that is not a stylesheet", meta('name: "demo", styles: "./styles.ts"'), /inside the package/],
    ["has another package's name", meta('name: "other", styles: "./styles.css"'), /name must be "demo"/],
  ])("refuses a GUI that %s", (_case, text, error) => {
    const root = fixtureRoot({ demo: { "meta.ts": text } });
    expect(() => findGuis(root)).toThrow(error);
  });

  it("skips a directory without meta.ts", () => {
    const root = fixtureRoot({
      __tests__: { "x.test.ts": "" },
      demo: { "meta.ts": meta('name: "demo", styles: "./styles.css"') },
    });
    expect(findGuis(root).map((g: { name: string }) => g.name)).toEqual(["demo"]);
  });

  it("replaces the published files and writes the manifest", () => {
    const root = fixtureRoot({});
    mkdirSync(path.join(root, OUT_DIR), { recursive: true });
    writeFileSync(path.join(root, OUT_DIR, "gridtop.000000000000.css"), "old");
    const manifest = writeStylesheets(root, [{ name: "gridtop", file: "gridtop.3f9a1c2e4b5d.css", css: "a{}" }]);
    expect(manifest).toEqual({ gridtop: "/gui-styles/gridtop.3f9a1c2e4b5d.css" });
    expect(JSON.parse(readFileSync(path.join(root, MANIFEST), "utf8"))).toEqual(manifest);
    expect(readdirSync(path.join(root, OUT_DIR))).toEqual(["gridtop.3f9a1c2e4b5d.css"]);
  });
});

describe("the root stylesheet", () => {
  it("leaves src/gui to the GUI stylesheets", async () => {
    const compiler = await compile(readFileSync(GLOBALS, "utf8"), {
      base: path.dirname(GLOBALS),
      from: GLOBALS,
      onDependency() {},
    });
    const excluded = compiler.sources
      .filter((s) => s.negated)
      .map((s) => path.relative(REPO_ROOT, path.resolve(s.base, s.pattern)));
    expect(excluded).toContain("src/gui");
  });

  // Both stylesheets put utilities in the same `utilities` layer, where the
  // later stylesheet wins between equal selectors. A utility emitted by both
  // would override the other stylesheet's responsive variants on the same
  // element, so each utility comes from one stylesheet only.
  it.each(findGuis(REPO_ROOT).map((g: { name: string; styles: string }) => [g.name, g.styles]))(
    "shares no utility with %s's stylesheet",
    async (_name, styles) => {
      const globals = await compile(readFileSync(GLOBALS, "utf8"), {
        base: path.dirname(GLOBALS),
        from: GLOBALS,
        onDependency() {},
      });
      // As @tailwindcss/postcss scans for globals.css: the project, then its own @source rules.
      const globalCandidates = new Set(
        new Scanner({ sources: [{ base: REPO_ROOT, pattern: "**/*", negated: false }, ...globals.sources] }).scan(),
      );
      const gui = await scanStylesheet(styles);
      const both = gui.candidates.filter((c: string) => globalCandidates.has(c));
      const shared = generated(gui.compiler, generated(globals, both));
      expect(shared).toEqual([]);
    },
  );

  it.each([GLOBALS, ...findGuis(REPO_ROOT).map((g: { styles: string }) => g.styles)])(
    "%s imports the host's tokens",
    (file) => {
      const imports = [...readFileSync(file, "utf8").matchAll(/@import\s+"([^"]+)"/g)].map((m) =>
        path.resolve(path.dirname(file), m[1]),
      );
      expect(imports).toContain(TOKENS);
    },
  );
});
