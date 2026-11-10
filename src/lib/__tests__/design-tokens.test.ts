/**
 * The design tokens in src/styles/tokens.css reach the browser through
 * src/app/globals.css, which imports them.
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
 * - both palettes, light and the inactive dark one, meet WCAG contrast
 *   minimums, for every brand hue in the range the header calls safe;
 * - nothing switches the dark palette on yet;
 * - cn() keeps each type size, elevation and radius beside other classes.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { compile } from "@tailwindcss/node";
import { cn, TYPE_SCALE } from "@/lib/utils";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CSS_PATH = path.join(REPO_ROOT, "src/app/globals.css");
const TOKENS_PATH = path.join(REPO_ROOT, "src/styles/tokens.css");
// The tokens are declared in tokens.css, which globals.css imports. The
// text checks below read both files; compile() resolves the import itself.
const CSS = `${readFileSync(TOKENS_PATH, "utf8")}\n${readFileSync(CSS_PATH, "utf8")}`;
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const compiler = await compile(readFileSync(CSS_PATH, "utf8"), {
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

// ── Colour palettes ────────────────────────────────────────────────────────

type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];
const DARK_SELECTOR = ':root[data-theme="dark"]';

/** The body of each rule at the top level of the stylesheet (outside any
 *  @media or @theme), keyed by its selector. A selector that appears in
 *  several top-level rules gets their bodies joined, in order. */
