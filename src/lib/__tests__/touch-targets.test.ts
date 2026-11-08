// @vitest-environment jsdom
/**
 * Controls are at least 44px tall on touch screens, and unchanged with a
 * mouse.
 *
 * src/app/globals.css gives every control a 44px minimum height when the
 * primary pointer is coarse (a finger), draws checkboxes and radios at 20px
 * with the label around them as the target, and raises the text in fields to
 * 16px so iOS does not zoom into a field. This test compiles the stylesheet
 * with Tailwind's own compiler and checks the output:
 *
 * - which elements the 44px rule reaches, by matching its selector against
 *   sample markup in jsdom (the jsdom environment above; jsdom does not
 *   evaluate media queries or lay anything out, so this proves the
 *   selector, not a rendered size);
 * - that the rule sits in the base layer, where a utility on the element
 *   still wins, and the checkbox size and field text outside every layer,
 *   where they win over `size-4` and `text-sm`;
 * - that there is exactly one 16px field-text rule;
 * - that with a fine pointer (mouse, trackpad) nothing in globals.css sizes a
 *   control, and every `pointer-coarse:` class used in src applies only on
 *   touch screens;
 * - that a link drawn as a button which the 44px rule cannot reach carries
 *   `pointer-coarse:min-h-11` itself, and is a box for it to apply to.
 *   Without a display class a link is an inline box, where min-height does
 *   nothing, unless it is the item of a flex or grid row; the rule reaches
 *   such an item when it has a role the rule selects (the sub-tab links);
 * - that the root layout leaves pinch-zoom available.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { compile } from "@tailwindcss/node";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CSS_PATH = path.join(REPO_ROOT, "src/app/globals.css");
const CSS = readFileSync(CSS_PATH, "utf8");

const compiler = await compile(CSS, {
  base: path.dirname(CSS_PATH),
  from: CSS_PATH,
  onDependency() {},
});

const COARSE = "@media (pointer: coarse)";

interface Block {
  /** The selector of the nearest style rule, or "" inside an at-rule only. */
  selector: string;
  /** Enclosing at-rules, outermost first. */
  atRules: string[];
  /** Declarations, property to value. */
  decls: Map<string, string>;
}

/** Every block of declarations in a stylesheet, with its selector and the
 *  at-rules around it. Enough CSS for this file and Tailwind's output:
 *  comments, quoted strings, nesting; no escaped braces. */
function parseCss(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Block[] = [];
  const stack: { prelude: string; decls: string[] }[] = [];
  let buf = "";
  let quote = "";
  const flush = () => {
    const text = buf.trim();
    buf = "";
    if (text && stack.length > 0) stack[stack.length - 1].decls.push(text);
  };
  for (const ch of src) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ";") {
      flush();
    } else if (ch === "{") {
      stack.push({ prelude: buf.trim().replace(/\s+/g, " "), decls: [] });
      buf = "";
    } else if (ch === "}") {
      flush();
      const node = stack.pop();
      if (!node) throw new Error("unbalanced } in stylesheet");
      const chain = [...stack.map((s) => s.prelude), node.prelude];
      const decls = new Map<string, string>();
      for (const d of node.decls) {
        const colon = d.indexOf(":");
        if (colon > 0) decls.set(d.slice(0, colon).trim(), d.slice(colon + 1).trim());
      }
      if (decls.size > 0) {
        blocks.push({
          selector: [...chain].reverse().find((p) => !p.startsWith("@")) ?? "",
          atRules: chain.filter((p) => p.startsWith("@")),
          decls,
        });
      }
    } else {
      buf += ch;
    }
  }
  if (stack.length > 0) throw new Error("unbalanced { in stylesheet");
  return blocks;
}

const COMPILED = parseCss(compiler.build([]));

/** A sample element, attached to the document so `:has()` sees its children. */
function sample(html: string): Element {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  document.body.append(holder);
  const el = holder.firstElementChild;
  if (!el) throw new Error(`no element in ${html}`);
  return el;
}

/** `el.matches(selector)`, false for selectors jsdom cannot evaluate
 *  (pseudo-elements such as `::-webkit-date-and-time-value`). */
