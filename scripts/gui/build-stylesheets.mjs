// Builds each compiled-in GUI's stylesheet.
//   node scripts/gui/build-stylesheets.mjs [--dev] [--watch]
//
// A GUI is a directory src/gui/<name>/ with a meta.ts whose object literal
// names the package (`name`) and its stylesheet source (`styles`). Each
// source is compiled with Tailwind's Node API over the files it declares
// with @source, then minified. The output goes to
// public/gui-styles/<name>.<sha256-12>.css (--dev: <name>.css), and
// src/gui/.generated/stylesheets.json maps each name to its URL. The same
// sources give the same bytes and so the same names. No network.
//
// npm run build and npm run dev run this first; next.config.ts reads the
// manifest. --watch rebuilds on changes under src/gui and src/styles.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import ts from "typescript";

export const OUT_DIR = "public/gui-styles";
export const MANIFEST = "src/gui/.generated/stylesheets.json";
const NAME = /^[a-z][a-z0-9-]{1,30}$/;

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
    if (!styles.startsWith(dir + sep) || !styles.endsWith(".css")) {
      throw new Error(`${where}: styles must name a .css file inside the package`);
    }
    guis.push({ name: meta.name, styles });
  }
  return guis;
}

/** A stylesheet's compiler and the candidates its own @source list yields. */
export async function scanStylesheet(file) {
  const base = dirname(file);
  const compiler = await compile(readFileSync(file, "utf8"), { base, from: file, onDependency() {} });
  if (compiler.root !== "none") {
    throw new Error(`${file}: import tailwindcss with source(none) and list the package's sources with @source`);
  }
  return { compiler, candidates: new Scanner({ sources: compiler.sources }).scan() };
}

/** Compiles one stylesheet: its own @source list, no automatic detection. */
export async function compileStylesheet(file) {
  const { compiler, candidates } = await scanStylesheet(file);
  return optimize(compiler.build(candidates), { file, minify: true }).code;
}

/** Every GUI's stylesheet, compiled, with its published file name. */
export async function buildStylesheets(root, { dev = false } = {}) {
  const built = [];
  for (const gui of findGuis(root)) {
    const css = await compileStylesheet(gui.styles);
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