function topLevelRules(): Map<string, string> {
  const rules = new Map<string, string>();
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = "";
  for (let i = 0; i < CSS_RULES.length; i++) {
    const ch = CSS_RULES[i];
    if (ch === "{") {
      if (depth === 0) {
        prelude = CSS_RULES.slice(preludeStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        rules.set(prelude, (rules.get(prelude) ?? "") + CSS_RULES.slice(bodyStart, i));
        preludeStart = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      // A statement such as @import or @custom-variant.
      preludeStart = i + 1;
    }
  }
  return rules;
}

function customProperties(body: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props.set(m[1], m[2].trim());
  return props;
}

/** The custom properties in effect on <html> for a theme. The dark rule
 *  matches the same element as :root, so it overrides what it declares and
 *  inherits the rest. */
function palette(theme: Theme, brandHue?: number): Map<string, string> {
  const rules = topLevelRules();
  const vars = customProperties(rules.get(":root") ?? "");
  if (theme === "dark") {
    for (const [name, value] of customProperties(rules.get(DARK_SELECTOR) ?? "")) vars.set(name, value);
  }
  if (brandHue !== undefined) vars.set("--brand-hue", String(brandHue));
  return vars;
}

/** A token's value with every var() replaced, as the browser computes it. */
function resolve(vars: Map<string, string>, name: string, seen: string[] = []): string {
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined`);
  if (seen.includes(name)) throw new Error(`${[...seen, name].join(" → ")} is a cycle`);
  return raw.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (_, ref: string, fallback?: string) =>
    vars.has(ref) ? resolve(vars, ref, [...seen, name]) : (fallback ?? resolve(vars, ref, [...seen, name])),
  );
}

/** Relative luminance (WCAG 2) of an `oklch(L% C H)` colour. Colours outside
 *  sRGB are clipped per channel. That is usually, though not always,
 *  stricter than CSS's chroma-reducing gamut map, which keeps lightness and
 *  gives up chroma instead. */
function luminance(value: string): number {
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!m) throw new Error(`not an oklch(L% C H) colour: ${value}`);
  const [L, C, H] = [Number(m[1]) / 100, Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const red = clip(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const green = clip(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const blue = clip(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG contrast ratio between two tokens, named without the leading `--`. */
function contrast(vars: Map<string, string>, a: string, b: string): number {
  const [ya, yb] = [luminance(resolve(vars, `--${a}`)), luminance(resolve(vars, `--${b}`))];
  return (Math.max(ya, yb) + 0.05) / (Math.min(ya, yb) + 0.05);
}

const SURFACES = ["background", "surface-1", "surface-2", "surface-3"];
// `primary` and `destructive` are here as well as the text colours because
// links use `text-primary` and error messages `text-destructive` on these
// surfaces. They are checked at the default brand hue only.
const TEXT_COLOURS = ["foreground", "muted-foreground", "subtle-foreground", "primary", "destructive"];
const SOLIDS = ["primary", "accent", "success", "warning", "destructive"];
const TINTED = ["success", "warning", "destructive"];

/** Pairs that carry text, so need 4.5:1 (WCAG AA for body text). */
const TEXT_PAIRS: [string, string][] = [
  ...TEXT_COLOURS.flatMap((fg) => SURFACES.map((bg): [string, string] => [fg, bg])),
  ...SOLIDS.map((name): [string, string] => [`${name}-foreground`, name]),
  ...TINTED.map((name): [string, string] => [`${name}-fg`, `${name}-muted`]),
  ["energy-solar-ink", "surface-1"],
];

/** Marks and outlines that carry meaning without text, so need 3:1 (WCAG
 *  non-text contrast). Light `energy-solar` is not here: it is a pale fill
 *  that sits behind an icon or a darker mark, never a mark on its own, and
 *  `energy-solar-ink` is the solar colour that has to stand out. */
const GRAPHIC_PAIRS: Record<Theme, [string, string][]> = {
  light: ["energy-battery", "energy-grid", "energy-load", "stale", "ring"].map((fg) => [fg, "surface-1"]),
  dark: ["energy-solar", "energy-battery", "energy-grid", "energy-load", "stale", "ring"].map((fg) => [
    fg,
    "surface-1",
  ]),
};

/** The brand-hue range the stylesheet's header calls safe. */
function safeBrandHues(): [number, number] {
  const m = /Safe range for `--brand-hue`[^:]*:\s*(\d+)–(\d+)/.exec(CSS);
  if (!m) throw new Error("tokens.css header no longer states a safe range for --brand-hue");
  return [Number(m[1]), Number(m[2])];
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

  // Tailwind's source scan reads test files too, so a literal class name
  // here would put its rule in the app's stylesheet. These names have no
  // user in src yet; building them from parts keeps them out. If test files
  // leave the scan, literals are fine.
  it.each([
    "surface-1",
    "surface-2",
    "surface-3",
    "subtle-foreground",
    "energy-solar",
    "energy-solar-ink",
    "energy-battery",
    "energy-grid",
    "energy-load",
    "stale",
  ])("generates background and text colour utilities for %s", (name) => {
    expect(ruleFor(["bg", name].join("-"))).toContain(`background-color: var(--${name})`);
    expect(ruleFor(["text", name].join("-"))).toContain(`color: var(--${name})`);
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
    // Outside every @layer, so it wins over a text-xs or text-sm utility on
    // a field: only blocks with no brace still open where they start count.
    // The sizes (tokens.css) and the field rule (globals.css) are two blocks.
    const depth = (before: string) => (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    const blocks = [...out.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].filter(
      (m) => depth(out.slice(0, m.index)) === 0,
    );
    expect(blocks.length).toBeGreaterThan(0);
    const coarse = blocks.map((m) => m[1]).join("\n");
    expect(coarse).toMatch(/--text-body: 1rem;/);
    expect(coarse).toMatch(/--text-dense: 1rem;/);
    expect(coarse).toMatch(/\bselect,\s*textarea \{\s*font-size: max\(16px, 1rem\);/);
    expect(coarse).toMatch(/input:not\([^)]*\[type="checkbox"\]/);
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

  describe("colour palettes", () => {
    it("defines the dark palette as a top-level rule with a dark color-scheme", () => {
      const dark = topLevelRules().get(DARK_SELECTOR);
      expect(dark).toBeDefined();
      expect(dark).toMatch(/(^|[;\s])color-scheme:\s*dark;/);
    });

    it.each(THEMES)(
      "%s: card, muted, input and card-foreground follow the surface, border and foreground tokens",
      (theme) => {
        // Existing classes (bg-card, bg-muted, border-input, ...) keep
        // working and move with the newer names in either theme.
        const vars = palette(theme);
        expect(resolve(vars, "--card")).toBe(resolve(vars, "--surface-1"));
        expect(resolve(vars, "--muted")).toBe(resolve(vars, "--surface-2"));
        expect(resolve(vars, "--input")).toBe(resolve(vars, "--border"));
        expect(resolve(vars, "--card-foreground")).toBe(resolve(vars, "--foreground"));
      },
    );

    it("lets the dark theme override only tokens the light theme defines", () => {
      const light = palette("light");
      const extra = [...customProperties(topLevelRules().get(DARK_SELECTOR) ?? "").keys()].filter(
        (name) => !light.has(name),
      );
      expect(extra).toEqual([]);
    });

    it.each(THEMES.flatMap((theme) => TEXT_PAIRS.map(([fg, bg]) => [theme, fg, bg] as const)))(
      "%s: %s on %s is at least 4.5:1",
      (theme, fg, bg) => {
        expect(contrast(palette(theme), fg, bg)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(THEMES.flatMap((theme) => GRAPHIC_PAIRS[theme].map(([fg, bg]) => [theme, fg, bg] as const)))(
      "%s: %s on %s is at least 3:1",
      (theme, fg, bg) => {
        expect(contrast(palette(theme), fg, bg)).toBeGreaterThanOrEqual(3);
      },
    );

    it("keeps captions lighter than muted text in both themes", () => {
      for (const theme of THEMES) {
        const vars = palette(theme);
        expect(contrast(vars, "subtle-foreground", "surface-1"), theme).toBeLessThan(
          contrast(vars, "muted-foreground", "surface-1"),
        );
      }
    });

    it("sets a default brand hue inside the safe range", () => {
      const [low, high] = safeBrandHues();
      const hue = Number(resolve(palette("light"), "--brand-hue"));
      expect(hue).toBeGreaterThanOrEqual(low);
      expect(hue).toBeLessThanOrEqual(high);
    });

    it("re-derives only the brand colours from the brand hue", () => {
      const BRAND = ["--primary", "--primary-foreground", "--accent", "--accent-foreground", "--ring"];
      for (const theme of THEMES) {
        const vars = palette(theme);
        const shifted = palette(theme, 0);
        const followers = [...vars.keys()].filter(
          (name) => name !== "--brand-hue" && resolve(vars, name) !== resolve(shifted, name),
        );
        expect(followers.filter((name) => !BRAND.includes(name)), theme).toEqual([]);
      }
    });

    it("keeps brand text and the focus ring readable across the safe brand-hue range", () => {
      const [low, high] = safeBrandHues();
      expect(high).toBeGreaterThan(low);
      const failures: string[] = [];
      for (let hue = low; hue <= high; hue += 10) {
        for (const theme of THEMES) {
          const vars = palette(theme, hue);
          const checks: [string, string, number][] = [
            ["primary-foreground", "primary", 4.5],
            ["accent-foreground", "accent", 4.5],
            ["ring", "surface-1", 3],
          ];
          for (const [fg, bg, minimum] of checks) {
            const ratio = contrast(vars, fg, bg);
            if (ratio < minimum) failures.push(`${theme} hue ${hue}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
          }
        }
      }
      expect(failures).toEqual([]);
    });

    it("ties the dark: variant to data-theme, not the operating system's setting", () => {
      const cls = ["dark", "bg-card"].join(":"); // from parts: see the colour utilities above
      const out = build([cls]);
      const start = out.indexOf(".dark\\:bg-card {");
      expect(start).toBeGreaterThan(-1);
      const rule = out.slice(start, out.indexOf("}", start));
      expect(rule).toContain('[data-theme="dark"]');
      expect(rule).not.toContain("prefers-color-scheme");
    });

    it("keeps the dark palette inactive: nothing sets data-theme or follows the system setting", () => {
      // The dark palette is defined but not switched on. Dialog scrims, the
      // skeleton shimmer and shadow-only overlays still assume a light page
      // (see "Themes" in tokens.css). Give them dark values before
      // switching it on, then remove this check. Comments are left out, so
      // a note about the attribute does not count as setting it.
      const setters: string[] = [];
      for (const file of walk(path.join(REPO_ROOT, "src"))) {
        const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/gm, "$1");
        if (/data-theme|dataset\.theme\b/.test(code)) setters.push(path.relative(REPO_ROOT, file));
      }
      expect(setters).toEqual([]);
      expect(CSS_RULES).not.toMatch(/prefers-color-scheme/);
    });
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
