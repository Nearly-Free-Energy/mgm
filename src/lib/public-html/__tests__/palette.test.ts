/**
 * PALETTE mirrors colour tokens in src/styles/tokens.css. This test reads the
 * light theme from the top-level :root rule and the dark theme from the
 * top-level :root[data-theme="dark"] rule laid over it, resolves var(),
 * converts each oklch() value to sRGB the way the browser does for an
 * in-gamut colour (clipping a colour outside sRGB), and allows one step per
 * channel for rounding. If the tokens move to another stylesheet or the
 * dark palette to another selector, point this test there.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PALETTE, THEME_COLOR, type PublicColour, type PublicTheme } from "../palette";

const CSS_PATH = path.resolve(__dirname, "../../../styles/tokens.css");
const CSS = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const DARK_SELECTOR = ':root[data-theme="dark"]';

/** The body of each rule outside any at-rule block, by selector. */
function topLevelRules(): Map<string, string> {
  const rules = new Map<string, string>();
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < CSS.length; i++) {
    if (CSS[i] === "{") {
      if (depth === 0) {
        selector = CSS.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) {
        rules.set(selector, (rules.get(selector) ?? "") + CSS.slice(start, i));
        start = i + 1;
      }
    } else if (CSS[i] === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return rules;
}

function declarations(body: string): Map<string, string> {
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function tokens(theme: PublicTheme): Map<string, string> {
  const rules = topLevelRules();
  const vars = declarations(rules.get(":root") ?? "");
  if (theme === "dark") {
    const dark = rules.get(DARK_SELECTOR);
    if (dark === undefined) throw new Error(`tokens.css has no top-level ${DARK_SELECTOR} rule`);
    for (const [name, value] of declarations(dark)) vars.set(name, value);
  }
  return vars;
}

function resolve(vars: Map<string, string>, name: string, seen: string[] = []): string {
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined in tokens.css`);
  if (seen.includes(name)) throw new Error(`${[...seen, name].join(" → ")} is a cycle`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_, ref: string) => resolve(vars, ref, [...seen, name]));
}

/** `oklch(L% C H)` as sRGB channels 0–255. */
function oklchToRgb(value: string): [number, number, number] {
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!m) throw new Error(`not an oklch(L% C H) colour: ${value}`);
  const [L, C, H] = [Number(m[1]) / 100, Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const encode = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  };
  return [encode(linear[0]), encode(linear[1]), encode(linear[2])];
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

const THEMES: PublicTheme[] = ["light", "dark"];
const NAMES = Object.keys(PALETTE.light) as PublicColour[];

describe("public page palette", () => {
  it("gives both themes the same colours, as lower-case #rrggbb", () => {
    expect(Object.keys(PALETTE.dark).sort()).toEqual([...NAMES].sort());
    for (const theme of THEMES) {
      for (const name of NAMES) expect(PALETTE[theme][name], `${theme} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it.each(THEMES.flatMap((theme) => NAMES.map((name) => [theme, name] as const)))(
    "%s %s matches its token in tokens.css",
    (theme, name) => {
      const expected = oklchToRgb(resolve(tokens(theme), `--${name}`));
      const actual = hexToRgb(PALETTE[theme][name]);
      const off = actual.map((channel, i) => Math.abs(channel - expected[i]));
      expect(Math.max(...off), `${PALETTE[theme][name]} vs rgb(${expected.join(" ")})`).toBeLessThanOrEqual(1);
    },
  );

  it("takes the theme colour from each theme's page background", () => {
    expect(THEME_COLOR).toEqual({ light: PALETTE.light.background, dark: PALETTE.dark.background });
  });
});
