// Builds each compiled-in GUI's stylesheet.
//   node scripts/gui/build-stylesheets.mjs [--dev] [--watch]
//
// A GUI is a directory src/gui/<name>/ with a meta.ts whose object literal
// names the package (`name`) and its stylesheet source (`styles`). Each
// source is compiled with Tailwind over the files it declares with @source,
// then minified. A stylesheet reads files inside its own package only: its
// @source entries and the files they scan stay inside the package, it
// imports only Tailwind's own stylesheets and src/styles/tokens.css, and it
// may not load JavaScript with @plugin or @config; its output carries no
// @import of its own. The output goes to
// public/gui-styles/<name>.<sha256-12>.css (--dev: <name>.css), and
// src/gui/.generated/stylesheets.json maps each name to its URL. The same
// sources give the same bytes and so the same names. No network.
//
// npm run build and npm run dev run this first; next.config.ts reads the
// manifest. --watch rebuilds on changes under src/gui and src/styles.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { compile } from "tailwindcss";
import ts from "typescript";

export const OUT_DIR = "public/gui-styles";
export const MANIFEST = "src/gui/.generated/stylesheets.json";
const NAME = /^[a-z][a-z0-9-]{1,30}$/;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const TAILWIND_PACKAGE = require.resolve("tailwindcss/package.json");
// The same lightningcss that @tailwindcss/node's optimize() minifies with.
const { transform } = createRequire(require.resolve("@tailwindcss/node"))("lightningcss");
// The stylesheets a GUI stylesheet may import, by real path: the .css files
// of the installed tailwindcss package, and the host's tokens.
const TAILWIND_DIR = realpathSync(dirname(TAILWIND_PACKAGE));
const TOKENS = realpathSync(join(REPO_ROOT, "src/styles/tokens.css"));
// A path segment containing any of these is where a glob starts. The set is
// wider than the glob syntax Tailwind's scanner accepts, so no glob segment
// is mistaken for a directory name.
const GLOB_SEGMENT = /[*?[\]{}()!\\]/;
// The one brace form a @source pattern may use: a list of plain names, as in
// "*.{ts,tsx}". Every alternative is non-empty and has no "." or "/", so
// expanding it can neither form ".." nor add a path segment.
const BRACE_GROUP = /\{([^{}]*)\}/g;
const BRACE_NAMES = /^[\w-]+(?:,[\w-]+)*$/;

