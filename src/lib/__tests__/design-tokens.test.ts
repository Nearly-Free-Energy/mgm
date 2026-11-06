/**
 * The design tokens in src/app/globals.css reach the browser.
 *
 * Tailwind 4 generates a utility only when its value is a theme variable in
 * the stylesheet it compiles. A class whose value is missing (or that lives
 * in a JavaScript config the compiler never reads) produces no CSS and no
 * error: the element just renders unstyled. So this test compiles
 * globals.css with Tailwind's own compiler, the one `@tailwindcss/postcss`
 * runs in the build, and checks the output:
 *
 * - there is no JavaScript config to put tokens in by mistake;
 * - every token utility generates CSS;
 * - no theme variable refers to itself (the browser discards such a
 *   variable; a self-referencing --font-sans once left every page in the
 *   system font);
 * - --font-sans reads the variable the root layout's web font sets;
 * - every semantic colour class used in src has a colour token;
 * - cn() keeps each type size, elevation and radius beside other classes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { compile } from "@tailwindcss/node";
import { cn, TYPE_SCALE } from "@/lib/utils";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CSS_PATH = path.join(REPO_ROOT, "src/app/globals.css");
const CSS = readFileSync(CSS_PATH, "utf8");
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const compiler = await compile(CSS, {
  base: path.dirname(CSS_PATH),
  from: CSS_PATH,
  onDependency() {},
});

/** The CSS Tailwind generates for these classes. */
function build(classes: string[]): string {
  return compiler.build(classes);
}

/** The rule a utility class generates, or "" when it generates none. */
function ruleFor(cls: string): string {
  const out = build([cls]);
  const start = out.indexOf(`.${cls} {`);
  if (start < 0) return "";
  return out.slice(start, out.indexOf("}", start) + 1);
}

/** Every `--name: value` declared in the stylesheet's `@theme` blocks. */
function themeVariables(): Map<string, string> {
  const vars = new Map<string, string>();
  for (const block of CSS_RULES.matchAll(/@theme(?:\s+inline)?\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars.set(m[1], m[2].trim());
    }
  }
  return vars;
}

/** Names of the `--<prefix>-<name>` theme variables, without sub-properties
 *  such as `--text-body--line-height`. */
