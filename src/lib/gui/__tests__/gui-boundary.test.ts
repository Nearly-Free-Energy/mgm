/**
 * Import boundaries of the GUI contract (docs/adr/ADR-006-gui-contract-v0.md).
 *
 * The contract is split by where code runs, and these rules keep each part on
 * its own side:
 *
 *   1. contract: src/lib/gui/contract.ts is client-safe. It imports only
 *      types (`import type`), and only from react and the plugin catalog
 *      (@/lib/plugins/bundled).
 *   2. server: src/lib/gui/surface.ts, src/lib/gui/fmt.ts and every file under
 *      src/lib/gui/host/server/ start with `import "server-only"`, so the
 *      Next.js build fails if a browser bundle reaches one.
 *   3. client: every file under src/lib/gui/host/client/ starts with
 *      "use client".
 *   4. shared: files under src/lib/gui/host/shared/ run on both sides, so they
 *      carry neither marker and import, as values, no react-dom, Supabase,
 *      Cordis runtime, Next.js server API or client host module. Every host
 *      file is in server/, client/ or shared/ ("host-layout").
 *   5. client-reach: no file a browser can load imports surface.ts, fmt.ts or
 *      host/server/. Browser entry points are files with "use client",
 *      contract.ts, host/client/, host/shared/, src/components/ and the GUI
 *      packages under src/gui/. Reachability follows `@/` and relative
 *      imports, re-exports and import(); type-only imports are skipped,
 *      because the compiler erases them.
 *   6. gui-imports: a GUI package (src/gui/<name>/) imports only the
 *      contract, the kit, react, react-dom, its own files, and the npm
 *      packages listed for it in REVIEWED_PACKAGES. It imports no stylesheet:
 *      GuiMeta.styles names it and the host links it.
 *   7. gui-meta: GUI metadata is read at start-up without React.
 *      src/gui/<name>/meta.ts imports only types from the contract, and
 *      src/gui/meta.ts imports only those files and contract types. Any other
 *      file directly under src/gui/ is refused until a rule for it is added
 *      here.
 *   8. gui-tests: a GUI package's test files import only what its other
 *      files may, plus the conformance kit, vitest and @testing-library/*,
 *      and files of their own package, test helpers included.
 *   9. conformance-reach: only test code imports the conformance kit
 *      (src/lib/gui/conformance/). No other file imports it, even as types.
 *
 * Each rule is a function over a map of file paths to source text. The
 * self-tests feed it small inline sources and expect every violation to be
 * caught, so the guard is shown to fail even while the directories it guards
 * are empty. Apart from rule 8, test files are not checked themselves, because
 * a bundle reaches one only when other code imports it: the client-reach walk
 * follows such an import into the test file, and a GUI package may not import
 * one at all.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

const CONTRACT = "src/lib/gui/contract.ts";
const SERVER_ONLY_FILES = ["src/lib/gui/surface.ts", "src/lib/gui/fmt.ts"];
const HOST = "src/lib/gui/host/";
const HOST_SERVER = `${HOST}server/`;
const HOST_CLIENT = `${HOST}client/`;
const HOST_SHARED = `${HOST}shared/`;
const GUI_PACKAGES = "src/gui/";
const CONFORMANCE = "src/lib/gui/conformance/";

/** What contract.ts may import types from. */
const CONTRACT_TYPE_SOURCES = ["react", "@/lib/plugins/bundled"];

/** What any GUI package may import, besides its own files and its reviewed packages. */
const GUI_ALLOWED = ["@/lib/gui/contract", "@/lib/gui/kit", "react", "react/jsx-runtime", "react-dom"];

/** What a GUI package's test files may import besides GUI_ALLOWED; also any @testing-library/ package. */
const GUI_TEST_ALLOWED = ["@/lib/gui/conformance", "vitest"];

/**
 * npm packages a GUI package may import, by package directory name. An entry
 * also admits the package's subpaths ("pkg/sub"). Adding one is a review
 * decision: the package runs in every browser that loads the GUI.
 */
const REVIEWED_PACKAGES: Readonly<Record<string, readonly string[]>> = {};

/** Imports a shared host module must not take as values, by package name. */
const SHARED_FORBIDDEN_PACKAGES = [
  /^server-only$/,
  /^client-only$/,
  /^react-dom(\/|$)/,
  /^@supabase\//,
  /^cordis(\/|$)/,
  /^next\/(headers|server)$/,
];
/** Directories a shared host module must not import values from. */
const SHARED_FORBIDDEN_DIRS = ["src/lib/supabase/", "src/lib/runtime/", HOST_CLIENT];

type Rule =
  | "contract"
  | "server"
  | "client"
  | "shared"
  | "host-layout"
  | "client-reach"
  | "gui-imports"
  | "gui-meta"
  | "gui-tests"
  | "conformance-reach";

type Violation = { rule: Rule; file: string; message: string };

/** Repo-relative POSIX path → source text. */
type Files = ReadonlyMap<string, string>;