/** `name` and `styles` from the object literal in a meta.ts, or throws. */
export function readMeta(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const found = {};
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && ts.isStringLiteral(prop.initializer)) {
          found[prop.name.text] ??= prop.initializer.text;
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The GUI packages under src/gui, sorted, each with its stylesheet path. */
export function findGuis(root) {
  const guiDir = join(root, "src/gui");
  const guis = [];
  for (const entry of readdirSync(guiDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const dir = join(guiDir, entry.name);
    let meta;
    try {
      meta = readMeta(join(dir, "meta.ts"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const where = `src/gui/${entry.name}/meta.ts`;
    if (meta.name !== entry.name) throw new Error(`${where}: name must be "${entry.name}", the directory's name`);
    if (!NAME.test(meta.name)) throw new Error(`${where}: "${meta.name}" is not a GUI name`);
    if (typeof meta.styles !== "string") throw new Error(`${where}: names no stylesheet (styles)`);
    const styles = resolve(dir, meta.styles);
    // By real path too, so a stylesheet that is a link to a file elsewhere is refused.
    if (!styles.startsWith(dir + sep) || !styles.endsWith(".css") || !isWithin(realPath(styles), realPath(dir))) {
      throw new Error(`${where}: styles must name a .css file inside the package`);
    }
    guis.push({ name: meta.name, dir, styles });
  }
  return guis;
}

/** A path relative to the repository when it is inside it, for messages. */
function shown(path) {
  const rel = relative(REPO_ROOT, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** Whether `path` is `dir` or inside it, by whole path segments. */
function isWithin(path, dir) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * The real path of `path` with every symbolic link resolved. When `path`
 * does not exist, its nearest existing ancestor is resolved and the rest
 * appended, so a link anywhere above it still counts.
 */
function realPath(path) {
  const rest = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...rest);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...rest);
    rest.unshift(basename(current));
    current = parent;
  }
}

/** The file a bare `tailwindcss` import names, from the package's style exports. */
function tailwindExport(id) {
  const subpath = id === "tailwindcss" ? "." : `./${id.slice("tailwindcss/".length)}`;
  const target = JSON.parse(readFileSync(TAILWIND_PACKAGE, "utf8")).exports?.[subpath];
  const file = typeof target === "string" ? target : target?.style;
  return typeof file === "string" ? join(dirname(TAILWIND_PACKAGE), file) : null;
}

/**
 * Tailwind's loaders for one stylesheet. tailwindcss's compile() reads no
 * file itself: every @import and @reference goes through loadStylesheet,
 * and every @plugin and @config through loadModule (tailwindcss 4.2). If a
 * later version reads files another way, this list of hooks must grow with
 * it. These loaders replace the ones @tailwindcss/node supplies, so neither
 * its resolvers nor its globalThis.__tw_resolve hook can answer instead.
 */
function loaders(file) {
  return {
    async loadStylesheet(id, base) {
      // Tailwind passes @import and @reference here alike, without saying which.
      const directive = `@import or @reference "${id}"`;
      let target = null;
      if (id === "tailwindcss" || id.startsWith("tailwindcss/")) target = tailwindExport(id);
      else if (id.startsWith(".") || isAbsolute(id)) target = resolve(base, id);
      const real = target === null ? null : realPath(target);
      const allowed =
        real !== null && ((isWithin(real, TAILWIND_DIR) && real.endsWith(".css")) || real === TOKENS);
      if (!allowed) {
        throw new Error(
          `${shown(file)}: ${directive} is refused; a GUI stylesheet imports only tailwindcss's stylesheets and src/styles/tokens.css`,
        );
      }
      return { path: real, base: dirname(real), content: readFileSync(real, "utf8") };
    },
    async loadModule(id, _base, kind) {
      throw new Error(`${shown(file)}: @${kind} "${id}" is refused; a GUI stylesheet loads no JavaScript`);
    },
  };
}

/**
 * Refuses any @source entry, negated or not, that reaches outside the
 * package. The part of the pattern before its first glob segment is
 * resolved, links included, and must lie inside the package; the glob part
 * may not climb with "..". The scanner expands braces before it resolves a
 * pattern, and "{.,x}{.,x}" expands to "..", so braces are refused except
 * as a list of plain names (BRACE_NAMES).
 *
 * @source inline(...) entries are not in this list and need no check: their
 * candidates are the literal text of the stylesheet, which is itself one of
 * the files this build allows, and Tailwind reads no file for them.
 */
function checkSources(file, sources, packageDir) {
  for (const source of sources) {
    const directive = `@source ${source.negated ? "not " : ""}"${source.pattern}"`;
    const segments = source.pattern.split("/");
    const globAt = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
    const prefix = globAt < 0 ? source.pattern : segments.slice(0, globAt).join("/");
    const glob = globAt < 0 ? "" : segments.slice(globAt).join("/");
    if (
      !bracesArePlainNames(source.pattern) ||
      !isWithin(realPath(resolve(source.base, prefix)), packageDir) ||
      glob.includes("..")
    ) {
      throw new Error(`${shown(file)}: ${directive} is refused; a GUI stylesheet scans files inside its own package only`);
    }
  }
}

/** Whether every brace in `pattern` is part of a group that lists plain names. */
function bracesArePlainNames(pattern) {
  for (const [, inside] of pattern.matchAll(BRACE_GROUP)) if (!BRACE_NAMES.test(inside)) return false;
  return !/[{}]/.test(pattern.replace(BRACE_GROUP, ""));
}

/**
 * Refuses compiled CSS that still holds an @import. loadStylesheet inlines
 * every import it allows, so one left over is an import tailwindcss passed
 * through without reading it, such as a URL, url(...) or data: import
 * (tailwindcss 4.2). The browser would fetch it.
 * This runs on tailwindcss's output before minifying, which drops an
 * @import that follows other rules; one there is refused too. The CSS is
 * parsed, not searched, so "@import" inside a string is no match, and CSS
 * that cannot be parsed strictly is refused as well.
 */
function checkNoImports(file, css) {
  const refuse = (what) => {
    throw new Error(
      `${shown(file)}: ${what} is refused; a GUI stylesheet imports only tailwindcss's stylesheets and src/styles/tokens.css`,
    );
  };
  try {
    transform({
      filename: file,
      code: Buffer.from(css),
      errorRecovery: false,
      visitor: {
        Rule: {
          import: (rule) => refuse(`@import "${rule.value.url}"`),
          unknown: (rule) => {
            if (rule.name.toLowerCase() === "import") refuse("@import inside another rule");
          },
        },
      },
    });
  } catch (error) {
    if (error.message.startsWith(`${shown(file)}: `)) throw error;
    refuse(`compiled CSS that cannot be checked for @import (${error.message})`);
  }
}

/**
 * A stylesheet's compiler and the candidates its own @source list yields.
 * `packageDir` is the GUI package the stylesheet belongs to; every file it
 * reads must be inside it, apart from the imports loaders() allows.
 */
export async function scanStylesheet(file, packageDir = dirname(file)) {
  const packageReal = realPath(packageDir);
  const compiler = await compile(readFileSync(file, "utf8"), { base: dirname(file), from: file, ...loaders(file) });
  if (compiler.root !== "none") {
    throw new Error(`${file}: import tailwindcss with source(none) and list the package's sources with @source`);
  }
  checkSources(file, compiler.sources, packageReal);
  const scanner = new Scanner({ sources: compiler.sources });
  const candidates = scanner.scan();
  // The scanner follows symbolic links while it walks a directory, so a
  // link inside the package can lead it outside: each scanned file's real
  // path decides. The candidates are discarded when one is outside.
  const outside = scanner.files.find((scanned) => !isWithin(realPath(scanned), packageReal));
  if (outside !== undefined) {
    throw new Error(
      `${shown(file)}: @source reaches ${shown(outside)}, outside the package; a GUI stylesheet scans files inside its own package only`,
    );
  }
  return { compiler, candidates };
}

/** Compiles one stylesheet: its own @source list, no automatic detection. */
export async function compileStylesheet(file, packageDir = dirname(file)) {
  const { compiler, candidates } = await scanStylesheet(file, packageDir);
  const css = compiler.build(candidates);
  checkNoImports(file, css);
  return optimize(css, { file, minify: true }).code;
}

/** Every GUI's stylesheet, compiled, with its published file name. */
export async function buildStylesheets(root, { dev = false } = {}) {
  const built = [];
  for (const gui of findGuis(root)) {
    const css = await compileStylesheet(gui.styles, gui.dir);
    const hash = createHash("sha256").update(css).digest("hex").slice(0, 12);
    built.push({ name: gui.name, file: dev ? `${gui.name}.css` : `${gui.name}.${hash}.css`, css });
  }
  return built;
}

/** Replaces the published stylesheets and the manifest. Returns the manifest. */
export function writeStylesheets(root, built) {
  const out = join(root, OUT_DIR);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = {};
  for (const { name, file, css } of built) {
    writeFileSync(join(out, file), css);
    manifest[name] = `/gui-styles/${file}`;
  }
  const manifestFile = join(root, MANIFEST);
  mkdirSync(dirname(manifestFile), { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function run(root, dev) {
  const manifest = writeStylesheets(root, await buildStylesheets(root, { dev }));
  for (const [name, url] of Object.entries(manifest)) console.log(`gui-styles: ${name} -> public${url}`);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const dev = process.argv.includes("--dev");
  await run(root, dev);
  if (!process.argv.includes("--watch")) return;
  let timer;
  const rebuild = (_event, name) => {
    if (String(name ?? "").startsWith(".generated")) return;
    clearTimeout(timer);
    timer = setTimeout(() => run(root, dev).catch((error) => console.error(`gui-styles: ${error.message}`)), 100);
  };
  for (const dir of ["src/gui", "src/styles"]) watch(join(root, dir), { recursive: true }, rebuild);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`gui-styles: ${error.message}`);
    process.exitCode = 1;
  });
}
