/**
 * What the CLI may import (RFC #259 decisions 6 and 10; #297), held as a GUI
 * package is held by src/lib/gui/__tests__/gui-boundary.test.ts.
 *
 *   1. cli-imports: a file of the CLI (packages/mgm-cli/src, test files
 *      apart) imports only its own files, Node.js built-ins (`node:`), and
 *      three modules of the app: the client-safe contract
 *      (src/lib/gui/contract.ts), the pasted-code codec
 *      (src/lib/auth/pasted-code.ts) and the discovery answer's type
 *      (src/lib/auth/discovery-answer.ts). No npm package: the CLI has no
 *      runtime dependency, so the archive (C4, #300) carries none and none is
 *      native. Relative imports name their `.ts` file, as Node.js needs to
 *      run the sources.
 *   2. shared-modules: the pasted-code codec and the discovery answer import
 *      nothing, and the contract imports only types (as gui-boundary.test.ts
 *      rule 1 also holds), so none of them brings server code into the CLI.
 *   3. compile: the CLI's own tsconfig (Node.js types, no DOM, only syntax
 *      Node.js can strip) type-checks the sources with no error, loading
 *      nothing beyond the CLI, those three modules, the plugin catalog the
 *      contract takes types from, TypeScript's libraries and Node.js's types.
 *      So a contract change that breaks the CLI fails in the same pull
 *      request.
 *   4. package: package.json declares no dependency, and Node.js runs the
 *      command from its sources.
 *
 * Rules 1 and 2 are functions over a map of paths to source text; the
 * self-tests feed them small sources and expect each violation caught.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CLI_ROOT = "packages/mgm-cli";
const CLI_SRC = `${CLI_ROOT}/src/`;
/** The app modules the CLI may import. */
const SHARED = ["src/lib/gui/contract.ts", "src/lib/auth/pasted-code.ts", "src/lib/auth/discovery-answer.ts"];
/** Shared modules that must import nothing at all. */
const SELF_CONTAINED = ["src/lib/auth/pasted-code.ts", "src/lib/auth/discovery-answer.ts"];
/** What else the CLI's type check may load from the repository: the contract's type source. */
const TYPE_SOURCES = ["src/lib/plugins/bundled.ts"];

type Files = ReadonlyMap<string, string>;
type Import = { specifier: string; typeOnly: boolean };

function isTestFile(file: string): boolean {
  return /(^|\/)__tests__\//.test(file) || /\.(test|spec)\.ts$/.test(file);
}

/** Every module a file names: imports, re-exports, import() and require(), and import types. */
function importsOf(file: string, text: string): Import[] {
  const found: Import[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const everyTyped =
        !!clause && !clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: (clause?.isTypeOnly ?? false) || everyTyped });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      found.push({ specifier: ts.isStringLiteral(expression) ? expression.text : "", typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [argument] = node.arguments;
      found.push({ specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : "", typeOnly: false });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

/** Rule 1. */
function cliImportProblems(files: Files): string[] {
  const problems: string[] = [];
  for (const [file, text] of files) {
    if (!file.startsWith(CLI_SRC) || isTestFile(file)) continue;
    for (const { specifier } of importsOf(file, text)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        problems.push(`${file} imports ${specifier || "a computed module"}: the CLI imports only its own files, node: built-ins and ${SHARED.join(", ")}`);
        continue;
      }
      if (!specifier.endsWith(".ts")) {
        problems.push(`${file} imports ${specifier} without its .ts extension, which Node.js needs to run the sources`);
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (target.startsWith(CLI_SRC) && !isTestFile(target)) {
        if (!files.has(target)) problems.push(`${file} imports ${specifier}, which does not exist`);
        continue;
      }
      if (SHARED.includes(target)) continue;
      problems.push(`${file} imports ${target}: the CLI imports only its own files, node: built-ins and ${SHARED.join(", ")}`);
    }
  }
  return problems;
}

/** Rule 2. */
function sharedModuleProblems(files: Files): string[] {
  const problems: string[] = [];
  for (const file of SHARED) {
    const text = files.get(file);
    if (text === undefined) {
      problems.push(`${file} is missing`);
      continue;
    }
    for (const imported of importsOf(file, text)) {
      if (SELF_CONTAINED.includes(file)) problems.push(`${file} imports ${imported.specifier}; it must import nothing`);
      else if (!imported.typeOnly) problems.push(`${file} imports ${imported.specifier} as a value; it may import only types`);
    }
  }
  return problems;
}

function cliAndSharedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.set(relative, readFileSync(path.join(REPO_ROOT, relative), "utf8"));
    }
  };
  walk(`${CLI_ROOT}/src`);
  for (const file of SHARED) files.set(file, readFileSync(path.join(REPO_ROOT, file), "utf8"));
  return files;
}