type Import = {
  /** The module specifier; "" for import() or require() with a computed argument. */
  specifier: string;
  /** Written as `import type` / `export type … from` / `import("x").T`. */
  declaredTypeOnly: boolean;
  /**
   * Erased by the compiler: declared type-only, or every named specifier is
   * marked `type`. The second form is elided only while tsconfig leaves
   * verbatimModuleSyntax off; if it is turned on, treat it as a value import.
   */
  typeOnly: boolean;
};

function isTestFile(file: string): boolean {
  return /(^|\/)__tests__\//.test(file) || /\.(test|spec)\.tsx?$/.test(file) || /\.d\.ts$/.test(file);
}

/** A module path, with or without its extension, that names test code. */
function isTestPath(modulePath: string): boolean {
  return /(^|\/)__tests__(\/|$)/.test(modulePath) || /\.(test|spec)(\.tsx?)?$/.test(modulePath);
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** Every module a file names: static and dynamic imports, re-exports, require() and import types. */
function importsOf(source: ts.SourceFile): Import[] {
  const found: Import[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const declared = clause?.isTypeOnly ?? false;
      const bindings = clause?.namedBindings;
      const everySpecifierTyped =
        !!clause &&
        !clause.name &&
        !!bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      found.push({
        specifier: node.moduleSpecifier.text,
        declaredTypeOnly: declared,
        typeOnly: declared || everySpecifierTyped,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const everySpecifierTyped =
        !!clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly);
      found.push({
        specifier: node.moduleSpecifier.text,
        declaredTypeOnly: node.isTypeOnly,
        typeOnly: node.isTypeOnly || everySpecifierTyped,
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      found.push({
        specifier: ts.isStringLiteral(expression) ? expression.text : "",
        declaredTypeOnly: node.isTypeOnly,
        typeOnly: node.isTypeOnly,
      });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [argument] = node.arguments;
      found.push({
        specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : "",
        declaredTypeOnly: false,
        typeOnly: false,
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push({ specifier: node.argument.literal.text, declaredTypeOnly: true, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The directive prologue: "use client", "use strict" and the like. */
function directives(source: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    found.push(statement.expression.text);
  }
  return found;
}

function startsWithServerOnly(source: ts.SourceFile): boolean {
  const [first] = source.statements;
  return (
    !!first &&
    ts.isImportDeclaration(first) &&
    !first.importClause &&
    ts.isStringLiteral(first.moduleSpecifier) &&
    first.moduleSpecifier.text === "server-only"
  );
}

function startsWithUseClient(source: ts.SourceFile): boolean {
  const [first] = source.statements;
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client"
  );
}

/**
 * The file an `@/` or relative specifier names within `files`, or the path it
 * would have (`exists: false`) when no such source file is there; null for a
 * package.
 */
function resolveLocal(
  from: string,
  specifier: string,
  files: Files,
): { path: string; exists: boolean } | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.posix.normalize(`src/${specifier.slice(2)}`);
  else if (specifier.startsWith(".")) base = path.posix.join(path.posix.dirname(from), specifier);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  const found = candidates.find((candidate) => files.has(candidate));
  return found ? { path: found, exists: true } : { path: base, exists: false };
}

/** surface.ts, fmt.ts or host/server/, with or without an extension or index. */
function isServerOnlyTarget(file: string): boolean {
  const stem = file.replace(/\.tsx?$/, "").replace(/\/index$/, "");
  return (
    SERVER_ONLY_FILES.some((server) => server.replace(/\.ts$/, "") === stem) ||
    `${stem}/` === HOST_SERVER ||
    stem.startsWith(HOST_SERVER)
  );
}

function isBrowserEntry(file: string, source: ts.SourceFile): boolean {
  return (
    directives(source).includes("use client") ||
    file === CONTRACT ||
    file.startsWith(HOST_CLIENT) ||
    file.startsWith(HOST_SHARED) ||
    file.startsWith("src/components/") ||
    file.startsWith(GUI_PACKAGES)
  );
}

function isStylesheet(specifier: string): boolean {
  return /\.(css|scss|sass|less)(\?.*)?$/.test(specifier);
}

/** Why a file of the GUI package in `packageDir` may not import `specifier`, or null. */
function guiImportProblem(
  file: string,
  specifier: string,
  packageDir: string,
  reviewedForPackage: readonly string[],
  test: boolean,
): string | null {
  if (!specifier) return "imports a computed module";
  if (isStylesheet(specifier)) return `imports the stylesheet ${specifier}; GuiMeta.styles names it`;
  if (GUI_ALLOWED.includes(specifier)) return null;
  if (test && (GUI_TEST_ALLOWED.includes(specifier) || specifier.startsWith("@testing-library/"))) return null;
  if (specifier.startsWith(".")) {
    const target = path.posix.join(path.posix.dirname(file), specifier);
    if (!`${target}/`.startsWith(packageDir)) return `imports ${specifier}, outside its package`;
    if (!test && isTestPath(target)) return `imports ${specifier}, which is test code`;
    return null;
  }
  if (reviewedForPackage.some((entry) => specifier === entry || specifier.startsWith(`${entry}/`))) return null;
  const name = packageDir.slice(GUI_PACKAGES.length, -1);
  return `imports ${specifier}, which is not on the allowlist or in REVIEWED_PACKAGES["${name}"]`;
}

/** The GUI package directory ("src/gui/<name>/") a file belongs to, or null. */
function guiPackageDir(file: string): string | null {
  const match = /^src\/gui\/([^/]+)\//.exec(file);
  return match && match[1] !== "__tests__" ? `${GUI_PACKAGES}${match[1]}/` : null;
}

/** Every boundary violation in `files`. */
function boundaryViolations(
  input: Files,
  reviewed: Readonly<Record<string, readonly string[]>> = REVIEWED_PACKAGES,
): Violation[] {
  // The rules apply to non-test files; imports resolve against every file, so
  // the client-reach walk follows non-test code into a test file it imports.
  const files: Files = new Map([...input].filter(([file]) => !isTestFile(file)));
  const sources = new Map<string, ts.SourceFile>();
  const sourceOf = (file: string) => {
    let source = sources.get(file);
    if (!source) {
      source = parse(file, input.get(file) ?? "");
      sources.set(file, source);
    }
    return source;
  };
  const violations: Violation[] = [];
  const report = (rule: Rule, file: string, message: string) => violations.push({ rule, file, message });

  for (const file of files.keys()) {
    const source = sourceOf(file);
    const imports = importsOf(source);

    // 1. contract
    if (file === CONTRACT) {
      for (const imported of imports) {
        if (!imported.declaredTypeOnly || !CONTRACT_TYPE_SOURCES.includes(imported.specifier)) {
          report(
            "contract",
            file,
            `imports ${imported.specifier || "a computed module"}${imported.declaredTypeOnly ? "" : " as a value"}; contract.ts may only \`import type\` from ${CONTRACT_TYPE_SOURCES.join(" or ")}`,
          );
        }
      }
    }

    // 2. server
    if ((SERVER_ONLY_FILES.includes(file) || file.startsWith(HOST_SERVER)) && !startsWithServerOnly(source)) {
      report("server", file, 'does not start with `import "server-only"`');
    }

    // 3. client
    if (file.startsWith(HOST_CLIENT) && !startsWithUseClient(source)) {
      report("client", file, 'does not start with "use client"');
    }

    // 4. shared, and the host layout
    if (file.startsWith(HOST) && ![HOST_SERVER, HOST_CLIENT, HOST_SHARED].some((dir) => file.startsWith(dir))) {
      report("host-layout", file, "is not under host/server/, host/client/ or host/shared/");
    }
    if (file.startsWith(HOST_SHARED)) {
      for (const directive of directives(source)) {
        if (directive === "use client" || directive === "use server") {
          report("shared", file, `has "${directive}"; shared host modules run on both sides`);
        }
      }
      for (const imported of imports) {
        if (imported.typeOnly) continue;
        const local = resolveLocal(file, imported.specifier, files);
        const forbidden = local
          ? SHARED_FORBIDDEN_DIRS.some((dir) => local.path.startsWith(dir))
          : SHARED_FORBIDDEN_PACKAGES.some((pattern) => pattern.test(imported.specifier));
        if (forbidden) report("shared", file, `imports ${imported.specifier}; shared host modules stay pure`);
      }
    }

    // 9. conformance-reach
    if (!file.startsWith(CONFORMANCE)) {
      for (const imported of imports) {
        const local = resolveLocal(file, imported.specifier, input);
        if (local && `${local.path}/`.startsWith(CONFORMANCE)) {
          report("conformance-reach", file, `imports ${imported.specifier}; only test code imports the conformance kit`);
        }
      }
    }

    // 6 and 7. GUI packages and their metadata
    if (file.startsWith(GUI_PACKAGES)) {
      const rest = file.slice(GUI_PACKAGES.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        if (rest !== "meta.ts") {
          report("gui-meta", file, "has no import rule; add one to gui-boundary.test.ts before adding the file");
          continue;
        }
        for (const imported of imports) {
          const contractType = imported.declaredTypeOnly && imported.specifier === "@/lib/gui/contract";
          const packageMeta = /^\.\/[a-z0-9][a-z0-9-]*\/meta$/.test(imported.specifier);
          if (!contractType && !packageMeta) {
            report(
              "gui-meta",
              file,
              `imports ${imported.specifier || "a computed module"}; src/gui/meta.ts may import only ./<name>/meta and types from @/lib/gui/contract`,
            );
          }
        }
        continue;
      }
      const name = rest.slice(0, slash);
      const packageDir = `${GUI_PACKAGES}${name}/`;
      if (file === `${packageDir}meta.ts`) {
        for (const imported of imports) {
          if (!imported.declaredTypeOnly || imported.specifier !== "@/lib/gui/contract") {
            report(
              "gui-meta",
              file,
              `imports ${imported.specifier || "a computed module"}; a GUI's meta.ts may only \`import type\` from @/lib/gui/contract`,
            );
          }
        }
        continue;
      }
      for (const imported of imports) {
        const problem = guiImportProblem(file, imported.specifier, packageDir, reviewed[name] ?? [], false);
        if (problem) report("gui-imports", file, problem);
      }
    }
  }

  // 8. gui-tests: test files of a GUI package.
  for (const file of input.keys()) {
    const packageDir = guiPackageDir(file);
    if (!packageDir || !isTestFile(file) || file.endsWith(".d.ts")) continue;
    const name = packageDir.slice(GUI_PACKAGES.length, -1);
    for (const imported of importsOf(sourceOf(file))) {
      const problem = guiImportProblem(file, imported.specifier, packageDir, reviewed[name] ?? [], true);
      if (problem) report("gui-tests", file, problem);
    }
  }

  // 5. client-reach: a breadth-first walk from every browser entry point.
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const file of files.keys()) {
    if (isBrowserEntry(file, sourceOf(file))) {
      parent.set(file, null);
      queue.push(file);
    }
  }
  const chain = (file: string) => {
    const steps: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) steps.unshift(at);
    return steps.join(" → ");
  };
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    for (const imported of importsOf(sourceOf(file))) {
      if (imported.typeOnly) continue;
      const target = resolveLocal(file, imported.specifier, input);
      if (!target) continue;
      if (isServerOnlyTarget(target.path)) {
        report("client-reach", file, `${chain(file)} imports ${imported.specifier}, which is server-only`);
        continue;
      }
      if (target.exists && !parent.has(target.path)) {
        parent.set(target.path, file);
        queue.push(target.path);
      }
    }
  }

  return violations;
}

/** Every .ts and .tsx file under src/, test files included, keyed by repo-relative path. */
function repositoryFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    // Directory entries carry their own type, so nothing is checked with a
    // separate stat before it is read.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        if (name !== "node_modules") walk(full);
      } else if (entry.isFile() && /\.tsx?$/.test(name)) {
        const relative = path.relative(REPO_ROOT, full).split(path.sep).join("/");
        files.set(relative, readFileSync(full, "utf8"));
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  return files;
}

/**
 * Problems with a REVIEWED_PACKAGES table: each key must name a GUI package
 * directory, and each entry a dependency declared in package.json.
 */
function reviewedPackageProblems(
  reviewed: Readonly<Record<string, readonly string[]>>,
  guiPackageExists: (name: string) => boolean,
  dependencies: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const [name, packages] of Object.entries(reviewed)) {
    if (!guiPackageExists(name)) problems.push(`src/gui/${name} does not exist`);
    for (const entry of packages) {
      if (!dependencies.includes(entry)) problems.push(`${entry} (for ${name}) is not a dependency in package.json`);
    }
  }
  return problems;
}

function check(
  sources: Record<string, string>,
  reviewed: Readonly<Record<string, readonly string[]>> = {},
): Violation[] {
  return boundaryViolations(new Map(Object.entries(sources)), reviewed);
}

function rulesOf(violations: Violation[]): Rule[] {
  return violations.map((violation) => violation.rule);
}

describe("GUI import boundaries in this repository", () => {
  const files = repositoryFiles();
  const violations = boundaryViolations(files);
  const byRule = (rule: Rule) =>
    violations.filter((violation) => violation.rule === rule).map((v) => `${v.file}: ${v.message}`);

  it("reads the contract files the rules are about", () => {
    expect(files.has(CONTRACT)).toBe(true);
    expect(files.has("src/lib/gui/surface.ts")).toBe(true);
  });

  it("contract.ts imports only types, from react and the plugin catalog", () => {
    expect(byRule("contract")).toEqual([]);
  });

  it('surface.ts, fmt.ts and host/server/ start with import "server-only"', () => {
    expect(byRule("server")).toEqual([]);
  });

  it('host/client/ starts with "use client"', () => {
    expect(byRule("client")).toEqual([]);
  });

  it("host/shared/ stays pure, and every host file is in server/, client/ or shared/", () => {
    expect(byRule("shared")).toEqual([]);
    expect(byRule("host-layout")).toEqual([]);
  });

  it("no file a browser can load imports surface.ts, fmt.ts or host/server/", () => {
    // The walk starts from every "use client" file, so it covers real code
    // today, not only the empty GUI directories.
    const entries = [...files].filter(
      ([file, text]) => !isTestFile(file) && isBrowserEntry(file, parse(file, text)),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(byRule("client-reach")).toEqual([]);
  });

  it("GUI packages import only the allowlist and their reviewed packages", () => {
    expect(byRule("gui-imports")).toEqual([]);
  });

  it("GUI metadata files import only contract types and package metadata", () => {
    expect(byRule("gui-meta")).toEqual([]);
  });

  it("GUI test files import only the allowlist, the conformance kit, vitest and testing-library", () => {
    expect(byRule("gui-tests")).toEqual([]);
  });

  it("only test code imports the conformance kit", () => {
    expect(files.has(`${CONFORMANCE}index.ts`)).toBe(true);
    expect(byRule("conformance-reach")).toEqual([]);
  });

  it("REVIEWED_PACKAGES names existing GUI packages and declared dependencies", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const guiPackageExists = (name: string) => {
      const dir = path.join(REPO_ROOT, GUI_PACKAGES, name);
      return existsSync(dir) && statSync(dir).isDirectory();
    };
    expect(
      reviewedPackageProblems(REVIEWED_PACKAGES, guiPackageExists, Object.keys(manifest.dependencies ?? {})),
    ).toEqual([]);
  });
  it("every @/ module GUI packages may import is code-owned", () => {
    const codeowners = readFileSync(path.join(REPO_ROOT, ".github/CODEOWNERS"), "utf8");
    expect(unownedAllowlistEntries([...GUI_ALLOWED, ...GUI_TEST_ALLOWED], codeowners)).toEqual([]);
  });
});

/**
 * The allowlist entries under `@/` that no CODEOWNERS pattern covers. An
 * interface package may import them, so each must be code-owned: otherwise a
 * file added there reaches every interface without a code owner's review.
 * Patterns are read the way this repository writes them: a leading "/", and a
 * trailing "/" for a directory.
 */
function unownedAllowlistEntries(allowed: readonly string[], codeowners: string): string[] {
  const patterns = codeowners
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"))
    .map((line) => line.split(/\s+/)[0].slice(1));
  return allowed
    .filter((entry) => entry.startsWith("@/"))
    .filter((entry) => {
      const target = `src/${entry.slice(2)}`;
      return !patterns.some((pattern) =>
        pattern.endsWith("/") ? `${target}/`.startsWith(pattern) : pattern === target || pattern.startsWith(`${target}.`),
      );
    });
}

describe("the boundary checker catches each violation (self-tests)", () => {
  it("finds an allowlisted @/ module that CODEOWNERS does not cover", () => {
    const owned = "/src/lib/gui/contract.ts @a @b\n/src/lib/gui/surface.ts @a @b\n";
    expect(unownedAllowlistEntries(["@/lib/gui/contract", "@/lib/gui/kit", "react"], owned)).toEqual(["@/lib/gui/kit"]);
    expect(unownedAllowlistEntries(["@/lib/gui/kit"], "/src/lib/gui/ @a @b\n")).toEqual([]);
    expect(unownedAllowlistEntries(["@/lib/gui/kit"], "# /src/lib/gui/ @a\n")).toEqual(["@/lib/gui/kit"]);
  });

  describe("contract", () => {
    it("accepts type-only imports from react and the plugin catalog", () => {
      expect(
        check({
          [CONTRACT]: [
            'import type { ReactNode } from "react";',
            'import type { CoreEntityKind } from "@/lib/plugins/bundled";',
            "export type { CoreEntityKind };",
            "export const GUI_CONTRACT = '0.1.0';",
          ].join("\n"),
        }),
      ).toEqual([]);
    });

    it("refuses a value import from react", () => {
      expect(rulesOf(check({ [CONTRACT]: 'import { useState } from "react";' }))).toContain("contract");
    });

    it("refuses inline type specifiers, which leave the import in place under some settings", () => {
      expect(rulesOf(check({ [CONTRACT]: 'import { type ReactNode } from "react";' }))).toContain("contract");
    });

    it("refuses a type import from any other module", () => {
      expect(rulesOf(check({ [CONTRACT]: 'import type { Fmt } from "./surface";' }))).toContain("contract");
      expect(rulesOf(check({ [CONTRACT]: 'export type { Fmt } from "./surface";' }))).toContain("contract");
      expect(rulesOf(check({ [CONTRACT]: 'type F = import("./surface").Fmt;' }))).toContain("contract");
    });

    it("refuses a side-effect import and import()", () => {
      expect(rulesOf(check({ [CONTRACT]: 'import "react";' }))).toContain("contract");
      expect(rulesOf(check({ [CONTRACT]: 'export const load = () => import("react");' }))).toContain(
        "contract",
      );
    });
  });

  describe("server", () => {
    it('accepts a host/server module that starts with import "server-only"', () => {
      expect(
        check({ [`${HOST_SERVER}view.ts`]: '// comment\nimport "server-only";\nexport const x = 1;' }),
      ).toEqual([]);
    });

    it("refuses a host/server module without server-only", () => {
      expect(rulesOf(check({ [`${HOST_SERVER}view.ts`]: "export const x = 1;" }))).toContain("server");
    });

    it("refuses server-only when it is not the first statement", () => {
      expect(
        rulesOf(
          check({ [`${HOST_SERVER}nested/view.ts`]: 'import { z } from "zod";\nimport "server-only";' }),
        ),
      ).toContain("server");
    });

    it("refuses surface.ts and fmt.ts without server-only", () => {
      expect(rulesOf(check({ "src/lib/gui/surface.ts": "export type A = 1;" }))).toContain("server");
      expect(rulesOf(check({ "src/lib/gui/fmt.ts": "export const fmt = 1;" }))).toContain("server");
    });
  });

  describe("client", () => {
    it('accepts a host/client module that starts with "use client"', () => {
      expect(check({ [`${HOST_CLIENT}action-host.tsx`]: '"use client";\nexport const A = 1;' })).toEqual([]);
    });

    it('refuses a host/client module without "use client" first', () => {
      expect(rulesOf(check({ [`${HOST_CLIENT}invoke.ts`]: "export const invoke = 1;" }))).toContain("client");
      expect(
        rulesOf(check({ [`${HOST_CLIENT}invoke.ts`]: 'import { x } from "./y";\n"use client";' })),
      ).toContain("client");
    });
  });

  describe("shared and the host layout", () => {
    it("accepts a pure shared module", () => {
      expect(
        check({
          [`${HOST_SHARED}href.ts`]: 'import type { Href } from "@/lib/gui/contract";\nexport const ok = 1;',
          [CONTRACT]: "export const GUI_CONTRACT = '0.1.0';",
        }),
      ).toEqual([]);
    });

    it("refuses each marker and impure import in a shared module", () => {
      const cases = [
        'import "server-only";',
        '"use client";',
        'import { createPortal } from "react-dom";',
        'import { createClient } from "@supabase/supabase-js";',
        'import { createClient } from "@/lib/supabase/server";',
        'import { getMgmRuntime } from "@/lib/runtime/root";',
        'import { Context } from "cordis";',
        'import { cookies } from "next/headers";',
        'import { invoke } from "../client/invoke";',
      ];
      for (const source of cases) {
        expect(rulesOf(check({ [`${HOST_SHARED}m.ts`]: source })), source).toContain("shared");
      }
    });

    it("allows a shared module to import Supabase types, which are erased", () => {
      expect(
        check({ [`${HOST_SHARED}m.ts`]: 'import type { User } from "@supabase/supabase-js";' }),
      ).toEqual([]);
    });

    it("refuses a host file outside server/, client/ and shared/", () => {
      expect(rulesOf(check({ [`${HOST}registry.ts`]: 'import "server-only";' }))).toContain("host-layout");
    });
  });

  describe("client-reach", () => {
    it('refuses a "use client" file that imports surface.ts', () => {
      const violations = check({
        "src/components/x.tsx": '"use client";\nimport { thing } from "@/lib/gui/surface";',
        "src/lib/gui/surface.ts": 'import "server-only";\nexport const thing = 1;',
      });
      expect(rulesOf(violations)).toContain("client-reach");
    });

    it("refuses fmt.ts and host/server/ even before they exist", () => {
      expect(
        rulesOf(check({ "src/app/a.tsx": '"use client";\nimport { createFmt } from "@/lib/gui/fmt";' })),
      ).toContain("client-reach");
      expect(
        rulesOf(
          check({ "src/app/a.tsx": '"use client";\nimport { dispatchView } from "@/lib/gui/host/server/view";' }),
        ),
      ).toContain("client-reach");
    });

    it("follows plain modules from a browser entry point and names the chain", () => {
      const violations = check({
        "src/app/page-client.tsx": '"use client";\nimport { helper } from "@/lib/util/helper";',
        "src/lib/util/helper.ts": 'export { load as helper } from "./load";',
        "src/lib/util/load.ts": 'export const load = () => import("@/lib/gui/host/server/view");',
        [`${HOST_SERVER}view.ts`]: 'import "server-only";\nexport const v = 1;',
      });
      const reach = violations.filter((violation) => violation.rule === "client-reach");
      expect(reach).toHaveLength(1);
      expect(reach[0].message).toContain(
        "src/app/page-client.tsx → src/lib/util/helper.ts → src/lib/util/load.ts",
      );
    });

    it("treats host/client, host/shared, contract.ts, components and GUI packages as browser entry points", () => {
      const entries = [
        `${HOST_CLIENT}a.tsx`,
        `${HOST_SHARED}a.ts`,
        CONTRACT,
        "src/components/plain.tsx",
        "src/gui/probe/index.ts",
      ];
      for (const entry of entries) {
        const prefix = entry.startsWith(HOST_CLIENT) ? '"use client";\n' : "";
        expect(
          rulesOf(check({ [entry]: `${prefix}import { x } from "@/lib/gui/surface";` })),
          entry,
        ).toContain("client-reach");
      }
    });

    it("allows type-only imports of server modules from browser code", () => {
      expect(
        check({
          "src/components/x.tsx": '"use client";\nimport type { Fmt } from "@/lib/gui/surface";\nimport { type ViewDef } from "@/lib/gui/surface";',
        }),
      ).toEqual([]);
    });

    it("follows browser code into a test file it imports", () => {
      const violations = check({
        "src/components/x.tsx": '"use client";\nimport { helper } from "./__tests__/helper";',
        "src/components/__tests__/helper.ts": 'export { thing as helper } from "@/lib/gui/surface";',
      });
      expect(rulesOf(violations)).toContain("client-reach");
    });

    it("does not treat test files as browser entry points", () => {
      expect(
        check({ "src/components/__tests__/x.test.tsx": 'import { thing } from "@/lib/gui/surface";' }),
      ).toEqual([]);
    });

    it("does not flag a server module importing another", () => {
      expect(
        check({
          [`${HOST_SERVER}a.ts`]: 'import "server-only";\nimport { b } from "./b";',
          [`${HOST_SERVER}b.ts`]: 'import "server-only";\nexport const b = 1;',
        }),
      ).toEqual([]);
    });
  });

  describe("gui-imports", () => {
    it("accepts the allowlist and files inside the package", () => {
      expect(
        check({
          "src/gui/probe/index.tsx": [
            'import type { GuiPlugin } from "@/lib/gui/contract";',
            'import { KitView } from "@/lib/gui/kit";',
            'import { useState } from "react";',
            'import { createPortal } from "react-dom";',
            'import { Shell } from "./shell/shell";',
          ].join("\n"),
          "src/gui/probe/shell/shell.tsx": 'import { cx } from "../ui/cx";',
          "src/gui/probe/ui/cx.ts": "export const cx = 1;",
        }),
      ).toEqual([]);
    });

    it("refuses next/link in a GUI file", () => {
      expect(rulesOf(check({ "src/gui/probe/a.tsx": 'import Link from "next/link";' }))).toContain(
        "gui-imports",
      );
    });

    it("refuses an unreviewed npm package and accepts it once reviewed for that package", () => {
      const sources = { "src/gui/probe/a.tsx": 'import { X } from "lucide-react";' };
      expect(rulesOf(check(sources))).toContain("gui-imports");
      expect(rulesOf(check(sources, { other: ["lucide-react"] }))).toContain("gui-imports");
      expect(check(sources, { probe: ["lucide-react"] })).toEqual([]);
      expect(
        check({ "src/gui/probe/a.tsx": 'import * as D from "@radix-ui/react-dialog/dist";' }, {
          probe: ["@radix-ui/react-dialog"],
        }),
      ).toEqual([]);
    });

    it("refuses a relative import that leaves the package", () => {
      expect(
        rulesOf(check({ "src/gui/probe/a.tsx": 'import { B } from "../other-gui/x";' })),
      ).toContain("gui-imports");
      expect(rulesOf(check({ "src/gui/probe/a.tsx": 'import { B } from "../probe2/x";' }))).toContain(
        "gui-imports",
      );
    });

    it("refuses host and app modules, even as types", () => {
      for (const source of [
        'import type { Fmt } from "@/lib/gui/surface";',
        'import { Button } from "@/components/ui/button";',
        'import { createClient } from "@/lib/supabase/client";',
        'import "server-only";',
      ]) {
        expect(rulesOf(check({ "src/gui/probe/a.tsx": source })), source).toContain("gui-imports");
      }
    });

    it("refuses a stylesheet import, even inside the package", () => {
      expect(rulesOf(check({ "src/gui/probe/a.tsx": 'import "./styles.css";' }))).toContain("gui-imports");
    });

    it("refuses import() with a computed module", () => {
      expect(
        rulesOf(check({ "src/gui/probe/a.tsx": "export const load = (m: string) => import(m);" })),
      ).toContain("gui-imports");
    });

    it("refuses test code imported from a GUI package's own files", () => {
      for (const specifier of ["./__tests__/helper", "./a.test", "./sub/a.spec.tsx"]) {
        expect(
          rulesOf(check({ "src/gui/probe/a.tsx": `import { h } from "${specifier}";` })),
          specifier,
        ).toContain("gui-imports");
      }
    });

    it("skips test files", () => {
      expect(
        check({ "src/gui/probe/__tests__/a.test.tsx": 'import { render } from "@testing-library/react";' }),
      ).toEqual([]);
    });
  });

  describe("gui-tests", () => {
    it("accepts the kit, the conformance kit, vitest, testing-library and the package's own files", () => {
      expect(
        check({
          "src/gui/probe/__tests__/conformance.test.tsx": [
            'import { describe, it, vi } from "vitest";',
            'import { render } from "@testing-library/react";',
            'import userEvent from "@testing-library/user-event";',
            'import { describeGuiConformance } from "@/lib/gui/conformance";',
            'import { kit } from "@/lib/gui/kit";',
            'import probe from "..";',
            'import { helper } from "./helper";',
          ].join("\n"),
          "src/gui/probe/index.tsx": "export default {};",
          "src/gui/probe/__tests__/helper.ts": 'import { vi } from "vitest";\nexport const helper = vi.fn();',
        }),
      ).toEqual([]);
    });

    it("refuses host, app and unreviewed modules, and files outside the package", () => {
      for (const source of [
        'import { createClient } from "@/lib/supabase/client";',
        'import { getMgmRuntime } from "@/lib/runtime/root";',
        'import { crawl } from "@/lib/gui/conformance/crawl";',
        'import Link from "next/link";',
        'import { x } from "../../other/x";',
        'import "../styles.css";',
      ]) {
        expect(rulesOf(check({ "src/gui/probe/__tests__/a.test.tsx": source })), source).toContain("gui-tests");
      }
    });

    it("applies to test files next to the code as well", () => {
      expect(rulesOf(check({ "src/gui/probe/a.test.tsx": 'import { createClient } from "@/lib/supabase/client";' }))).toContain(
        "gui-tests",
      );
      expect(check({ "src/gui/probe/a.test.tsx": 'import { describeGuiConformance } from "@/lib/gui/conformance";' })).toEqual([]);
    });

    it("leaves tests outside GUI packages to the other rules", () => {
      expect(check({ "src/gui/__tests__/installed.test.ts": 'import { readFileSync } from "node:fs";' })).toEqual([]);
    });
  });

  describe("conformance-reach", () => {
    it("refuses the conformance kit in a GUI package's non-test files", () => {
      const rules = rulesOf(check({ "src/gui/probe/a.tsx": 'import { crawl } from "@/lib/gui/conformance";' }));
      expect(rules).toContain("gui-imports");
      expect(rules).toContain("conformance-reach");
    });

    it("refuses it in app and library code, by any path and even as types", () => {
      for (const [file, source] of [
        ["src/app/page.tsx", 'import { renderShell } from "@/lib/gui/conformance/harness";'],
        ["src/lib/gui/kit/x.tsx", 'import type { Finding } from "../conformance";'],
        ["src/components/x.tsx", 'export { CHECKS } from "@/lib/gui/conformance/checks";'],
        ["src/app/page.tsx", 'import { crawl } from "@/lib/gui/kit/../conformance";'],
      ]) {
        expect(rulesOf(check({ [file]: source })), file).toContain("conformance-reach");
      }
    });

    it("allows the conformance kit's own files and test files anywhere", () => {
      expect(
        check({
          [`${CONFORMANCE}index.ts`]: 'export { crawl } from "./crawl";',
          [`${CONFORMANCE}crawl.ts`]: "export const crawl = 1;",
          "src/lib/gui/kit/__tests__/a.test.tsx": 'import { crawl } from "@/lib/gui/conformance";',
        }),
      ).toEqual([]);
    });
  });

  describe("reviewed packages", () => {
    it("accepts an entry for an existing GUI package and a declared dependency", () => {
      expect(reviewedPackageProblems({ probe: ["clsx"] }, (name) => name === "probe", ["clsx"])).toEqual([]);
    });

    it("refuses an entry for a GUI package that does not exist", () => {
      expect(reviewedPackageProblems({ ghost: [] }, () => false, [])).toEqual(["src/gui/ghost does not exist"]);
    });

    it("refuses a package that is not a declared dependency", () => {
      expect(reviewedPackageProblems({ probe: ["lucide-react"] }, () => true, ["clsx"])).toEqual([
        "lucide-react (for probe) is not a dependency in package.json",
      ]);
    });
  });

  describe("gui-meta", () => {
    it("accepts the metadata shapes", () => {
      expect(
        check({
          "src/gui/meta.ts": [
            'import type { GuiMeta } from "@/lib/gui/contract";',
            'import { meta as probe } from "./probe/meta";',
            "export const GUI_META: Readonly<Record<string, GuiMeta>> = { probe };",
          ].join("\n"),
          "src/gui/probe/meta.ts": 'import type { GuiMeta } from "@/lib/gui/contract";\nexport const meta = {} as GuiMeta;',
        }),
      ).toEqual([]);
    });

    it("refuses a meta.ts that imports react", () => {
      expect(rulesOf(check({ "src/gui/probe/meta.ts": 'import { lazy } from "react";' }))).toContain(
        "gui-meta",
      );
      expect(rulesOf(check({ "src/gui/meta.ts": 'import type { FC } from "react";' }))).toContain("gui-meta");
    });

    it("refuses a value import of the contract in a GUI's meta.ts", () => {
      expect(
        rulesOf(check({ "src/gui/probe/meta.ts": 'import { GUI_CONTRACT } from "@/lib/gui/contract";' })),
      ).toContain("gui-meta");
    });

    it("refuses src/gui/meta.ts importing a GUI's entry rather than its metadata", () => {
      expect(rulesOf(check({ "src/gui/meta.ts": 'import probe from "./probe";' }))).toContain("gui-meta");
    });

    it("refuses any other file directly under src/gui", () => {
      expect(rulesOf(check({ "src/gui/installed.ts": "export const INSTALLED = {};" }))).toContain("gui-meta");
    });
  });
});
