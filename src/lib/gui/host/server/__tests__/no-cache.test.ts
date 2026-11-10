/**
 * Nothing the GUI host serves outlives its request: each answer is for one
 * person in one organization at one moment. This scans the host
 * (src/lib/gui/host/) and its routes (src/app/api/gui/) for framework
 * caching, module-level state that could carry request data, and the service
 * role, which no host code needs: every read is on the caller's own session.
 * It also checks that each host context gets a new client per read
 * (createClient), and that only snapshot.ts reads the surface registry.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../../../../..");
const ROOTS = ["src/lib/gui/host", "src/app/api/gui"];

/** Framework caching, by name. React's cache() is per request and is not here. */
const CACHING = /\b(?:unstable_cache|cacheLife|cacheTag|revalidate\w*|fetchCache)\b|["']use cache["']/;
const SERVICE_ROLE = /@\/lib\/supabase\/service|\bcreateServiceClient\b/;

/**
 * Module-level collections allowed in host code: caches keyed by definitions
 * (view definitions and zod schemas), which hold no request data.
 */
const ALLOWED_STATE = new Set([
  "src/lib/gui/host/server/parse.ts namesCache",
  "src/lib/gui/host/server/parse.ts compiled",
  "src/lib/gui/host/server/merge.ts writeOnlyCache",
]);

function files(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : files(rel);
    return /\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

/**
 * Top-level variables that start as a mutable collection: any Map, WeakMap
 * or WeakSet, or an empty Set. A Set built from a fixed list is a constant.
 */
function moduleState(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      const init = d.initializer;
      if (!init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression)) continue;
      const kind = init.expression.text;
      const mutable = ["Map", "WeakMap", "WeakSet"].includes(kind) || (kind === "Set" && !init.arguments?.length);
      if (mutable) found.push(`${file} ${d.name.getText(source)}`);
    }
  }
  return found;
}

/**
 * hostContext calls whose `newClient` is not createClient imported from
 * @/lib/supabase/server: a context on any other factory could share the
 * client the session was checked on, or reach past the caller's session.
 */
function clientFactoryProblems(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const importsCreateClient = source.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === "@/lib/supabase/server" &&
      s.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some((e) => e.name.text === "createClient" && !e.propertyName),
  );
  const problems: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "hostContext") {
      const deps = node.arguments[2];
      const factory =
        deps && ts.isObjectLiteralExpression(deps)
          ? deps.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "newClient")
          : undefined;
      const ok = factory && ts.isPropertyAssignment(factory) && ts.isIdentifier(factory.initializer) && factory.initializer.text === "createClient";
      if (!ok || !importsCreateClient) problems.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

const sources = ROOTS.flatMap(files).map((file) => ({ file, text: readFileSync(path.join(REPO, file), "utf8") }));

describe("the GUI host keeps nothing between requests", () => {
  it("reads the host and its routes", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["src/lib/gui/host/server/view.ts", "src/app/api/gui/view/route.ts"]),
    );
  });

  it("uses no framework caching", () => {
    expect(sources.filter((s) => CACHING.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it("holds no module-level collection except definition caches", () => {
    expect(sources.flatMap((s) => moduleState(s.file, s.text)).filter((n) => !ALLOWED_STATE.has(n))).toEqual([]);
  });

  it("never reaches the service role", () => {
    expect(sources.filter((s) => SERVICE_ROLE.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it("renders every route per request", () => {
    const routes = sources.filter((s) => s.file.endsWith("/route.ts"));
    expect(routes.filter((s) => !/^export const dynamic = "force-dynamic";$/m.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it("gives every host context createClient as its client factory", () => {
    const calls = sources.filter((s) => /\bhostContext\(/.test(s.text) && !s.file.endsWith("/access.ts"));
    expect(calls.map((s) => s.file)).toEqual(expect.arrayContaining(["src/lib/gui/host/server/http.ts"]));
    expect(sources.flatMap((s) => clientFactoryProblems(s.file, s.text))).toEqual([]);
  });

  it("reads the surface registry only through snapshot.ts", () => {
    const readers = sources.filter((s) => /\bmgmSurface\b/.test(s.text)).map((s) => s.file);
    expect(readers).toEqual(["src/lib/gui/host/server/snapshot.ts"]);
  });

  it("finds a host context on another client factory", () => {
    const imp = 'import { createClient } from "@/lib/supabase/server";\n';
    expect(clientFactoryProblems("a.ts", `${imp}hostContext(a, h, { newClient: createClient, makeFmt });`)).toEqual([]);
    expect(clientFactoryProblems("b.ts", `${imp}hostContext(a, h, { newClient: async () => supabase });`)).toEqual(["b.ts:2"]);
    expect(clientFactoryProblems("c.ts", "hostContext(a, h, { newClient: createClient });")).toEqual(["c.ts:1"]);
    expect(clientFactoryProblems("d.ts", `${imp}hostContext(a, h, deps);`)).toEqual(["d.ts:2"]);
  });

  it("finds module-level state the rule is about", () => {
    const text = 'const a = new Map();\nconst b = new Set();\nconst c = new Set(["x"]);\nfunction f() { const d = new Map(); }';
    expect(moduleState("x.ts", text)).toEqual(["x.ts a", "x.ts b"]);
  });
});
