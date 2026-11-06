/**
 * Colour tokens from src/app/globals.css, written out in hex for HTML that
 * globals.css never reaches: the pages page.ts renders carry their own small
 * stylesheet. Hex rather than oklch() because those pages open on whatever
 * browser a phone has, and a browser that cannot parse oklch() drops the
 * declaration instead of falling back to something readable.
 *
 * Each key is the token's name in globals.css; `card` is `--surface-1`
 * through its alias. `light` mirrors :root and `dark` the dark palette, at
 * the default --brand-hue. __tests__/palette.test.ts converts the tokens and
 * fails when a value here is off by more than one step in any channel, so
 * a change to globals.css (a rebrand included) fails until this file
 * follows. If the tokens move to another stylesheet, point that test there.
 *
 * No success colour on purpose: nothing on these pages may look like a
 * payment confirmation.
 */
export type PublicColour =
  | "background"
  | "card"
  | "foreground"
  | "muted-foreground"
  | "border"
  | "primary"
  | "primary-foreground"
  | "warning-muted"
  | "warning-fg";

export type PublicTheme = "light" | "dark";

export const PALETTE = {
  light: {
    background: "#fbfaf7",
    card: "#ffffff",
    foreground: "#0e1216",
    "muted-foreground": "#53595f",
    border: "#dfdeda",
    primary: "#3263c3",
    "primary-foreground": "#fcfcf9",
    "warning-muted": "#ffebca",
    "warning-fg": "#563500",
  },
  dark: {
    background: "#080d11",
    card: "#11151b",
    foreground: "#ecebe7",
    "muted-foreground": "#9fa5ac",
    border: "#2e3339",
    primary: "#6d9df5",
    "primary-foreground": "#090d16",
    "warning-muted": "#432e08",
    "warning-fg": "#fcd08b",
  },
} as const satisfies Record<PublicTheme, Record<PublicColour, `#${string}`>>;

/**
 * Page background per theme, for `<meta name="theme-color">` and the web
 * app manifest, which take a colour value rather than a variable.
 */
export const THEME_COLOR = {
  light: PALETTE.light.background,
  dark: PALETTE.dark.background,
} as const;