function matches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** One element of every kind of control the touch rules are about. */
const CONTROLS: Record<string, string> = {
  button: "<button>Save</button>",
  "text-labelled switch": '<button role="switch" aria-checked="false">Enable</button>',
  'element with role="button"': '<div role="button" tabindex="0">Drop a file</div>',
  tab: '<a role="tab" href="/x">Users</a>',
  "menu item": '<div role="menuitem">Edit</div>',
  "menu item checkbox": '<div role="menuitemcheckbox">Show</div>',
  "menu item radio": '<div role="menuitemradio">Daily</div>',
  "list option": '<div role="option">September</div>',
  "flex link": '<a class="flex items-center rounded-md px-3 py-2" href="/x">Microgrids</a>',
  "inline-flex link": '<a class="inline-flex items-center rounded-md px-3 py-1.5" href="/x">Rates</a>',
  summary: "<details><summary>More</summary></details>",
  select: "<select><option>A</option></select>",
  textarea: "<textarea></textarea>",
  "text field": "<input>",
  "date field": '<input type="date">',
  "submit input": '<input type="submit" value="Go">',
  "label around a checkbox": '<label><input type="checkbox"> Sandbox</label>',
  "label around a radio": '<label><input type="radio"> Residential</label>',
  "label around a radio button": '<label><button role="radio"></button> Residential</label>',
  checkbox: '<input type="checkbox">',
  radio: '<input type="radio">',
  "radio button": '<button role="radio"></button>',
  "checkbox button": '<button role="checkbox"></button>',
  "hidden input": '<input type="hidden">',
  "file input": '<input type="file">',
  "visually hidden input": '<input class="sr-only">',
  "visually hidden button": '<button class="sr-only">Skip</button>',
  "select hidden from assistive technology":
    '<select aria-hidden="true" tabindex="-1" style="position: absolute; width: 1px; height: 1px"></select>',
  "link in a sentence": '<a class="text-primary hover:underline" href="/x">the household</a>',
  "label around a text field": "<label>Name <input></label>",
};

const SAMPLES = Object.fromEntries(
  Object.entries(CONTROLS).map(([name, html]) => {
    const el = sample(html);
    // The control itself, not its wrapper, for <details> and <summary>.
    return [name, name === "summary" ? (el.querySelector("summary") as Element) : el];
  }),
) as Record<string, Element>;

function only<T>(items: T[], what: string): T {
  if (items.length !== 1) throw new Error(`expected ${what}, found ${items.length}`);
  return items[0];
}

const minHeightRule = only(
  COMPILED.filter((b) => b.decls.get("min-height") === "2.75rem"),
  "one rule sets the 44px minimum height",
);
const minWidthRule = only(
  COMPILED.filter((b) => b.decls.get("min-width") === "2.75rem"),
  "one rule sets the 44px minimum width",
);
const boxRule = only(
  COMPILED.filter((b) => b.decls.get("width") === "1.25rem" && b.decls.get("height") === "1.25rem"),
  "one rule draws checkboxes and radios at 20px",
);

