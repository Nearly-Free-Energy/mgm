/**
 * Every modal is built on the dialog frame in src/components/ui/dialog.tsx
 * (`DialogOverlay`, `DialogPanel`, `DialogFooter`). The frame caps the
 * panel at the visible height and scrolls its content, opens as a
 * full-width sheet from the bottom under 600px, and keeps the Cancel and
 * Confirm row pinned on screen. A dialog that bypasses it is cut off or
 * unreachable on a phone.
 *
 * This test reads every .ts/.tsx file under src/app, src/components and src/lib/gui
 * (skipping __tests__/ and *.test.* files) with the TypeScript parser and
 * fails when:
 *
 *   1. a file other than the frame renders Radix Dialog's `Content` or
 *      `Overlay` itself: `Dialog.Content` on a namespace import, or a named
 *      or aliased `Content` / `Overlay` / `DialogContent` / `DialogOverlay`
 *      import from the Radix dialog packages;
 *   2. an HTML element carries `role="dialog"` or `role="alertdialog"`:
 *      a hand-made modal, which has no focus trap, no Esc and no sheet;
 *   3. a `<DialogPanel>` is given an `overflow-*` (other than `overflow-x-*`),
 *      `max-h-*` or `shadow-*` class at any breakpoint. `cn()` keeps the
 *      caller's class and drops the frame's, so `overflow-hidden` would
 *      turn the panel's scrolling off without any error. Only class names
 *      written as literals are seen; a className held in a variable is not.
 *   4. a class sized in `dvh` (or `svh`, `lvh`) is written without the
 *      `supports-[height:100dvh]:` variant, or without its `vh` twin at the
 *      same breakpoint in the same file. A browser without these units
 *      (Chrome and Android WebView before 108, Safari before 15.4) drops
 *      the declaration, so a `dvh` height cap on its own leaves the panel
 *      uncapped there. Two plain classes do not work either: `cn()` keeps
 *      only the last `max-h-*`. Any string literal is checked, so the
 *      frame's own class lists are covered.
 *
 * Fix: replace `Dialog.Overlay` with `<DialogOverlay />`, `Dialog.Content`
 * with `<DialogPanel className="w-[NNNpx]">`, and the button row with
 * `<DialogFooter>`; keep `Dialog.Root`, `Portal`, `Title`, `Description`
 * and `Close` from Radix.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ROOTS = ["src/app", "src/components", "src/lib/gui"];
const FRAME_FILE = "src/components/ui/dialog.tsx";
const FRAME_MODULE = "src/components/ui/dialog";

const RADIX_DIALOG_MODULES = new Set(["@radix-ui/react-dialog", "@radix-ui/react-alert-dialog"]);
const RADIX_FRAME_PARTS = new Set([
  "Content",
  "Overlay",
  "DialogContent",
  "DialogOverlay",
  "AlertDialogContent",
  "AlertDialogOverlay",
]);
const MODAL_ROLES = new Set(["dialog", "alertdialog"]);
/** Classes the frame owns. `overflow-x-*` does not displace `overflow-y-auto`. */
const FRAME_OWNED_CLASS = /^(?:overflow-(?!x-)|max-h-|shadow$|shadow-)/;
/** A length in a dynamic viewport unit (`90dvh`, `calc(100svh-4rem)`) or Tailwind's `h-dvh`. */
const DYNAMIC_VIEWPORT = /\d(?:d|s|l)vh\b|-(?:d|s|l)vh$/;
/** The variant that applies a dynamic viewport length only where the browser has it. */
const SUPPORTS_DYNAMIC_VIEWPORT = /^supports-\[height:100(?:d|s|l)vh\]$/;

type Finding = { file: string; line: number; rule: 1 | 2 | 3 | 4; detail: string };

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
      !/\.test\.tsx?$/.test(full)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** True when an import specifier written in `rel` points at the frame. */
function isFrameModule(rel: string, specifier: string): boolean {
  let target: string;
  if (specifier.startsWith("@/")) {
    target = path.posix.join("src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    target = path.posix.join(path.posix.dirname(rel), specifier);
  } else {
    return false;
  }
  return target.replace(/\.tsx?$/, "") === FRAME_MODULE;
}

/** Splits `max-[600px]:supports-[height:100dvh]:max-h-[92dvh]` into its variants and utility. */
function splitVariants(token: string): { variants: string[]; utility: string } {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return { variants, utility: token.slice(start) };
}

/** Drops variant prefixes (`max-[600px]:`, `md:`) and the important marker. */
function baseUtility(token: string): string {
  return splitVariants(token).utility.replace(/^!|!$/g, "");
}

/**
 * The `vh` class a dynamic-viewport class falls back to: the same utility
 * at the same breakpoint, without the supports variant and in `vh`
 * (`max-[600px]:supports-[height:100dvh]:max-h-[92dvh]` → `max-[600px]:max-h-[92vh]`,
 * `supports-[height:100dvh]:min-h-dvh` → `min-h-screen`).
 */
function vhTwin(token: string): string {
  const { variants, utility } = splitVariants(token);
  const twin = utility.replace(/(\d)(?:d|s|l)vh\b/g, "$1vh").replace(/-(?:d|s|l)vh$/, "-screen");
  return [...variants.filter((v) => !SUPPORTS_DYNAMIC_VIEWPORT.test(v)), twin].join(":");
}

/** Every class token written as a literal anywhere inside a className value. */
function literalClassTokens(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(...n.text.split(/\s+/).filter(Boolean));
    }
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

function attribute(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name,
  );
}

