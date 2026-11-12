/**
 * The GUI stylesheet build (scripts/gui/build-stylesheets.mjs): each
 * compiled-in GUI's stylesheet is built on its own sources into a
 * content-hashed file, and globals.css leaves those sources to it. Both
 * import the host's tokens, so the two stylesheets agree on every value.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// Fixture packages live under node_modules/.cache, inside the repository
// and ignored by git.
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
    // The shell's own classes, behind its gt variant and medium breakpoint (styles.css).
    expect(css).toContain(".gt\\:min-w-0{");
    expect(css).toContain(".gt\\:overflow-y-auto{");
    expect(css).toMatch(/@media \(min-width:37\.5rem\)\{[^@]*\.gt\\:medium\\:p-6\{/);
    expect(css).toContain(".gt\\:pb-\\[env\\(safe-area-inset-bottom\\)\\]{padding-bottom:env(safe-area-inset-bottom)}");
    // The status bar: expanded (1280 px wide) and tall (800 px high).
    expect(css).toContain("@media (min-width:80rem){@media (min-height:50rem){.gt\\:expanded\\:tall\\:flex{display:flex}}}");
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

// Each of these fixtures puts files outside the package, at the fixture's
// root, holding a candidate-shaped token that names where it came from. A
// stylesheet that reached them would publish that token in its CSS.
const OUTSIDE = {
  ".env.local": "SECRET=content-['leak-env']\n",
  "secret/notes.txt": "<p className=\"content-['leak-notes']\" />\n",
  "outside.css": ".leak{content:'leak-css'}\n",
};

/** A fixture with Gridtop's stylesheet plus `extra` in a package named demo, and files outside it. */
function escapingFixture(extra: string, files: Record<string, string> = {}): { root: string; pkg: string } {
  const demo = demoPackage('export const View = () => <div className="bg-card" />;\n');
  const root = fixtureRoot({ demo: { ...demo, "styles.css": `${demo["styles.css"]}\n${extra}\n`, ...files } });
  for (const [name, text] of Object.entries(OUTSIDE)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  return { root, pkg: path.join(root, "src/gui/demo") };
}

/** The refusal, checked to name the stylesheet and the directive and to quote no outside file. */
async function refusal(root: string, directive: string): Promise<string> {
  const error: Error = await buildStylesheets(root).then(
    () => {
      throw new Error("the build did not refuse");
    },
    (e: Error) => e,
  );
  expect(error.message).toContain("src/gui/demo/styles.css: ");
  expect(error.message).toContain(directive);
  expect(error.message).not.toMatch(/leak-|SECRET/);
  return error.message;
}

describe("what a GUI stylesheet may read", () => {
  it("would publish an outside file's tokens if the scanner were given it", () => {
    // Without this, the refusals below could pass on a fixture nothing reads.
    const { pkg } = escapingFixture("");
    const scan = (pattern: string) => new Scanner({ sources: [{ base: pkg, pattern, negated: false }] }).scan();
    expect(scan("../../../")).toContain("content-['leak-notes']");
    expect(scan("../../../.env.local").some((candidate) => candidate.includes("leak-env"))).toBe(true);
  });

  it.each([
    ['@source "../../../";'],
    ['@source "../../../.env.local";'],
    ['@source "../../../secret/notes.txt";'],
    ['@source not "../../../";'],
    ['@source "../**/*";'],
    ['@source "../../../secret/*.txt";'],
    ['@source "**/../../../../secret/*";'],
    ['@source "{..,x}/{..,x}/{..,x}/secret/*";'],
    // Expanded, "{.,x}{.,x}" includes "..", and "{.,}." includes "..".
    ['@source "{.,x}{.,x}/{.,x}{.,x}/{.,x}{.,x}/secret/*";'],
    ['@source not "{.,x}{.,x}/{.,x}{.,x}/{.,x}{.,x}/secret/*";'],
    ['@source "{.,}./{.,}./{.,}./secret/*";'],
    ['@source "./*.{tsx,}";'],
    ['@source "./{a,{b,c}}/*";'],
    // A sibling package whose name starts with this one's.
    ['@source "../demo2";'],
  ])("refuses %s", async (directive) => {
    const { root } = escapingFixture(directive);
    expect(await refusal(root, directive.slice(0, -1))).toMatch(/scans files inside its own package only/);
  });

  it("refuses an @source of a sibling package whose name starts with the package's", async () => {
    const { root } = escapingFixture('@source "../demo2/";');
    mkdirSync(path.join(root, "src/gui/demo2"), { recursive: true });
    writeFileSync(path.join(root, "src/gui/demo2/x.txt"), "content-['leak-sibling']\n");
    await refusal(root, '@source "../demo2/"');
  });

  it("accepts an @source whose braces list plain names", async () => {
    const { root } = escapingFixture('@source "./*.{tsx,ts}";');
    const [built] = await buildStylesheets(root);
    expect(built.css).toContain(".bg-card{");
  });

  it("refuses an absolute @source outside the package", async () => {
    const { root } = escapingFixture("");
    const directive = `@source "${path.join(root, "secret")}"`;
    writeFileSync(
      path.join(root, "src/gui/demo/styles.css"),
      `${readFileSync(path.join(root, "src/gui/demo/styles.css"), "utf8")}\n${directive};\n`,
    );
    await refusal(root, directive);
  });

  it("refuses an @source through a link inside the package to a directory outside it", async () => {
    const { root, pkg } = escapingFixture('@source "./link";');
    symlinkSync(path.join(root, "secret"), path.join(pkg, "link"));
    await refusal(root, '@source "./link"');
  });

  it("refuses an @source through a link inside the package to a file outside it", async () => {
    const { root, pkg } = escapingFixture('@source "./notes.txt";');
    symlinkSync(path.join(root, "secret/notes.txt"), path.join(pkg, "notes.txt"));
    await refusal(root, '@source "./notes.txt"');
  });

  it("refuses an @source of a path that does not exist yet, under a link inside the package", async () => {
    // The link resolves outside although "later" does not exist there.
    const { root, pkg } = escapingFixture('@source "./link/later";');
    symlinkSync(path.join(root, "secret"), path.join(pkg, "link"));
    await refusal(root, '@source "./link/later"');
  });

  it("refuses the package's own @source when a link inside it leads outside", async () => {
    // @source "./" passes the pattern check; the scanner then follows the link.
    const { root, pkg } = escapingFixture("");
    symlinkSync(path.join(root, "secret"), path.join(pkg, "link"));
    const message = await refusal(root, "@source reaches ");
    expect(message).toContain("src/gui/demo/link/notes.txt, outside the package");
  });

  it("refuses a stylesheet that is a link to a file outside the package", () => {
    const { root, pkg } = escapingFixture("");
    rmSync(path.join(pkg, "styles.css"));
    symlinkSync(path.join(root, "outside.css"), path.join(pkg, "styles.css"));
    expect(() => findGuis(root)).toThrow(/styles must name a \.css file inside the package/);
  });

  it.each([
    ['@import "../../../outside.css";', '@import or @reference "../../../outside.css"'],
    ['@reference "../../../outside.css";', '@import or @reference "../../../outside.css"'],
    ['@import "./parts.css";', '@import or @reference "./parts.css"'],
    // Only the host's tokens.css, not another file of that name.
    ['@import "./tokens.css";', '@import or @reference "./tokens.css"'],
    ['@import "tw-animate-css";', '@import or @reference "tw-animate-css"'],
    ['@import "tailwindcss/package.json";', '@import or @reference "tailwindcss/package.json"'],
    ['@import "tailwindcss/../../outside.css";', '@import or @reference "tailwindcss/../../outside.css"'],
  ])("refuses %s", async (line, directive) => {
    const { root } = escapingFixture(line, { "parts.css": ".part{color:red}\n", "tokens.css": ".tok{color:red}\n" });
    expect(await refusal(root, directive)).toMatch(/imports only tailwindcss's stylesheets and src\/styles\/tokens\.css/);
  });

  // tailwindcss passes these through unread; the browser would fetch them.
  it.each([
    ['@import "https://example.com/x.css";', '@import "https://example.com/x.css"'],
    ["@import url(https://example.com/y.css);", '@import "https://example.com/y.css"'],
    ['@import "data:text/css,.x%7Bcolor:red%7D";', '@import "data:text/css,.x%7Bcolor:red%7D"'],
    ['@media screen { @import "https://example.com/z.css"; }', "@import inside another rule"],
  ])("refuses %s left in the compiled CSS", async (line, directive) => {
    // First in the stylesheet, where an @import is valid CSS.
    const { root, pkg } = escapingFixture("");
    const styles = path.join(pkg, "styles.css");
    writeFileSync(styles, `${line}\n${readFileSync(styles, "utf8")}`);
    expect(await refusal(root, directive)).toMatch(/imports only tailwindcss's stylesheets and src\/styles\/tokens\.css/);
  });

  it("refuses an @import left after other rules", async () => {
    const { root } = escapingFixture('@import "https://example.com/x.css";');
    expect(await refusal(root, "compiled CSS that cannot be checked for @import")).toMatch(/must precede/);
  });

  it("refuses an @import through a link inside the package to a stylesheet outside it", async () => {
    const { root, pkg } = escapingFixture('@import "./linked.css";');
    symlinkSync(path.join(root, "outside.css"), path.join(pkg, "linked.css"));
    await refusal(root, '@import or @reference "./linked.css"');
  });

  it.each([
    ["plugin", '@plugin "./run.mjs";'],
    ["config", '@config "./run.mjs";'],
  ])("refuses @%s without running it", async (kind, line) => {
    const { root, pkg } = escapingFixture(line, {
      "run.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./ran", import.meta.url), "");\nexport default {};\n`,
    });
    expect(await refusal(root, `@${kind} "./run.mjs"`)).toMatch(/loads no JavaScript/);
    expect(existsSync(path.join(pkg, "ran"))).toBe(false);
  });

  it("keeps the package as the boundary when the stylesheet sits in a subdirectory", async () => {
    const demo = demoPackage('export const View = () => <div className="bg-card" />;\n');
    const css = `${demo["styles.css"]}\n@source "../";\n`;
    const files = { ...demo, "meta.ts": meta('name: "demo", styles: "./css/styles.css"'), "css/styles.css": css };
    delete (files as Record<string, string>)["styles.css"];
    const root = fixtureRoot({ demo: files });
    const [built] = await buildStylesheets(root);
    expect(built.css).toContain(".bg-card{");
    writeFileSync(path.join(root, "src/gui/demo/css/styles.css"), `${css}@source "../../";\n`);
    await expect(buildStylesheets(root)).rejects.toThrow('src/gui/demo/css/styles.css: @source "../../" is refused');
  });

  it("checks the tailwindcss version the loaders were written for", () => {
    // loaders() in the build script lists the ways tailwindcss's compile()
    // reads a file, as of 4.2. On an upgrade, check that list, then this.
    const version = createRequire(__filename)("tailwindcss/package.json").version;
    expect(version).toMatch(/^4\.2\./);
  });

  it("accepts Gridtop's stylesheet, tailwindcss's stylesheets and an inline source", async () => {
    const { root } = escapingFixture('@import "tailwindcss/preflight.css" layer(base);\n@source inline("underline");');
    const [built] = await buildStylesheets(root);
    expect(built.css).toContain(".bg-card{");
    expect(built.css).toContain(".underline{");
    expect(built.css).not.toMatch(/leak-/);
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
