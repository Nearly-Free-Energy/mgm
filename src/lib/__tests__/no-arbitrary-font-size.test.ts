/**
 * Font sizes come from the type scale declared as `--text-<name>` in
 * src/app/globals.css (CLAUDE.md design rule 3): text-caption, text-dense,
 * text-body, text-title, text-headline and text-kpi. An arbitrary size such
 * as `text-[13px]` has no touch-screen step and no line height, and the next
 * change to the scale misses it.
 *
 * Scans class syntax in every .ts/.tsx file under ROOTS, line by line. Test
 * files are skipped because they name classes to assert their absence. CSS is
 * not scanned: globals.css is where the sizes are declared. Inline CSS in an
 * HTML string (src/lib/public-html) is not class syntax and is not matched.
 * `style={{ fontSize }}` is flagged in src/app and src/components only:
 * src/lib/invoices draws a PDF with @react-pdf, whose sizes are print points
 * with no CSS behind them.
 *
 * Tailwind's own sizes (`text-xs`, `text-sm`, `text-lg` …) are not flagged
 * here; new text uses the type scale instead. Not caught: class names
 * assembled at run time, a size inside another arbitrary value, and a style
 * object built elsewhere and spread into `style`.
 *
 * ARBITRARY_SIZE follows how Tailwind 4.2 reads `text-[…]` and `text-(…)`: a
 * number with a unit or %, a math function, a font-size keyword or a size
 * type hint is a font size; anything else (`text-[red]`, `text-[var(--x)]`,
 * `text-(--x)`) is a colour, which no-palette-colors.test.ts covers. If a
 * Tailwind upgrade changes that inference, update the lists below.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = ["src/app", "src/components", "src/lib"];
const STYLE_ROOTS = ["src/app/", "src/components/"];

/** Type hints Tailwind compiles to font-size: `text-[size:…]`, `text-(length:--x)`. */
const SIZE_HINT = "length|size|percentage|absolute-size|relative-size";
/** CSS math functions; Tailwind reads `text-[fn(…)]` as a size for these and as a colour otherwise. */
const MATH_FN =
  "calc|min|max|clamp|mod|rem|round|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|hypot|log|exp";
/** Font-size keywords; any other bare word (`text-[red]`) compiles to a colour. */
const SIZE_KEYWORD = "xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger";

/**
 * text-[13px], md:text-[0.8rem], text-[50%], text-[13px]/[1.2], text-[size:13px],
 * text-[length:var(--size)], text-(length:--size), text-[clamp(1rem,2vw,2rem)],
 * text-[large], [font-size:13px], [font:13px_sans-serif]
 */
const ARBITRARY_SIZE = new RegExp(
  [
    `(?<![\\w-])text-\\[(?:${SIZE_HINT}):[^\\]\\s]*\\]`,
    `(?<![\\w-])text-\\((?:${SIZE_HINT}):[^)\\s]*\\)`,
    `(?<![\\w-])text-\\[[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[a-z]+|%)[^\\]\\s]*\\]`,
    `(?<![\\w-])text-\\[(?:${MATH_FN})\\([^\\]\\s]*\\]`,
    `(?<![\\w-])text-\\[(?:${SIZE_KEYWORD})\\]`,
    `(?<![\\w-])\\[font(?:-size)?:[^\\]\\s]*\\]`,
  ].join("|"),
  "g",
);

/**
 * style={{ fontSize: 13 }}, style={{ fontSize }}, style={{ "font-size": "13px" }},
 * style={{ font: "13px sans-serif" }}
 */
const STYLE_SIZE =
  /(?:\bfontSize\b|["']fontSize["']|["']font-size["'])\s*[:,}\]]|["']?\bfont["']?\s*:\s*["'`\d]/g;

/**
 * Files that may still hold an arbitrary size, and why. Empty by design; an
 * entry is deleted together with its file or its last arbitrary size, which
 * the staleness test below enforces.
 */
const ALLOWED: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).map((file) =>
  path.relative(REPO_ROOT, file),
);

function offenders(pattern: RegExp, scope: (file: string) => boolean = () => true): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (ALLOWED[file] || !scope(file)) continue;
    readFileSync(path.join(REPO_ROOT, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        const hits = line.match(pattern);
        if (hits) found.push(`${file}:${index + 1}: ${hits.join(" ")}`);
      });
  }
  return found;
}

