/**
 * Colours come from the semantic tokens declared in src/styles/tokens.css
 * (CLAUDE.md design rule 3), never from Tailwind's palette or a literal value.
 * A palette class ignores --brand-hue and any later change to the tokens, so
 * a rebrand silently misses that element.
 *
 * Scans class syntax in every .ts/.tsx file under ROOTS, line by line. Test
 * files are skipped because they name classes to assert their absence. CSS is
 * not scanned: tokens.css is where colour literals belong. Style objects,
 * @react-pdf StyleSheets (src/lib/invoices) and inline CSS in HTML strings are
 * not class syntax and are not matched; a printed invoice keeps print colours.
 * Not caught: class names assembled at run time, `bg-[red]`-style named
 * colours, a colour literal inside another arbitrary value
 * (`shadow-[0_1px_#000]`), and `style={{ color }}`. Mask utilities
 * (`mask-t-from-black`) are left alone: a mask uses only the colour's alpha.
 *
 * A token reached through `var()` is flagged too, in each spelling Tailwind
 * compiles to a colour: `accent-[color:var(--primary)]`, `bg-[var(--primary)]`,
 * `bg-(--primary)` and `bg-(color:--primary)`. Every colour token that
 * tokens.css declares under `@theme` has its own utility (`accent-primary`,
 * `border-b-destructive`), and the `var()` form hides the token from search
 * and from a rename. If a token is ever declared outside `@theme`, it has no
 * utility; add it to `@theme` rather than loosening this.
 *
 * PALETTE, VAR_COLOUR_UTILITY and UTILITY follow Tailwind 4.2: its palettes,
 * the utilities that read an untyped `[var(…)]` or `(--…)` value as a colour,
 * and those plus the shadow utilities, which take a colour but read an untyped
 * value as a shadow. If a Tailwind upgrade adds a palette or a colour utility,
 * or changes how an untyped value is read, update these lists.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = ["src/app", "src/components", "src/lib"];

const PALETTE =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|" +
  "slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe";
/** Colour utilities that read an untyped `[var(…)]` or `(--…)` value as a colour. */
const VAR_COLOUR_UTILITY =
  "bg|text|border(?:-(?:bs|be|[xytrblse]))?|outline|ring(?:-offset)?|inset-ring|divide|fill|stroke|" +
  "from|via|to|accent|caret|decoration|placeholder";
/** Every colour utility: the above, plus the shadows, which read an untyped value as a shadow. */
const UTILITY = `${VAR_COLOUR_UTILITY}|shadow|inset-shadow|drop-shadow|text-shadow`;
const COLOUR_FN = "#|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\(";

/** bg-blue-500, hover:text-gray-600/50, text-white, bg-black/30 */
const PALETTE_CLASS = new RegExp(
  `(?<![\\w-])(?:${UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|black|white)(?:/[\\w.%\\[\\]]+)?(?![\\w-])`,
  "g",
);
/**
 * bg-[#fff], text-[rgb(0_0_0)], accent-[color:var(--primary)], [color:#fff],
 * shadow-(color:--ring), bg-[var(--primary)], bg-(--primary)
 */
const ARBITRARY_COLOUR = new RegExp(
  [
    `(?<![\\w-])(?:${UTILITY})-\\[(?:color:|${COLOUR_FN})[^\\]\\s]*\\]`,
    `(?<![\\w-])(?:${UTILITY})-\\(color:[^)\\s]*\\)`,
    `(?<![\\w-])(?:${VAR_COLOUR_UTILITY})-(?:\\[var\\(|\\(--)[^\\]\\s]*[\\])]`,
    `(?<![\\w-])\\[(?:color|background-color|border(?:-[a-z]+)*-color|fill|stroke|outline-color|accent-color|` +
      `caret-color|text-decoration-color):(?:${COLOUR_FN}|var\\()[^\\]\\s]*\\]`,
  ].join("|"),
  "g",
);

/**
 * Files that may still hold a raw colour class, and why. Empty by design; an
 * entry is deleted together with its file or its last raw colour, which the
 * staleness test below enforces.
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

function offenders(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (ALLOWED[file]) continue;
    readFileSync(path.join(REPO_ROOT, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        const hits = line.match(pattern);
        if (hits) found.push(`${file}:${index + 1}: ${hits.join(" ")}`);
      });
  }
  return found;
}

const matches = (pattern: RegExp, text: string) => (text.match(pattern) ?? []).length > 0;
const isRawColour = (text: string) => matches(PALETTE_CLASS, text) || matches(ARBITRARY_COLOUR, text);

describe("colour classes come from tokens", () => {
  it.each([
    "bg-blue-500",
    "hover:text-gray-600",
    "border-red-200",
    "bg-black/30",
    "text-white",
    "dark:bg-zinc-900",
    "md:hover:bg-sky-400/50",
    "!bg-red-500",
    "bg-red-500!",
    "ring-offset-white",
    "divide-slate-100",
    "from-emerald-50",
    "border-l-amber-300",
    "fill-white",
    "stroke-mauve-700",
    "bg-[#fff]",
    "text-[rgb(0_0_0)]",
    "border-[hsl(0_0%_50%)]",
    "bg-[oklch(50%_0.1_200)]",
    "accent-[color:var(--primary)]",
    "border-b-[color:var(--destructive)]",
    "[color:#fff]",
    "[background-color:var(--x)]",
    "[border-inline-start-color:var(--x)]",
    "border-bs-red-500",
    "bg-[var(--primary)]",
    "text-(--destructive)",
    "accent-(--primary)",
    "hover:border-b-(color:--destructive)",
    "ring-offset-(--background)",
    "shadow-(color:--ring)",
  ])("flags %s", (sample) => {
    expect(isRawColour(sample)).toBe(true);
  });

  it.each([
    "bg-muted",
    "text-muted-foreground",
    "border-border",
    "bg-foreground/55",
    "text-destructive-fg",
    "bg-transparent",
    "text-current",
    "border-x-transparent",
    "accent-primary",
    "border-b-destructive",
    "fill-warning-muted",
    "stroke-success",
    "text-[13px]",
    "h-[var(--radix-select-trigger-height)]",
    "[animation:mgm-shimmer_1.4s_ease-in-out_infinite]",
    "max-w-[14rem]",
    "{ [color: string]: string }",
    "bg-[url(/logo.png)]",
    "bg-(image:--hero)",
    "text-(length:--size)",
    "border-[length:var(--width)]",
    "shadow-[var(--elevation)]",
    "drop-shadow-(--glow)",
    "focus-visible:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_25%,transparent)]",
  ])("allows %s", (sample) => {
    expect(isRawColour(sample)).toBe(false);
  });

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("uses no Tailwind palette colour", () => {
    expect(
      offenders(PALETTE_CLASS),
      "Use a semantic token (bg-card, text-muted-foreground, bg-destructive-muted …); see CLAUDE.md design rule 3",
    ).toEqual([]);
  });

  it("uses no arbitrary colour value", () => {
    expect(
      offenders(ARBITRARY_COLOUR),
      "Use the token's utility (accent-primary, not accent-[color:var(--primary)]), or add the token to src/styles/tokens.css",
    ).toEqual([]);
  });

  it("lists only files that exist and still need the exception", () => {
    const stale = Object.keys(ALLOWED).filter(
      (file) =>
        !existsSync(path.join(REPO_ROOT, file)) ||
        !isRawColour(readFileSync(path.join(REPO_ROOT, file), "utf8")),
    );
    expect(stale).toEqual([]);
  });
});
