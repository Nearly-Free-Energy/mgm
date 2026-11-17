/**
 * No server code calls a function from a "use client" module.
 *
 * On the server, every export of a "use client" module is a client
 * reference: it can be rendered as a component, but calling it throws
 * "Attempted to call useLocale() from the server". <Currency>, <Kwh> and
 * <LocalDate> live in modules without "use client", so that server code can
 * import their string helpers (formatCurrency, formatKwh, formatLocalDate),
 * but the components themselves call useLocale() from locale-context.tsx,
 * which is "use client". A server component that renders one of them fails
 * the whole page: #194, the tenant page's bills table. A page test cannot
 * see this, because renderToStaticMarkup has no server/client boundary.
 *
 * So this test reads the source. It starts from every route segment file
 * under src/app without "use client" (page, layout, route and the rest),
 * whose top-level functions run on the server, and follows every function
 * and constant they reference, through `@/` and relative imports and
 * re-exports, into other modules without "use client". A "use client"
 * module is the boundary: rendering its exports is fine, and the walk does
 * not enter it. Every function reached must not call an export of a
 * "use client" module. To fix a failure, render the component from a
 * "use client" component instead, as tenant-billing-table.tsx does.
 *
 * Not covered: classes, and calls that only happen through a value passed
 * around at run time.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(REPO_ROOT, "src");
const APP = path.join(SRC, "app");

/** Next.js route segment files: they run on the server unless "use client". */
const SEGMENT_FILE = /^(page|layout|template|default|loading|not-found|forbidden|unauthorized|route)\.tsx?$/;

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function segmentFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : segmentFiles(full);
    return SEGMENT_FILE.test(name) ? [full] : [];
  });
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, source);
  }
  return source;
}

/** The file an `@/` or relative specifier names; null for a package or a missing file. */
function resolve(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

type Module = {
  client: boolean;
  /** Local name → the export it imports; "*" for a namespace import. */
  imports: Map<string, { file: string; name: string }>;
  /** Top-level functions and constants by local name. */
  decls: Map<string, ts.Node>;
  /** Exported name → local name. */
  exports: Map<string, string>;
  /** `export … from`: exported name → source name, or "*". */
  reexports: { file: string; names: Map<string, string> | "*" }[];
};

const modules = new Map<string, Module>();
function moduleOf(file: string): Module {
  const cached = modules.get(file);
  if (cached) return cached;
  const source = parse(file);
  const directives: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    directives.push(statement.expression.text);
  }
  const m: Module = {
    client: directives.includes("use client"),
    imports: new Map(),
    decls: new Map(),
    exports: new Map(),
    reexports: [],
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const target = resolve(file, statement.moduleSpecifier.text);
      if (!clause || clause.isTypeOnly || !target) continue;
      if (clause.name) m.imports.set(clause.name.text, { file: target, name: "default" });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) m.imports.set(bindings.name.text, { file: target, name: "*" });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) {
            m.imports.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
          }
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolve(file, statement.moduleSpecifier.text);
        if (!target) continue;
        if (!clause) m.reexports.push({ file: target, names: "*" });
        else if (ts.isNamedExports(clause)) {
          const names = new Map<string, string>();
          for (const element of clause.elements) {
            if (!element.isTypeOnly) names.set(element.name.text, (element.propertyName ?? element.name).text);
          }
          m.reexports.push({ file: target, names });
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (!element.isTypeOnly) m.exports.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        m.exports.set("default", statement.expression.text);
      } else {
        m.decls.set("default", statement.expression);
        m.exports.set("default", "default");
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? "default";
      m.decls.set(name, statement);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        m.exports.set(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : name, name);
      }
    } else if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (declaration.initializer) m.decls.set(declaration.name.text, declaration.initializer);
        if (exported) m.exports.set(declaration.name.text, declaration.name.text);
      }
    }
  }
  modules.set(file, m);
  return m;
}

/**
 * The declaration an export names, following re-exports. Stops at a
 * "use client" module, which it returns with the export's own name.
 */