describe("touch targets on a coarse pointer", () => {
  it("puts the 44px minimum in the base layer, inside the coarse-pointer query", () => {
    expect(minHeightRule.atRules).toEqual(["@layer base", COARSE]);
    expect(minWidthRule.atRules).toEqual(["@layer base", COARSE]);
  });

  it.each([
    "button",
    "text-labelled switch",
    'element with role="button"',
    "tab",
    "menu item",
    "menu item checkbox",
    "menu item radio",
    "list option",
    "flex link",
    "inline-flex link",
    "summary",
    "select",
    "textarea",
    "text field",
    "date field",
    "submit input",
    "label around a checkbox",
    "label around a radio",
    "label around a radio button",
  ])("gives a %s a 44px minimum height", (name) => {
    expect(matches(SAMPLES[name], minHeightRule.selector)).toBe(true);
  });

  it.each([
    "checkbox",
    "radio",
    "radio button",
    "checkbox button",
    "hidden input",
    "file input",
    "visually hidden input",
    "visually hidden button",
    "select hidden from assistive technology",
    "link in a sentence",
    "label around a text field",
  ])("leaves a %s out of the 44px minimum height", (name) => {
    expect(matches(SAMPLES[name], minHeightRule.selector)).toBe(false);
  });

  it("makes buttons at least 44px wide too, but not radio and checkbox glyphs or links", () => {
    expect(matches(SAMPLES.button, minWidthRule.selector)).toBe(true);
    expect(matches(SAMPLES['element with role="button"'], minWidthRule.selector)).toBe(true);
    expect(matches(SAMPLES["radio button"], minWidthRule.selector)).toBe(false);
    expect(matches(SAMPLES["visually hidden button"], minWidthRule.selector)).toBe(false);
    expect(matches(SAMPLES["flex link"], minWidthRule.selector)).toBe(false);
    expect(matches(SAMPLES["text field"], minWidthRule.selector)).toBe(false);
  });

  it("draws checkboxes and radios at 20px outside every layer, so it wins over size-4", () => {
    expect(boxRule.atRules).toEqual([COARSE]);
    for (const name of ["checkbox", "radio", "radio button", "checkbox button"]) {
      expect(matches(SAMPLES[name], boxRule.selector), name).toBe(true);
    }
    for (const name of ["visually hidden input", "text field", "button"]) {
      expect(matches(SAMPLES[name], boxRule.selector), name).toBe(false);
    }
  });

  it("has exactly one 16px field-text rule, outside every layer", () => {
    // The rule that stops iOS zooming into a focused field. A second copy in
    // another layer would be dead weight at best and a conflict at worst.
    const fieldText = only(
      COMPILED.filter(
        (b) =>
          b.atRules.includes(COARSE) &&
          b.decls.has("font-size") &&
          matches(SAMPLES["text field"], b.selector),
      ),
      "one coarse-pointer rule sets the text size of a field",
    );
    expect(fieldText.atRules).toEqual([COARSE]);
    expect(fieldText.decls.get("font-size")).toBe("max(16px, 1rem)");
    for (const name of ["select", "textarea", "date field"]) {
      expect(matches(SAMPLES[name], fieldText.selector), name).toBe(true);
    }
    expect(matches(SAMPLES.checkbox, fieldText.selector)).toBe(false);
  });

  it("leaves pinch-zoom available in the root layout", () => {
    // Field text is 16px so that iOS has no reason to zoom; zoom itself
    // stays available to anyone who needs it.
    const layout = readFileSync(path.join(REPO_ROOT, "src/app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/maximumScale|userScalable|maximum-scale|user-scalable/);
  });
});

/** .ts/.tsx under a directory, without tests. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (
      stat.isFile() &&
      /\.tsx?$/.test(full) &&
      !full.endsWith(".test.ts") &&
      !full.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_FILES = ["src/app", "src/components"].flatMap((root) => walk(path.join(REPO_ROOT, root)));

/** Properties that change how big a control is or how its text sits. */
const SIZING = /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|font|font-size|line-height|padding(?:-.+)?|display|align-items)$/;

describe("with a fine pointer (mouse, trackpad)", () => {
  it("globals.css sizes no control outside the coarse-pointer query", () => {
    const outside = parseCss(CSS)
      .filter((b) => !b.atRules.includes(COARSE) && !b.atRules.some((a) => a.startsWith("@keyframes")))
      .filter((b) => [...b.decls.keys()].some((p) => SIZING.test(p)))
      .filter((b) => Object.values(SAMPLES).some((el) => matches(el, b.selector)))
      .map((b) => `${b.selector} { ${[...b.decls.keys()].join("; ")} }`);
    expect(outside).toEqual([]);
  });

  it("every pointer-coarse: class used in src applies only on touch screens", () => {
    const classes = new Set<string>();
    for (const file of SOURCE_FILES) {
      for (const m of readFileSync(file, "utf8").matchAll(/(?<![\w:-])pointer-coarse:[\w./[\]-]+/g)) {
        classes.add(m[0].replace(/\.$/, ""));
      }
    }
    expect(classes.size).toBeGreaterThan(0);
    const blocks = parseCss(compiler.build([...classes])).filter((b) =>
      b.selector.startsWith(".pointer-coarse\\:"),
    );
    for (const cls of classes) {
      const escaped = `.${cls.replace(/[:./[\]]/g, (c) => `\\${c}`)}`;
      const own = blocks.filter((b) => b.selector === escaped);
      expect(own.length, `${cls} generates CSS`).toBeGreaterThan(0);
      for (const b of own) expect(b.atRules, cls).toContain(COARSE);
    }
  });
});

/** Tokens of every string a className expression can produce, with string
 *  constants declared in the same file resolved. */
function classTokens(expr: ts.Node, consts: Map<string, string>): string[] {
  const parts: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      parts.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text);
      for (const span of n.templateSpans) {
        visit(span.expression);
        parts.push(span.literal.text);
      }
    } else if (ts.isIdentifier(n) && consts.has(n.text)) {
      parts.push(consts.get(n.text) as string);
    } else {
      ts.forEachChild(n, visit);
    }
  };
  visit(expr);
  return parts.join(" ").split(/\s+/).filter(Boolean);
}