function stringValue(attr: ts.JsxAttribute): string | undefined {
  const init = attr.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}

function scanSource(rel: string, text: string, opts: { isFrame?: boolean } = {}) {
  const source = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const radixNamespaces = new Set<string>();
  const panelNames = new Set<string>();
  const literalTokens: { node: ts.Node; token: string }[] = [];
  let panels = 0;
  let dynamicHeights = 0;

  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const report = (n: ts.Node, rule: Finding["rule"], detail: string) => {
    if (rule === 1 && opts.isFrame) return;
    findings.push({ file: rel, line: lineOf(n), rule, detail });
  };

  // Imports first, so aliases are known before the JSX that uses them.
  for (const stmt of source.statements) {
    if (
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const specifier = stmt.moduleSpecifier.text;
      if (RADIX_DIALOG_MODULES.has(specifier)) {
        if (ts.isImportDeclaration(stmt)) {
          const bindings = stmt.importClause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            radixNamespaces.add(bindings.name.text);
          } else if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              const imported = (el.propertyName ?? el.name).text;
              if (RADIX_FRAME_PARTS.has(imported)) {
                report(el, 1, `imports ${imported} from ${specifier}`);
              }
            }
          }
        } else if (!stmt.exportClause) {
          report(stmt, 1, `re-exports everything from ${specifier}`);
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            const exported = (el.propertyName ?? el.name).text;
            if (RADIX_FRAME_PARTS.has(exported)) {
              report(el, 1, `re-exports ${exported} from ${specifier}`);
            }
          }
        }
      } else if (ts.isImportDeclaration(stmt) && isFrameModule(rel, specifier)) {
        const bindings = stmt.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if ((el.propertyName ?? el.name).text === "DialogPanel") panelNames.add(el.name.text);
          }
        }
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const token of node.text.split(/\s+/).filter(Boolean)) literalTokens.push({ node, token });
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      // `</Dialog.Content>` closes an element already reported at its opening tag.
      !ts.isJsxClosingElement(node.parent) &&
      ts.isIdentifier(node.expression) &&
      radixNamespaces.has(node.expression.text) &&
      RADIX_FRAME_PARTS.has(node.name.text)
    ) {
      report(node, 1, `uses ${node.expression.text}.${node.name.text}`);
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const isIntrinsic = ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
      if (isIntrinsic) {
        const role = attribute(node, "role");
        const value = role && stringValue(role);
        if (value && MODAL_ROLES.has(value)) {
          report(node, 2, `<${(tag as ts.Identifier).text} role="${value}"> is a hand-made modal`);
        }
      }
      if (ts.isIdentifier(tag) && panelNames.has(tag.text)) {
        panels++;
        const className = attribute(node, "className");
        if (className?.initializer) {
          for (const token of literalClassTokens(className.initializer)) {
            if (FRAME_OWNED_CLASS.test(baseUtility(token))) {
              report(node, 3, `DialogPanel is given "${token}", which the frame owns`);
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  // Rule 4 needs every literal in the file first: the vh twin may sit in
  // another string of the same class list.
  const written = new Set(literalTokens.map((t) => t.token));
  for (const { node, token } of literalTokens) {
    const { variants, utility } = splitVariants(token);
    if (!DYNAMIC_VIEWPORT.test(utility)) continue;
    dynamicHeights++;
    if (!variants.some((v) => SUPPORTS_DYNAMIC_VIEWPORT.test(v))) {
      report(node, 4, `"${token}" is not under supports-[height:100dvh]:`);
    } else if (!written.has(vhTwin(token))) {
      report(node, 4, `"${token}" has no "${vhTwin(token)}" beside it`);
    }
  }

  return { findings, panels, dynamicHeights };
}

function scanRepository() {
  const findings: Finding[] = [];
  let files = 0;
  let panels = 0;
  let dynamicHeights = 0;
  for (const root of ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      const result = scanSource(rel, readFileSync(file, "utf8"), { isFrame: rel === FRAME_FILE });
      findings.push(...result.findings);
      panels += result.panels;
      dynamicHeights += result.dynamicHeights;
      files++;
    }
  }
  return { findings, files, panels, dynamicHeights };
}

const RULE_TEXT: Record<Finding["rule"], string> = {
  1: "renders Radix Dialog's Content or Overlay outside the frame",
  2: "hand-made modal",
  3: "panel class the frame owns",
  4: "dynamic viewport height without a vh fallback",
};

describe("dialogs use the shared dialog frame", () => {
  const repo = scanRepository();

  it("scans the app and its components", () => {
    expect(repo.files).toBeGreaterThan(100);
    // Sanity: the scanner recognises the frame's panel where it is used.
    expect(repo.panels).toBeGreaterThanOrEqual(15);
  });

  it("the frame itself is the one place that renders Content and Overlay", () => {
    const text = readFileSync(path.join(REPO_ROOT, FRAME_FILE), "utf8");
    const details = scanSource(FRAME_FILE, text).findings.map((f) => f.detail);
    expect(details).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.Content$/),
        expect.stringMatching(/\.Overlay$/),
      ]),
    );
  });

  it("no dialog bypasses the frame or undoes it", () => {
    const lines = repo.findings
      .filter((f) => f.rule !== 4)
      .map((f) => `${f.file}:${f.line} (${RULE_TEXT[f.rule]}): ${f.detail}`);
    expect(
      lines,
      "\nThese dialogs do not use the frame in src/components/ui/dialog.tsx:\n  " +
        lines.join("\n  ") +
        "\nUse <DialogOverlay />, <DialogPanel className=\"w-[NNNpx]\"> and <DialogFooter>," +
        " and leave overflow, max-height and shadow to the panel.\n",
    ).toEqual([]);
  });

  it("every dvh height keeps a vh cap for browsers without dvh", () => {
    // Sanity: the frame's two caps and the selection list's phone cap are seen.
    expect(repo.dynamicHeights).toBeGreaterThanOrEqual(3);
    const lines = repo.findings
      .filter((f) => f.rule === 4)
      .map((f) => `${f.file}:${f.line}: ${f.detail}`);
    expect(
      lines,
      "\nThese heights have no fallback where dvh is unsupported:\n  " +
        lines.join("\n  ") +
        '\nWrite the vh class, then the dvh one under the supports variant:' +
        ' "max-h-[90vh] supports-[height:100dvh]:max-h-[90dvh]".\n',
    ).toEqual([]);
  });
});

