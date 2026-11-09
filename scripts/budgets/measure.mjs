// First-load byte budgets: pure functions over a production `.next` directory.
// No network and no eval. Every size is gzip -9 of the file's bytes.
//
// The files read here are Next.js build internals, not public API:
// build-manifest.json `rootMainFiles`, each page_client-reference-manifest.js
// (`entryJSFiles`, `entryCSSFiles`) and server/next-font-manifest.json. They
// were checked against Next.js 16; if a Next upgrade changes them, the
// functions below throw naming what they looked for, and this file changes
// with that upgrade.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

/** @typedef {{ path: string, bytes: number }} FileSize */
/** @typedef {{ bytes: number, files: FileSize[] }} Sized */
/** @typedef {{ family: string, display: string | null, url: string | null, unicodeRange: string | null }} FontFace */

const CLIENT_MANIFEST = "page_client-reference-manifest.js";
const ROOT_LAYOUT = "[project]/src/app/layout";
const MANIFEST_PREFIX =
  "globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST[";

export function gzipBytes(buf) {
  return gzipSync(buf, { level: 9 }).length;
}

function readJson(file, what) {
  if (!existsSync(file)) throw new Error(`Byte budgets: ${what} not found at ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Sizes each distinct file once, largest first. */
function sized(nextDir, paths) {
  const files = [...new Set(paths)].map((path) => {
    const file = join(nextDir, path);
    if (!existsSync(file)) throw new Error(`Byte budgets: ${path} is listed in a manifest but missing from ${nextDir}`);
    return { path, bytes: gzipBytes(readFileSync(file)) };
  });
  files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { bytes: files.reduce((n, f) => n + f.bytes, 0), files };
}

/**
 * Parses a page_client-reference-manifest.js without evaluating it: the text
 * must be exactly the assignment Next writes, followed by one JSON object.
 */
export function readClientManifest(file) {
  const text = readFileSync(file, "utf8");
  const fail = (why) => {
    throw new Error(`Byte budgets: ${file} is not a client reference manifest in the expected format (${why})`);
  };
  if (!text.startsWith(MANIFEST_PREFIX)) fail(`expected it to start with ${JSON.stringify(MANIFEST_PREFIX)}`);
  const rest = text.slice(MANIFEST_PREFIX.length);
  const key = /^"(?:[^"\\\n]|\\.)*"\] = /.exec(rest);
  if (!key) fail("expected a quoted key followed by `] = `");
  const body = rest.slice(key[0].length).replace(/;\s*$/, "");
  try {
    return JSON.parse(body);
  } catch {
    return fail("the assigned value is not JSON");
  }
}

function findManifests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findManifests(full));
    else if (entry.name === CLIENT_MANIFEST) out.push(full);
  }
  return out.sort();
}

function entry(manifest, field, key, file) {
  const map = manifest[field];
  if (!map || typeof map !== "object") throw new Error(`Byte budgets: ${file} has no ${field}`);
  const list = map[key];
  if (!Array.isArray(list)) throw new Error(`Byte budgets: ${file} has no ${field}["${key}"]`);
  return list;
}

function cssPath(item, file) {
  if (typeof item === "string") return item;
  if (item && typeof item.path === "string") return item.path;
  throw new Error(`Byte budgets: ${file} has an entryCSSFiles item with no path`);
}

/** Every @font-face block in a stylesheet. */
export function fontFaces(cssText) {
  const faces = [];
  for (const [, body] of cssText.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const prop = (name) => {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(body);
      return m ? m[1].trim() : null;
    };
    const url = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(body);
    faces.push({
      family: (prop("font-family") ?? "").replace(/^['"]|['"]$/g, ""),
      display: prop("font-display"),
      url: url ? url[2] : null,
      unicodeRange: prop("unicode-range"),
    });
  }
  return faces;
}

/** True when a unicode-range starts with U+00-FF, in any of its spellings (U+??, U+0-FF, U+0000-00FF). */
function isBasicLatin(range) {
  const first = (range ?? "").split(",")[0].trim().toUpperCase();
  return first === "U+??" || first === "U+00??" || /^U\+0+-0*FF$/.test(first);
}

function fontFile(nextDir, cssFile, url) {
  if (url.startsWith("/_next/")) return url.slice("/_next/".length);
  return relative(nextDir, join(nextDir, dirname(cssFile), url)).split(sep).join("/");
}

/**
 * @param {string} nextDir
 * @param {{ shellLayout: string }} options  e.g. "src/app/(dashboard)/layout"
 */
export function measure(nextDir, { shellLayout }) {
  const build = readJson(join(nextDir, "build-manifest.json"), "build-manifest.json");
  if (!Array.isArray(build.rootMainFiles) || build.rootMainFiles.length === 0) {
    throw new Error("Byte budgets: build-manifest.json has no rootMainFiles");
  }
  const framework = sized(nextDir, build.rootMainFiles);
  const frameworkSet = new Set(build.rootMainFiles);

  const folder = /^src\/app\/(.+)\/layout$/.exec(shellLayout ?? "");
  if (!folder) throw new Error(`Byte budgets: shell.layout "${shellLayout}" is not of the form src/app/<folder>/layout`);
  const layoutDir = join(nextDir, "server", "app", folder[1]);
  if (!existsSync(layoutDir)) {
    throw new Error(`Byte budgets: shell.layout "${shellLayout}" has no folder ${layoutDir} in the build`);
  }
  const shellManifests = findManifests(layoutDir);
  if (shellManifests.length === 0) {
    throw new Error(`Byte budgets: shell.layout "${shellLayout}" has no ${CLIENT_MANIFEST} under ${layoutDir}`);
  }

  const shellKey = `[project]/${shellLayout}`;
  const shellJs = new Set();
  const cssFiles = new Set();
  for (const file of shellManifests) {
    const m = readClientManifest(file);
    for (const key of [ROOT_LAYOUT, shellKey]) {
      for (const js of entry(m, "entryJSFiles", key, file)) if (!frameworkSet.has(js)) shellJs.add(js);
      for (const css of entry(m, "entryCSSFiles", key, file)) cssFiles.add(cssPath(css, file));
    }
  }
  const shell = sized(nextDir, [...shellJs]);
  const css = sized(nextDir, [...cssFiles]);

  const faces = [];
  for (const cssFile of css.files) {
    for (const face of fontFaces(readFileSync(join(nextDir, cssFile.path), "utf8"))) {
      if (face.url) faces.push({ ...face, file: fontFile(nextDir, cssFile.path, face.url) });
    }
  }
  const latin = faces.find((f) => isBasicLatin(f.unicodeRange));
  if (faces.length > 0 && !latin) {
    const ranges = faces.map((f) => f.unicodeRange ?? "unset").join("; ");
    throw new Error(`Byte budgets: no first-load @font-face has a unicode-range starting U+00-FF (basic Latin); found ${ranges}`);
  }
  const fontManifest = readJson(join(nextDir, "server", "next-font-manifest.json"), "server/next-font-manifest.json");
  if (!fontManifest.app || typeof fontManifest.app !== "object") {
    throw new Error("Byte budgets: server/next-font-manifest.json has no app map");
  }
  const preloaded = new Set();
  for (const [name, group] of [["app", fontManifest.app], ["pages", fontManifest.pages ?? {}]]) {
    for (const [key, list] of Object.entries(group)) {
      if (!Array.isArray(list)) throw new Error(`Byte budgets: server/next-font-manifest.json ${name}["${key}"] is not a list`);
      for (const f of list) preloaded.add(f);
    }
  }
  const fonts = {
    faces,
    families: [...new Set(faces.map((f) => f.family))].sort(),
    preloaded: [...preloaded].sort(),
    basicLatin: latin ? sized(nextDir, [latin.file]) : { bytes: 0, files: [] },
  };

  const shared = new Set([...frameworkSet, ...shellJs]);
  const routes = [];
  for (const file of findManifests(join(nextDir, "server", "app"))) {
    const js = entryJSFilesOfPage(readClientManifest(file), file);
    const own = js.filter((p) => !shared.has(p));
    const route = "/" + relative(join(nextDir, "server", "app"), dirname(file)).split(sep).join("/");
    routes.push({ route, bytes: sized(nextDir, own).bytes });
  }
  routes.sort((a, b) => b.bytes - a.bytes || a.route.localeCompare(b.route));

  return { framework, shell, css, fonts, routes: routes.slice(0, 5) };
}

function entryJSFilesOfPage(manifest, file) {
  const map = manifest.entryJSFiles;
  if (!map || typeof map !== "object") throw new Error(`Byte budgets: ${file} has no entryJSFiles`);
  const pages = Object.keys(map).filter((k) => k.endsWith("/page"));
  const keys = pages.length > 0 ? pages : Object.keys(map);
  return [...new Set(keys.flatMap((k) => map[k]))];
}

const fileList = (sizedGroup) => sizedGroup.files.map((f) => `${f.path} ${f.bytes}`);

/** One row per budget; `ok` is false when the measurement exceeds the limit. */
export function compare(measurement, limits) {
  const { framework, shell, css, fonts } = measurement;
  const display = limits.fonts.display;
  const badDisplay = fonts.faces.filter((f) => f.display !== display);
  const rows = [
    { budget: "Framework floor", unit: "bytes", measured: framework.bytes, limit: limits.framework.maxBytes, files: fileList(framework) },
    { budget: `Shell JS above the framework (${limits.shell.layout})`, unit: "bytes", measured: shell.bytes, limit: limits.shell.maxBytesAboveFramework, files: fileList(shell) },
    { budget: "First-load stylesheet", unit: "bytes", measured: css.bytes, limit: limits.stylesheet.maxBytes, files: fileList(css) },
    { budget: "Font families with a downloaded file", unit: "count", measured: fonts.families.length, limit: limits.fonts.maxFamilies, files: fonts.families },
    { budget: `Font faces whose font-display is not ${display}`, unit: "count", measured: badDisplay.length, limit: 0, files: badDisplay.map((f) => `${f.family}: font-display ${f.display ?? "unset"} (${f.file})`) },
    { budget: "Preloaded fonts", unit: "count", measured: fonts.preloaded.length, limit: limits.fonts.maxPreloaded, files: fonts.preloaded },
    { budget: "Basic Latin font file", unit: "bytes", measured: fonts.basicLatin.bytes, limit: limits.fonts.maxBasicLatinBytes, files: fileList(fonts.basicLatin) },
  ].map((row) => ({ ...row, ok: row.measured <= row.limit }));
  return { ok: rows.every((r) => r.ok), rows };
}