const DISPLAY = new Set(["block", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "table", "contents", "hidden"]);
const CONTAINERS = new Set(["flex", "inline-flex", "grid", "inline-grid"]);
/** Roles the 44px rule in globals.css selects on any element. */
const ROLES_IN_RULE = new Set(["button", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option"]);

function attribute(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string, sf: ts.SourceFile) {
  return el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name,
  );
}

/** Unprefixed class tokens of an element (variants such as `md:` dropped:
 *  the touch rule is about the narrowest screen). */
function plainClasses(
  el: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
  consts: Map<string, string>,
): { all: string[]; plain: string[] } {
  const init = attribute(el, "className", sf)?.initializer;
  const all = init ? classTokens(init, consts) : [];
  return { all, plain: all.filter((t) => !t.includes(":")) };
}

/** The opening tag of the nearest JSX element around `el`. */
function enclosing(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ts.JsxOpeningElement | undefined {
  // An opening tag's parent is its own element; a self-closing tag has none.
  const own: ts.Node = ts.isJsxOpeningElement(el) ? el.parent : el;
  for (let n = own.parent; n; n = n.parent) {
    if (ts.isJsxElement(n)) return n.openingElement;
  }
  return undefined;
}

/** `pointer-coarse:` display classes that let min-height size a link. */
const COARSE_BOX = new Set(["block", "inline-block", "flex", "inline-flex", "grid", "inline-grid"].map((d) => `pointer-coarse:${d}`));

describe("links drawn as buttons", () => {
  it("reach 44px on a touch screen: through the rule in globals.css, or with pointer-coarse:min-h-11", () => {
    let links = 0;
    let explicit = 0;
    const offenders: string[] = [];
    for (const file of SOURCE_FILES.filter((f) => f.endsWith(".tsx"))) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const consts = new Map<string, string>();
      const collect = (n: ts.Node): void => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.initializer &&
          (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))
        ) {
          consts.set(n.name.text, n.initializer.text);
        }
        ts.forEachChild(n, collect);
      };
      collect(sf);
      const visit = (n: ts.Node): void => {
        if (
          (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
          ["a", "Link"].includes(n.tagName.getText(sf))
        ) {
          links += 1;
          const { all, plain } = plainClasses(n, sf, consts);
          // Rounded corners and padding: drawn as a button. A link with a
          // display class of its own is either a flex box (which the rule
          // selects) or a block card sized by its content.
          const drawnAsButton =
            plain.some((t) => /^rounded(?:-|$)/.test(t)) && plain.some((t) => /^p[xy]?-/.test(t));
          if (drawnAsButton && !plain.some((t) => DISPLAY.has(t))) {
            // Without a display class the link is inline, where min-height
            // does nothing, unless it is the item of a flex or grid
            // container. The rule reaches such an item only by its role.
            const role = attribute(n, "role", sf)?.initializer;
            const parent = enclosing(n);
            const flexItem =
              parent !== undefined && plainClasses(parent, sf, consts).plain.some((t) => CONTAINERS.has(t));
            const reached =
              role !== undefined && ts.isStringLiteral(role) && ROLES_IN_RULE.has(role.text) && flexItem;
            // pointer-coarse:min-h-11 works only on a box: a flex item, or a
            // link that becomes one on touch screens.
            const sized =
              all.includes("pointer-coarse:min-h-11") && (flexItem || all.some((t) => COARSE_BOX.has(t)));
            if (sized) {
              explicit += 1;
            } else if (!reached) {
              const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
              offenders.push(`${path.relative(REPO_ROOT, file)}:${line}`);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    // The scan found what it is looking for, so an empty list means something.
    expect(links).toBeGreaterThan(20);
    expect(explicit).toBeGreaterThan(0);
    expect(
      offenders,
      "A link with rounded corners and padding but no display class is an inline box, which the " +
        "44px rule in globals.css cannot size. Add `pointer-coarse:inline-flex pointer-coarse:min-h-11 " +
        "pointer-coarse:items-center`, or give it `flex`/`inline-flex`.",
    ).toEqual([]);
  });
});
