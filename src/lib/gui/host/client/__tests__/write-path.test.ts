/**
 * One write path: only the action host (action-host.tsx) imports invoke.ts,
 * the module that sends a prepared action to its route, and the kit does not
 * export it. A GUI therefore writes only through the host's form and
 * confirmation step. The scan covers every non-test file under src/lib/gui
 * and src/gui, and every way a file can name a module: import, re-export,
 * import() and require(). Type-only imports count too, so nothing builds on
 * invoke's types outside the host.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const ROOTS = ["src/lib/gui", "src/gui"];
const INVOKE = "src/lib/gui/host/client/invoke";
const HOST = "src/lib/gui/host/client/action-host.tsx";
const KIT = "src/lib/gui/kit/index.ts";

function sourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Every module specifier a source names. */
function specifiers(file: string, text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [argument] = node.arguments;
      // A computed specifier could name anything: refuse it outright.
      found.push(argument && ts.isStringLiteralLike(argument) ? argument.text : "<computed>");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/**
 * The repo path a local specifier names, without extension or /index; null
 * for a package. Every extension bundler resolution maps to a .ts source is
 * dropped, so "./invoke.js" names invoke.ts.
 */
function target(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) base = path.posix.join(path.posix.dirname(from), specifier);
  else return null;
  return base.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
}

/** Files, other than the host, that name invoke.ts. */
function invokeImporters(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([file]) => file !== HOST)
    .filter(([file, text]) =>
      specifiers(file, text).some((s) => s === "<computed>" || target(file, s) === INVOKE),
    )
    .map(([file]) => file);
}

const read = (files: string[]) => new Map(files.map((f) => [f, readFileSync(path.join(REPO_ROOT, f), "utf8")]));

describe("write path", () => {
  const files = read(ROOTS.flatMap(sourceFiles));

  it("scans the host and the kit", () => {
    expect(files.has(HOST)).toBe(true);
    expect(files.has(KIT)).toBe(true);
    expect(files.has(`${INVOKE}.ts`)).toBe(true);
    expect(files.has("src/gui/meta.ts")).toBe(true);
  });

  it("lets only action-host.tsx import invoke.ts", () => {
    expect(invokeImporters(files)).toEqual([]);
    expect(specifiers(HOST, files.get(HOST)!).some((s) => target(HOST, s) === INVOKE)).toBe(true);
  });

  it("catches an import, a re-export, an import() and a type import from anywhere scanned", () => {
    const caught = [
      ["src/gui/probe/a.tsx", 'import { invoke } from "@/lib/gui/host/client/invoke";'],
      ["src/lib/gui/kit/b.ts", 'export { invoke } from "../host/client/invoke";'],
      ["src/lib/gui/host/client/c.tsx", 'const m = import("./invoke.ts");'],
      ["src/lib/gui/host/client/d.ts", 'type T = import("./invoke").Something;'],
      ["src/lib/gui/host/client/e.ts", "const m = require(name);"],
      ["src/lib/gui/host/client/g.ts", 'import { invoke } from "./invoke.js";'],
      ["src/gui/probe/h.ts", 'import { invoke } from "@/lib/gui/host/client/invoke.js";'],
    ];
    const missed = [["src/lib/gui/host/client/f.ts", 'import { invoke } from "./invoked";']];
    const planted = new Map([...caught, ...missed] as [string, string][]);
    expect(invokeImporters(planted)).toEqual(caught.map(([file]) => file));
  });

  it("keeps invoke out of the kit's exports", () => {
    const text = files.get(KIT)!;
    const source = ts.createSourceFile(KIT, text, ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isExportSpecifier(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        names.push(node.name.getText(source));
      }
      if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) names.push(node.name?.getText(source) ?? "");
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(names).toContain("act");
    expect(names.filter((name) => /invoke/i.test(name))).toEqual([]);
    expect(text).not.toMatch(/export\s*\*/);
  });
});