describe("the scanner", () => {
  const rulesFor = (text: string, rel = "src/components/x/example.tsx") =>
    scanSource(rel, text).findings.map((f) => f.rule);

  it("flags Content and Overlay on a namespace import, under any alias", () => {
    expect(
      rulesFor(`import * as D from "@radix-ui/react-dialog";
        export const A = () => <D.Root><D.Portal><D.Overlay /><D.Content /></D.Portal></D.Root>;`),
    ).toEqual([1, 1]);
  });

  it("flags named and aliased Content and Overlay imports", () => {
    expect(
      rulesFor(`import { Content as Panel, DialogOverlay, Root } from "@radix-ui/react-dialog";`),
    ).toEqual([1, 1]);
  });

  it("allows the Radix parts the frame does not replace", () => {
    expect(
      rulesFor(`import * as Dialog from "@radix-ui/react-dialog";
        export const A = () => <Dialog.Root><Dialog.Portal><Dialog.Title /><Dialog.Close /></Dialog.Portal></Dialog.Root>;`),
    ).toEqual([]);
  });

  it("flags HTML elements with a modal role, but not components given one", () => {
    expect(
      rulesFor(`import { DialogPanel } from "@/components/ui/dialog";
        export const A = () => <>
          <div role="dialog" />
          <section role={"alertdialog"}></section>
          <DialogPanel role="alertdialog" />
          <div role="status" />
        </>;`),
    ).toEqual([2, 2]);
  });

  it("flags classes on the panel that would undo the frame, at any breakpoint", () => {
    expect(
      rulesFor(`import { DialogPanel as Panel } from "../ui/dialog";
        import { cn } from "@/lib/utils";
        export const A = () => <>
          <Panel className="w-[480px] overflow-hidden" />
          <Panel className={cn("w-[480px]", open && "max-[600px]:max-h-none")} />
          <Panel className={\`w-[480px] \${x} shadow-lg\`} />
          <Panel className="w-[480px] p-6 overflow-x-auto" />
        </>;`, "src/components/forms/example.tsx"),
    ).toEqual([3, 3, 3]);
  });

  it("flags a dvh class outside the supports variant, or without its vh twin at the same breakpoint", () => {
    expect(
      rulesFor(`export const A = [
        "max-h-[90dvh]",
        "supports-[height:100dvh]:max-h-[80dvh]",
        "max-h-[70vh] max-[600px]:supports-[height:100dvh]:max-h-[70dvh]",
        "h-dvh",
      ];`),
    ).toEqual([4, 4, 4, 4]);
  });

  it("accepts a dvh class under the supports variant with its vh twin anywhere in the file", () => {
    expect(
      rulesFor(`const CAPS = ["max-h-[90vh]", "max-[600px]:max-h-[92vh]"];
        export const A = () => <div className="supports-[height:100dvh]:max-h-[90dvh] max-[600px]:supports-[height:100dvh]:max-h-[92dvh]" />;
        export const B = "min-h-screen supports-[height:100dvh]:min-h-dvh";`),
    ).toEqual([]);
  });
});
