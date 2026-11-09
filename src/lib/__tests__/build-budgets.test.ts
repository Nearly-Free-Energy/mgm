import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compare, gzipBytes, measure, readClientManifest } from "../../../scripts/budgets/measure.mjs";

const SHELL = "src/app/(gui)/layout";
const LIMITS = {
  framework: { maxBytes: 1_000_000 },
  shell: { layout: SHELL, maxBytesAboveFramework: 1_000_000 },
  stylesheet: { maxBytes: 1_000_000 },
  fonts: { maxFamilies: 1, display: "optional", maxPreloaded: 0, maxBasicLatinBytes: 1_000_000 },
};

// Hashed names, as Next writes them, so the basic Latin file can only be found by unicode-range.
const LATIN = "static/media/9f1c2e-s.p.woff2";
const EXT = "static/media/a1b2c3-s.woff2";
const OTHER = "static/media/d4e5f6-s.woff2";
const MANIFEST = "server/app/(gui)/x/page_client-reference-manifest.js";
const face = (family: string, display: string | null, file: string, range: string) =>
  `@font-face{font-family:${family};font-style:normal;${display ? `font-display:${display};` : ""}src:url(../media/${file.split("/").pop()})format("woff2");unicode-range:${range}}`;
const FALLBACK = "@font-face{font-family:Inter Fallback;src:local(Arial);size-adjust:107.12%}";
const FACES = [
  face("Inter", "optional", EXT, "U+100-2BA,U+2BD-2C5"),
  face("Inter", "optional", LATIN, "U+??,U+131,U+152-153"),
  FALLBACK,
];

let next: string;
const sizes = new Map<string, number>();