function lookup(file: string, name: string, seen = new Set<string>()): { file: string; local: string } | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const m = moduleOf(file);
  if (m.client) return { file, local: name };
  const local = m.exports.get(name);
  if (local !== undefined) {
    if (m.decls.has(local)) return { file, local };
    const imported = m.imports.get(local);
    return imported && imported.name !== "*" ? lookup(imported.file, imported.name, seen) : null;
  }
  for (const reexport of m.reexports) {
    if (reexport.names === "*") {
      const found = name === "default" ? null : lookup(reexport.file, name, seen);
      if (found) return found;
    } else {
      const source = reexport.names.get(name);
      if (source) return lookup(reexport.file, source, seen);
    }
  }
  return null;
}

type Reference = { file: string; name: string; called: boolean };

/** The top-level declarations and the imported exports a node refers to. */
function references(m: Module, node: ts.Node): { locals: Set<string>; imported: Reference[] } {
  const locals = new Set<string>();
  const imported: Reference[] = [];
  const called = (n: ts.Node) => ts.isCallExpression(n.parent) && n.parent.expression === n;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const namespace = m.imports.get(n.expression.text);
      if (namespace?.name === "*") {
        imported.push({ file: namespace.file, name: n.name.text, called: called(n) });
        return;
      }
    }
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === n) ||
        (ts.isPropertyAssignment(parent) && parent.name === n) ||
        ts.isJsxAttribute(parent);
      if (!isName) {
        if (m.decls.has(n.text)) locals.add(n.text);
        const source = m.imports.get(n.text);
        if (source && source.name !== "*") imported.push({ file: source.file, name: source.name, called: called(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { locals, imported };
}

/**
 * Every call from server code to an export of a "use client" module, and the
 * server code reached, as `file#local`.
 */
function serverCalls(roots: string[]): { problems: string[]; reached: Set<string> } {
  const via = new Map<string, string>();
  const queue: { file: string; local: string }[] = [];
  const problems: string[] = [];
  const enqueue = (file: string, local: string, chain: string) => {
    const key = `${relative(file)}#${local}`;
    if (via.has(key)) return;
    via.set(key, chain);
    queue.push({ file, local });
  };
  for (const root of roots) {
    const m = moduleOf(root);
    if (m.client) continue;
    for (const local of m.decls.keys()) enqueue(root, local, `${relative(root)}#${local}`);
  }
  while (queue.length > 0) {
    const { file, local } = queue.shift()!;
    const m = moduleOf(file);
    const chain = via.get(`${relative(file)}#${local}`)!;
    const { locals, imported } = references(m, m.decls.get(local)!);
    for (const name of locals) enqueue(file, name, `${chain} → ${name}`);
    for (const reference of imported) {
      const found = lookup(reference.file, reference.name);
      if (!found) continue;
      if (moduleOf(found.file).client) {
        if (reference.called) {
          problems.push(`${chain} calls ${reference.name}() from ${relative(found.file)}, which is "use client"`);
        }
        continue;
      }
      enqueue(found.file, found.local, `${chain} → ${relative(found.file)}#${found.local}`);
    }
  }
  return { problems, reached: new Set(via.keys()) };
}

describe("server code and \"use client\" modules", () => {
  const roots = segmentFiles(APP);

  it("finds the route segment files", () => {
    expect(roots.length).toBeGreaterThan(50);
    expect(roots.map(relative)).toContain("src/app/(gui)/microgrids/[id]/setup/tenants/[tenantId]/page.tsx");
  });

  it("calls no export of a \"use client\" module from server code", () => {
    expect(serverCalls(roots).problems).toEqual([]);
  });

  it("follows server code into the formatters' string helpers", () => {
    // Server modules such as src/lib/gui/fmt.ts use them; if this fails, the
    // walk lost them, not the app. Revisit if no server code formats money.
    expect(serverCalls(roots).reached).toContain("src/components/format/currency.tsx#formatCurrency");
  });

  it("flags a server component that renders <Kwh> (#194)", () => {
    const fixture = path.join(APP, "__fixture__", "page.tsx");
    parsed.set(
      fixture,
      ts.createSourceFile(
        fixture,
        `import { Kwh } from "@/components/format/kwh";
         export default function Page() { return <Kwh value={1} />; }`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    );
    const { problems } = serverCalls([fixture]);
    expect(problems).toEqual([
      'src/app/__fixture__/page.tsx#Page → src/components/format/kwh.tsx#Kwh calls useLocale() from src/components/format/locale-context.tsx, which is "use client"',
    ]);
  });
});