function themeNames(prefix: string): string[] {
  const re = new RegExp(`^--${prefix}-([a-z0-9]+(?:-[a-z0-9]+)*)$`);
  return [...themeVariables().keys()].flatMap((name) => {
    const m = re.exec(name);
    return m ? [m[1]] : [];
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (
      stat.isFile() &&
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("design tokens", () => {
  it("has no JavaScript Tailwind config, which Tailwind 4 would not read", () => {
    for (const ext of ["ts", "js", "mjs", "cjs", "mts", "cts"]) {
      expect(existsSync(path.join(REPO_ROOT, `tailwind.config.${ext}`)), `tailwind.config.${ext}`).toBe(false);
    }
    expect(CSS_RULES).not.toMatch(/@config\b/);
  });

  it.each([
    "shadow-elev-1",
    "shadow-elev-2",
    "shadow-elev-3",
    "rounded-pill",
    "rounded-sm",
    "rounded-md",
    "rounded-lg",
    "rounded-xl",
    "font-sans",
    "font-mono",
  ])("generates CSS for %s", (cls) => {
    expect(ruleFor(cls)).not.toBe("");
  });

  it.each(["caption", "dense", "body", "title", "headline", "kpi"])(
    "text-%s is a font size with its line height",
    (name) => {
      const rule = ruleFor(`text-${name}`);
      expect(rule).toContain(`font-size: var(--text-${name})`);
      expect(rule).toContain(`--text-${name}--line-height`);
      expect(themeVariables().has(`--text-${name}--line-height`)).toBe(true);
    },
  );

  it("generates CSS for every size, elevation and radius declared in @theme", () => {
    const missing = [
      ...themeNames("text").map((n) => `text-${n}`),
      ...themeNames("shadow").map((n) => `shadow-${n}`),
      ...themeNames("radius").map((n) => `rounded-${n}`),
    ].filter((cls) => ruleFor(cls) === "");
    expect(missing).toEqual([]);
  });

  it("puts the body size and the default transition in the theme", () => {
    const theme = build(["transition-colors", "text-body"]);
    expect(theme).toMatch(/--default-transition-duration: 120ms;/);
    expect(theme).toMatch(/--text-body: 0\.9375rem;/);
  });

  it("raises body and dense text and every text field to 16px on coarse pointers", () => {
    const out = build([]);
    const at = out.indexOf("@media (pointer: coarse) {");
    expect(at).toBeGreaterThan(-1);
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(out.slice(at))?.[1] ?? "";
    expect(coarse).toMatch(/--text-body: 1rem;/);
    expect(coarse).toMatch(/--text-dense: 1rem;/);
    expect(coarse).toMatch(/\bselect,\s*textarea \{\s*font-size: max\(16px, 1rem\);/);
    expect(coarse).toMatch(/input:not\([^)]*\[type="checkbox"\]/);
    // Outside every @layer, so it wins over a text-xs or text-sm utility on
    // a field: count the braces still open where the block starts.
    const before = out.slice(0, at);
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
  });

  it("has no theme variable that refers to itself", () => {
    const candidates = [
      "font-sans",
      "font-mono",
      ...themeNames("text").map((n) => `text-${n}`),
      ...themeNames("shadow").map((n) => `shadow-${n}`),
      ...themeNames("radius").map((n) => `rounded-${n}`),
      ...themeNames("color").map((n) => `bg-${n}`),
    ];
    const out = build(candidates);
    const selfReferences = [...out.matchAll(/(--[\w-]+):\s*var\(\1[,)]/g)].map((m) => m[0]);
    expect(selfReferences).toEqual([]);
  });

  it("resolves font-sans through the variable the root layout's web font sets", () => {
    // next/font defines this variable on <html> (src/app/layout.tsx). If the
    // two names differ, every page renders in the system stack, with no
    // error.
    const layout = readFileSync(path.join(REPO_ROOT, "src/app/layout.tsx"), "utf8");
    const variables = [...layout.matchAll(/\bvariable:\s*"(--[\w-]+)"/g)].map((m) => m[1]);
    expect(variables).toHaveLength(1);
    expect(themeVariables().get("--font-sans")).toMatch(new RegExp(`^var\\(${variables[0]}[,)]`));
  });

  it("defines a colour token for every semantic colour class used in src", () => {
    // Utilities that take a colour, followed by one of the semantic token
    // families. A name outside these families is a Tailwind palette colour
    // or not a colour at all, and is not this test's concern.
    const SEMANTIC_COLOUR_CLASS =
      /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring-offset|ring|outline|fill|stroke|divide|from|via|to|placeholder|decoration|caret|accent|shadow)-((?:background|foreground|card|popover|primary|secondary|muted|accent|destructive|success|warning|border|input|ring|surface|subtle|energy|stale|sidebar|chart)(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w-])/g;
    const defined = new Set(themeNames("color"));
    const used = new Map<string, string>();
    for (const root of ["src/app", "src/components", "src/lib"]) {
      for (const file of walk(path.join(REPO_ROOT, root))) {
        for (const m of readFileSync(file, "utf8").matchAll(SEMANTIC_COLOUR_CLASS)) {
          if (!used.has(m[1])) used.set(m[1], `${path.relative(REPO_ROOT, file)}: ${m[0]}`);
        }
      }
    }
    expect(used.size).toBeGreaterThan(0);
    const undefinedTokens = [...used].filter(([name]) => !defined.has(name)).map(([, where]) => where);
    expect(undefinedTokens).toEqual([]);
  });

  describe("cn()", () => {
    it("lists exactly the type sizes declared in @theme", () => {
      expect([...TYPE_SCALE].sort()).toEqual(themeNames("text").sort());
    });

    it.each(themeNames("text"))("keeps text-%s beside a text colour and over another size", (name) => {
      expect(cn(`text-${name}`, "text-muted-foreground").split(" ")).toContain(`text-${name}`);
      expect(cn("text-sm", `text-${name}`)).toBe(`text-${name}`);
    });

    it.each(themeNames("shadow"))("lets shadow-%s replace another shadow", (name) => {
      expect(cn("shadow-sm", `shadow-${name}`)).toBe(`shadow-${name}`);
    });

    it.each(themeNames("radius"))("lets rounded-%s replace another radius", (name) => {
      expect(cn("rounded-md", `rounded-${name}`)).toBe(`rounded-${name}`);
    });
  });
});