const isArbitrarySize = (text: string) => (text.match(ARBITRARY_SIZE) ?? []).length > 0;

describe("font sizes come from the type scale", () => {
  it.each([
    "text-[13px]",
    "text-[10px]",
    "md:text-[13px]",
    "hover:text-[0.8rem]",
    "text-[1.2em]",
    "text-[13px]/5",
    "text-[13px]!",
    "!text-[13px]",
    "text-[length:13px]",
    "text-[size:13px]",
    "text-[percentage:50%]",
    "text-[absolute-size:large]",
    "text-(size:--x)",
    "text-(percentage:--x)",
    "text-[50%]",
    "text-[2cqw]",
    "text-[13px]/[1.2]",
    "text-[round(1rem,1px)]",
    "text-[mod(1rem,3px)]",
    "text-[large]",
    "text-[x-small]",
    "text-[smaller]",
    "[font:13px_sans-serif]",
    "text-[length:var(--size)]",
    "text-(length:--size)",
    "text-[clamp(1rem,2vw,2rem)]",
    "text-[calc(1rem+2px)]",
    "text-[.75rem]",
    "[font-size:13px]",
  ])("flags %s", (sample) => {
    expect(isArbitrarySize(sample)).toBe(true);
  });

  it.each([
    "text-caption",
    "text-dense",
    "md:text-body",
    "text-kpi",
    "text-sm",
    "text-muted-foreground",
    "text-[var(--destructive)]",
    "max-w-[14rem]",
    "h-[30px]",
    "leading-[1.1]",
    "tracking-[0.02em]",
    "context-[13px]",
    "text-[red]",
    "text-(--destructive)",
    "text-[currentColor]",
    "text-[0]",
    "text-[1.5]",
    "text-[abs(1rem)]",
    "text-shadow-[0_1px_2px_#000]",
    "font-size:12px",
  ])("allows %s", (sample) => {
    expect(isArbitrarySize(sample)).toBe(false);
  });

  it.each([
    "style={{ fontSize: 13 }}",
    'style={{ fontSize: "13px" }}',
    "style={{ fontSize }}",
    "style={{ color, fontSize }}",
    'style={{ "fontSize": 13 }}',
    "style={{ 'font-size': 13 }}",
    'style={{ font: "13px sans-serif" }}',
  ])("flags the style %s", (sample) => {
    expect((sample.match(STYLE_SIZE) ?? []).length).toBeGreaterThan(0);
  });

  it.each([
    "style={{ fontWeight: 600 }}",
    "style={{ fontFamily }}",
    "const fontSizeLabel = label;",
    "font-sans text-dense",
    "fonts: [inter]",
  ])("allows the style %s", (sample) => {
    expect(sample.match(STYLE_SIZE) ?? []).toEqual([]);
  });

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("uses no arbitrary font size", () => {
    expect(
      offenders(ARBITRARY_SIZE),
      "Use a type-scale size (text-caption, text-dense, text-body, text-title, text-headline, text-kpi); see CLAUDE.md design rule 3",
    ).toEqual([]);
  });

  it("sets no font size in a style object", () => {
    expect(
      offenders(STYLE_SIZE, (file) => STYLE_ROOTS.some((root) => file.startsWith(root))),
      "Use a type-scale class instead of style={{ fontSize }}",
    ).toEqual([]);
  });

  it("lists only files that exist and still need the exception", () => {
    const stale = Object.keys(ALLOWED).filter(
      (file) =>
        !existsSync(path.join(REPO_ROOT, file)) ||
        !isArbitrarySize(readFileSync(path.join(REPO_ROOT, file), "utf8")),
    );
    expect(stale).toEqual([]);
  });
});
