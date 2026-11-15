/**
 * Each billing route that has a body schema parses with it: the route file
 * imports the schema from @/lib/billing/schemas, and the handler for the
 * method calls parseJsonBody(<its request parameter>, <schema>).
 *
 * The pairs are listed by hand until a guard derives them from the GUI
 * surface's contributed actions; when that guard covers these two routes,
 * delete this file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../../../..");

const PAIRS: [route: string, method: string, schema: string][] = [
  ["src/app/api/microgrids/[id]/grid-tariffs/route.ts", "POST", "AddGridTariffBody"],
  ["src/app/api/microgrids/[id]/savings-settings/route.ts", "PUT", "SaveSavingsSettingsBody"],
];

/** Why `source` does not parse its `method` body with `schema`, or null when it does. */
function parsesWith(source: string, method: string, schema: string): string | null {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
  const imported = (module: string, name: string) =>
    file.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === module &&
        !s.importClause?.isTypeOnly &&
        !!s.importClause?.namedBindings &&
        ts.isNamedImports(s.importClause.namedBindings) &&
        s.importClause.namedBindings.elements.some(
          (e) => !e.isTypeOnly && e.name.text === name && !e.propertyName
        )
    );
  if (!imported("@/lib/billing/schemas", schema)) return `does not import ${schema} from @/lib/billing/schemas`;
  if (!imported("@/lib/validation/parse-body", "parseJsonBody")) return "does not import parseJsonBody";

  const handler = file.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) &&
      s.name?.text === method &&
      !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
  if (!handler?.body) return `has no exported ${method} function`;
  const requestParam = handler.parameters[0]?.name;
  if (!requestParam || !ts.isIdentifier(requestParam)) return `${method} has no request parameter`;

  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "parseJsonBody" &&
      node.arguments.length === 2 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === requestParam.text &&
      ts.isIdentifier(node.arguments[1]) &&
      node.arguments[1].text === schema
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(handler.body);
  return found ? null : `${method} does not call parseJsonBody(${requestParam.text}, ${schema})`;
}

describe("billing routes parse their bodies with the shared schemas", () => {
  it.each(PAIRS)("%s %s parses with %s", (route, method, schema) => {
    const source = readFileSync(path.join(ROOT, route), "utf8");
    expect(parsesWith(source, method, schema)).toBeNull();
  });

  it("refuses a route that does not", () => {
    const good = `
      import { X } from "@/lib/billing/schemas";
      import { parseJsonBody } from "@/lib/validation/parse-body";
      export async function POST(req: Request) { const p = await parseJsonBody(req, X); }`;
    expect(parsesWith(good, "POST", "X")).toBeNull();
    expect(parsesWith(good, "PUT", "X")).toMatch(/no exported PUT/);
    expect(parsesWith(good.replace("@/lib/billing/schemas", "./schemas"), "POST", "X")).toMatch(/does not import X/);
    expect(parsesWith(good.replace("import { X }", "import type { X }"), "POST", "X")).toMatch(/does not import X/);
    expect(parsesWith(good.replace("import { X }", "import { Y as X }"), "POST", "X")).toMatch(/does not import X/);
    const elsewhere = good.replace(
      "export async function POST(req: Request) { const p = await parseJsonBody(req, X); }",
      "function helper(req: Request) { return parseJsonBody(req, X); }\n      export async function POST(req: Request) {}"
    );
    expect(elsewhere).toContain("function helper");
    expect(parsesWith(elsewhere, "POST", "X")).toMatch(/does not call/);
    expect(parsesWith(good.replace("parseJsonBody(req, X)", "parseJsonBody(other, X)"), "POST", "X")).toMatch(/does not call/);
    expect(parsesWith(good.replace("parseJsonBody(req, X)", "X.parse(await req.json())"), "POST", "X")).toMatch(/does not call/);
  });
});