function put(path: string, content: string | Buffer) {
  const file = join(next, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  sizes.set(path, gzipBytes(Buffer.from(content)));
}

/** Writes a client manifest in the format Next 16 emits, optionally without one entry key. */
function clientManifest(omit?: string) {
  const root = ["static/chunks/app.js"];
  const shell = [...root, "static/chunks/shell-a.js", "static/chunks/shared.js", "static/chunks/shell-b.js"];
  const js: Record<string, string[]> = {
    "[project]/src/app/layout": root,
    [`[project]/${SHELL}`]: shell,
    "[project]/src/app/(gui)/x/page": [...shell, "static/chunks/page.js"],
  };
  const css: Record<string, string[]> = {
    "[project]/src/app/layout": ["static/chunks/app.css"],
    [`[project]/${SHELL}`]: ["static/chunks/app.css", "static/chunks/shell.css"],
  };
  if (omit) delete js[omit];
  const entryCSSFiles = Object.fromEntries(
    Object.entries(css).map(([k, v]) => [k, v.map((p) => ({ path: p, inlined: false }))]),
  );
  const body = JSON.stringify({ moduleLoading: { prefix: "" }, clientModules: {}, entryCSSFiles, entryJSFiles: js });
  put(MANIFEST, `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST["/(gui)/x/page"] = ${body};\n`);
}

function build({ faces = FACES, preloaded = [] as string[], pagesPreloaded = [] as string[] } = {}) {
  for (const [name, n] of [["root-a", 3000], ["shared", 2000], ["root-b", 1500], ["app", 800], ["shell-a", 1200], ["shell-b", 900], ["page", 700]] as const) {
    put(`static/chunks/${name}.js`, randomBytes(n));
  }
  put(LATIN, randomBytes(4000));
  put(EXT, randomBytes(2500));
  put(OTHER, randomBytes(1000));
  put("static/chunks/app.css", faces.join("\n") + "\nbody{margin:0}");
  put("static/chunks/shell.css", "nav{display:flex;gap:4px}");
  put(
    "build-manifest.json",
    JSON.stringify({ polyfillFiles: ["static/chunks/polyfill.js"], rootMainFiles: ["static/chunks/root-a.js", "static/chunks/shared.js", "static/chunks/root-b.js"] }),
  );
  put("server/next-font-manifest.json", JSON.stringify({ app: { "[project]/src/app/(gui)/x/page": preloaded }, pages: { "/_app": pagesPreloaded } }));
  clientManifest();
}

const sum = (...names: string[]) => names.reduce((n, p) => n + (sizes.get(`static/chunks/${p}`) ?? NaN), 0);
const run = () => measure(next, { shellLayout: SHELL });
const failing = (opts: Parameters<typeof build>[0] = {}) => {
  build(opts);
  return compare(run(), LIMITS).rows.filter((r) => !r.ok);
};

beforeEach(() => {
  next = mkdtempSync(join(tmpdir(), "budgets-"));
  sizes.clear();
});
afterEach(() => rmSync(next, { recursive: true, force: true }));

describe("first-load byte budgets", () => {
  it("counts the framework as the root files, and a chunk shared with the shell once, in the framework", () => {
    build();
    const m = run();
    expect(m.framework.bytes).toBe(sum("root-a.js", "shared.js", "root-b.js"));
    expect(m.shell.files.map((f) => f.path)).not.toContain("static/chunks/shared.js");
  });

  it("counts the shell as the root and shell layout entries minus the framework, deduplicated", () => {
    build();
    const m = run();
    expect(m.shell.files.map((f) => f.path).sort()).toEqual(
      ["static/chunks/app.js", "static/chunks/shell-a.js", "static/chunks/shell-b.js"],
    );
    expect(m.shell.bytes).toBe(sum("app.js", "shell-a.js", "shell-b.js"));
    expect(m.css.bytes).toBe(sum("app.css", "shell.css"));
    expect(m.routes).toEqual([{ route: "/(gui)/x", bytes: sum("page.js") }]);
    expect(compare(m, LIMITS).ok).toBe(true);
  });

  it("fails each byte budget one byte over its measurement", () => {
    build();
    const m = run();
    const tight = {
      framework: { maxBytes: m.framework.bytes - 1 },
      shell: { layout: SHELL, maxBytesAboveFramework: m.shell.bytes - 1 },
      stylesheet: { maxBytes: m.css.bytes - 1 },
      fonts: { ...LIMITS.fonts, maxBasicLatinBytes: m.fonts.basicLatin.bytes - 1 },
    };
    const over = compare(m, tight).rows.filter((r) => !r.ok);
    expect(over.map((r) => [r.budget, r.unit])).toEqual([
      ["Framework floor", "bytes"],
      [`Shell JS above the framework (${SHELL})`, "bytes"],
      ["First-load stylesheet", "bytes"],
      ["Basic Latin font file", "bytes"],
    ]);
  });

  it("finds the basic Latin file by unicode-range and ignores the local() fallback block", () => {
    build();
    const { fonts } = run();
    expect(fonts.basicLatin.files.map((f) => f.path)).toEqual([LATIN]);
    expect(fonts.basicLatin.bytes).toBe(sizes.get(LATIN));
    expect(fonts.families).toEqual(["Inter"]);
    expect(fonts.faces).toHaveLength(2);

    build({ faces: [face("Inter", "optional", EXT, "U+0000-00FF,U+0131"), FALLBACK] });
    expect(run().fonts.basicLatin.files.map((f) => f.path)).toEqual([EXT]);
  });

  it("fails a row naming the cause for a second family, a non-optional display or a preloaded font", () => {
    const second = failing({ faces: [...FACES, face("Mono", "optional", OTHER, "U+0-FF")] });
    expect(second.map((r) => r.budget)).toEqual(["Font families with a downloaded file"]);
    expect(second[0].files).toEqual(["Inter", "Mono"]);

    const swap = failing({ faces: [face("Inter", "swap", LATIN, "U+??"), FALLBACK] });
    expect(swap.map((r) => r.budget)).toEqual(["Font faces whose font-display is not optional"]);
    expect(swap[0].files[0]).toContain("font-display swap");

    const unset = failing({ faces: [face("Inter", null, LATIN, "U+??"), FALLBACK] });
    expect(unset.map((r) => r.budget)).toEqual(["Font faces whose font-display is not optional"]);
    expect(unset[0].files[0]).toContain("font-display unset");

    for (const opts of [{ preloaded: [LATIN] }, { pagesPreloaded: [LATIN] }]) {
      const preload = failing(opts);
      expect(preload.map((r) => r.budget)).toEqual(["Preloaded fonts"]);
      expect(preload[0].files).toEqual([LATIN]);
    }
  });

  it.each([
    ["no rootMainFiles", () => put("build-manifest.json", JSON.stringify({ rootMainFiles: [] })), /rootMainFiles/],
    ["a listed file is missing", () => unlinkSync(join(next, "static/chunks/shell-a.js")), /shell-a\.js is listed/],
    ["the shell entry key is missing", () => clientManifest(`[project]/${SHELL}`), /has no entryJSFiles\["\[project\]\/src\/app\/\(gui\)\/layout"\]/],
    ["the layout folder has no client manifest", () => unlinkSync(join(next, MANIFEST)), /has no page_client-reference-manifest\.js/],
    ["the font manifest has no app map", () => put("server/next-font-manifest.json", "{}"), /has no app map/],
    ["a font manifest value is not a list", () => put("server/next-font-manifest.json", JSON.stringify({ app: { x: "a.woff2" } })), /app\["x"\] is not a list/],
    ["no face covers basic Latin", () => put("static/chunks/app.css", face("Inter", "optional", EXT, "U+100-2BA")), /no first-load @font-face .* \(basic Latin\); found U\+100-2BA/],
  ])("throws naming what is missing when %s", (_name, breakIt, message) => {
    build();
    breakIt();
    expect(run).toThrow(message);
  });

  it("throws naming shell.layout when the layout folder is missing", () => {
    build();
    expect(() => measure(next, { shellLayout: "src/app/(missing)/layout" })).toThrow(/shell\.layout "src\/app\/\(missing\)\/layout"/);
  });

  it("parses the client manifest without evaluating it", () => {
    build();
    const file = join(next, MANIFEST);
    expect(Object.keys(readClientManifest(file).entryJSFiles)).toContain(`[project]/${SHELL}`);

    const [first, second] = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, `${"x".repeat(first.length)}\n${second}\n`);
    expect(() => readClientManifest(file)).toThrow(/expected it to start with/);

    const g = globalThis as Record<string, unknown>;
    writeFileSync(file, `globalThis.__budgetsEvaluated = true;\nglobalThis.__RSC_MANIFEST["/x/page"] = {};\n`);
    expect(() => readClientManifest(file)).toThrow(/expected format/);
    writeFileSync(
      file,
      `${first}\nglobalThis.__RSC_MANIFEST["/x/page"] = (globalThis.__budgetsEvaluated = true, {});\n`,
    );
    expect(() => readClientManifest(file)).toThrow(/not JSON/);
    expect(g.__budgetsEvaluated).toBeUndefined();
  });

  it("the command exits 1 on a breach or a missing layout, and writes the step summary", () => {
    build();
    const summary = join(next, "summary.md");
    const cli = (limits: object) => {
      const file = join(next, "limits.json");
      writeFileSync(file, JSON.stringify(limits));
      return spawnSync(process.execPath, [join(process.cwd(), "scripts/budgets/check.mjs"), "--next", next, "--limits", file], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      });
    };

    const pass = cli(LIMITS);
    expect(pass.status).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("| Framework floor |");

    const breach = cli({ ...LIMITS, framework: { maxBytes: 1 } });
    expect(breach.status).toBe(1);
    expect(breach.stderr).toMatch(/Over budget: Framework floor[\s\S]*static\/chunks\/root-a\.js/);

    const missing = cli({ ...LIMITS, shell: { ...LIMITS.shell, layout: "src/app/(missing)/layout" } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/shell\.layout/);
  });
});