/** Rule 3: every diagnostic, and every file loaded outside what the CLI may reach. */
function compileProblems(): string[] {
  const configPath = path.join(REPO_ROOT, CLI_ROOT, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) return ["packages/mgm-cli/tsconfig.json could not be read"];
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const problems = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) => {
    const where = diagnostic.file ? path.relative(REPO_ROOT, diagnostic.file.fileName) : "program";
    return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
  const allowedPackages = [`node_modules${path.sep}@types${path.sep}node${path.sep}`, `node_modules${path.sep}undici-types${path.sep}`];
  for (const source of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(source)) continue;
    const file = path.relative(REPO_ROOT, path.resolve(source.fileName)).split(path.sep).join("/");
    if (file.startsWith(CLI_SRC) && !isTestFile(file)) continue;
    if (SHARED.includes(file) || TYPE_SOURCES.includes(file)) continue;
    if (allowedPackages.some((dir) => path.resolve(source.fileName).includes(dir))) continue;
    problems.push(`loads ${file}`);
  }
  return problems;
}

describe("the CLI's imports (#297)", () => {
  it("rule 1: imports only its own files, node: built-ins and the three shared modules", () => {
    expect(cliImportProblems(cliAndSharedFiles())).toEqual([]);
  });

  it("rule 2: the shared modules bring nothing else with them", () => {
    expect(sharedModuleProblems(cliAndSharedFiles())).toEqual([]);
  });

  it("rule 3: type-checks with Node.js types only, loading nothing else", () => {
    expect(compileProblems()).toEqual([]);
  }, 60_000);

  it("rule 4: declares no dependency, and Node.js runs the command from its sources", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, CLI_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"]) {
      expect(pkg[field], field).toBeUndefined();
    }
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ mgm: "src/mgm.ts" });
    const help = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(CLI_ROOT, "src/mgm.ts"), "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(help.stderr).toBe("");
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^Usage: mgm <command>/);
  }, 60_000);
});

describe("the rules catch what they are for (self-tests)", () => {
  const shared = (overrides: Record<string, string> = {}) =>
    new Map<string, string>([
      ["src/lib/gui/contract.ts", 'import type { MgmPluginName } from "@/lib/plugins/bundled";\nexport const GUI_CONTRACT = "0";'],
      ["src/lib/auth/pasted-code.ts", "export const x = 1;"],
      ["src/lib/auth/discovery-answer.ts", "export type A = {};"],
      ...Object.entries(overrides),
    ]);

  it.each([
    ["an npm package", 'import ts from "typescript";', /imports typescript/],
    ["an app module by @/", 'import { x } from "@/lib/supabase/server";', /imports @\/lib\/supabase\/server/],
    ["an app module by path", 'import { x } from "../../../src/lib/supabase/service.ts";', /imports src\/lib\/supabase\/service\.ts/],
    ["a computed import", "const m = await import(name);", /a computed module/],
    ["a require", 'const m = require("undici");', /imports undici/],
    ["an import type of a package", 'type T = import("react").ReactNode;', /imports react/],
    ["a relative import without .ts", 'import { a } from "./other";', /without its \.ts extension/],
    ["a test helper", 'import { a } from "./__tests__/helper.ts";', /imports packages\/mgm-cli\/src\/__tests__\/helper\.ts/],
  ])("rule 1 refuses %s", (_name, source, problem) => {
    const files = shared({ "packages/mgm-cli/src/a.ts": source, "packages/mgm-cli/src/other.ts": "" });
    expect(cliImportProblems(files).join("\n")).toMatch(problem);
  });

  it("rule 1 allows its own files, node: built-ins and the shared modules, and does not check tests", () => {
    const files = shared({
      "packages/mgm-cli/src/a.ts": [
        'import { b } from "./b.ts";',
        'import { createHash } from "node:crypto";',
        'import { GUI_CONTRACT } from "../../../src/lib/gui/contract.ts";',
        'import { decodePastedCode } from "../../../src/lib/auth/pasted-code.ts";',
        'import type { DiscoveryAnswer } from "../../../src/lib/auth/discovery-answer.ts";',
      ].join("\n"),
      "packages/mgm-cli/src/b.ts": "export const b = 1;",
      "packages/mgm-cli/src/__tests__/a.test.ts": 'import { it } from "vitest";',
    });
    expect(cliImportProblems(files)).toEqual([]);
  });

  it.each([
    ["src/lib/auth/pasted-code.ts", 'import type { X } from "./x";', /must import nothing/],
    ["src/lib/auth/discovery-answer.ts", 'export type { X } from "./x";', /must import nothing/],
    ["src/lib/gui/contract.ts", 'import { cache } from "react";', /as a value/],
  ])("rule 2 refuses an import in %s", (file, source, problem) => {
    expect(sharedModuleProblems(shared({ [file]: source })).join("\n")).toMatch(problem);
  });
});
