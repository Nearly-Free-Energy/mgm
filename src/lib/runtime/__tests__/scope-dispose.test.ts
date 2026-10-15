/**
 * Request scopes must be disposed (docs/cordis-runtime.md § "Two lifetimes").
 *
 * A composed scope that is never disposed stays registered on the root for
 * the life of the process, together with the caller's Supabase client. Every
 * caller disposes in `finally` today; this test keeps it that way:
 *
 *   1. every `compose*` call outside the composer modules binds its result to
 *      a `const` and disposes it in a `finally` block that the statements right
 *      after it enter unconditionally (past `if (!c.ok) return` guards);
 *   2. only the composer modules call the low-level `openOrganizationScope`,
 *      which hands ownership of `dispose` to its caller.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const SRC = path.resolve(__dirname, "..", "..", "..");

/** Every function that returns a composition the caller must dispose. */
const COMPOSERS = new Set([
  "composeCommunityManagement",
  "composeMetering",
  "composeBilling",
  "composeBillingReview",
  "composePayments",
  "composePaymentsPublic",
]);

/** The modules that define composers; they may open scopes directly. */
const SCOPE_OPENERS = new Set(
  [
    "lib/runtime/scope.ts",
    "lib/community-management/compose.ts",
    "lib/metering/compose.ts",
    "lib/billing/compose.ts",
    "lib/payments/compose.ts",
    "lib/cordis/billing-review.ts",
  ].map((file) => path.join(SRC, file))
);

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** True if `block` calls `<name>.dispose()` or `<name>.data.dispose()`. */
function disposes(block: ts.Block, name: string, file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "dispose"
    ) {
      const target = node.expression.expression.getText(file);
      if (target === name || target === `${name}.data`) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  return found;
}

/** `const <name> = await <composer>(...)` → name; anything else → null. */
function boundName(call: ts.CallExpression): string | null {
  const awaited = call.parent;
  if (!awaited || !ts.isAwaitExpression(awaited)) return null;
  const declaration = awaited.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
  return declaration.name.text;
}

/** `if (!<name>.ok) return/throw/continue/break;` (or a block ending in one), no else. */
function isNotOkExit(statement: ts.Statement, name: string, file: ts.SourceFile): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  if (statement.expression.getText(file).replace(/\s/g, "") !== `!${name}.ok`) return false;
  const exit = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements[statement.thenStatement.statements.length - 1]
    : statement.thenStatement;
  return (
    !!exit &&
    (ts.isReturnStatement(exit) || ts.isThrowStatement(exit) || ts.isContinueStatement(exit) || ts.isBreakStatement(exit))
  );
}

/**
 * True if `statements` reach a `try` whose `finally` disposes `name` before
 * running anything else: only `if (!name.ok) return` guards may come first,
 * or the `try` may open an `if (name.ok) { … }` block. A `finally` that is
 * reached conditionally, or only after other code that could throw, does not
 * count — the scope would leak on that path.
 */
function protectedFromStart(statements: readonly ts.Statement[], name: string, file: ts.SourceFile): boolean {
  for (const statement of statements) {
    if (ts.isTryStatement(statement)) return !!statement.finallyBlock && disposes(statement.finallyBlock, name, file);
    if (isNotOkExit(statement, name, file)) continue;
    if (
      ts.isIfStatement(statement) &&
      !statement.elseStatement &&
      statement.expression.getText(file).replace(/\s/g, "") === `${name}.ok` &&
      ts.isBlock(statement.thenStatement)
    ) {
      return protectedFromStart(statement.thenStatement.statements, name, file);
    }
    return false;
  }
  return false;
}

function undisposedCompositions(source: string, fileName = "file.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && COMPOSERS.has(node.expression.text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      const where = `${fileName}:${line + 1} ${node.expression.text}`;
      const name = boundName(node);
      // const c = await compose…(…) → its VariableStatement, which must sit
      // directly in a block so the statements after it can be checked.
      const statement = name ? node.parent.parent.parent.parent : undefined;
      let ok = false;
      if (name && statement && ts.isVariableStatement(statement) && ts.isBlock(statement.parent)) {
        const siblings = statement.parent.statements;
        ok = protectedFromStart(siblings.slice(siblings.indexOf(statement) + 1), name, file);
      }
      if (!ok) offenders.push(where);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
}

const sources = collectSources(SRC);

describe("request scope disposal", () => {
  it("recognises the disposal shapes callers use", () => {
    const ok = [
      "async function a() { const c = await composeBilling(o); if (!c.ok) return; try { use(c); } finally { await c.data.dispose(); } }",
      "async function a() { const c = await composeBillingReview(o); try { use(c); } finally { await c.dispose(); } }",
      "async function a() { const c = await composePaymentsPublic(o); if (c.ok) { try { use(c); } finally { await c.data.dispose().catch(() => {}); } } }",
      "async function a() { const c = await composeBilling(o); if (!c.ok) { log(c); return respond(c); } try { use(c); } finally { await c.data.dispose(); } }",
    ];
    for (const source of ok) expect(undisposedCompositions(source)).toEqual([]);

    const bad = [
      "async function a() { const c = await composeBilling(o); use(c); }",
      "async function a() { const c = await composeBilling(o); try { use(c); } catch { await c.data.dispose(); } }",
      "async function a() { const c = await composeBilling(o); try { use(c); } finally { await other.data.dispose(); } }",
      "async function a() { let c = await composeBilling(o); try { use(c); } finally { await c.data.dispose(); } }",
      "async function a() { return composeBilling(o); }",
      "async function a() { const c = await composeBilling(o); const f = async () => { try {} finally { await c.data.dispose(); } }; }",
      // The finally is reached only on some paths, or after code that can throw.
      "async function a() { const c = await composeBilling(o); if (run) { try { use(c); } finally { await c.data.dispose(); } } }",
      "async function a() { const c = await composeBilling(o); prepare(); try { use(c); } finally { await c.data.dispose(); } }",
      "async function a() { const c = await composeBilling(o); if (!c.ok) log(c); try { use(c); } finally { await c.data.dispose(); } }",
      "async function a() { const c = await composeBilling(o); if (c.ok) { prepare(); try { use(c); } finally { await c.data.dispose(); } } }",
    ];
    for (const source of bad) expect(undisposedCompositions(source)).toHaveLength(1);
  });

  it("finds the composer call sites", () => {
    const callers = sources.filter((file) => /\bcompose(?:CommunityManagement|Metering|Billing|BillingReview|Payments|PaymentsPublic)\(/.test(readFileSync(file, "utf8")));
    expect(callers.length).toBeGreaterThan(20);
  });

  it("disposes every composition in a finally block", () => {
    const offenders = sources
      .filter((file) => !SCOPE_OPENERS.has(file))
      .flatMap((file) => undisposedCompositions(readFileSync(file, "utf8"), path.relative(SRC, file)));
    expect(
      offenders,
      "Bind the composition to a const and call `<name>.data.dispose()` (or `<name>.dispose()`) in a finally block"
    ).toEqual([]);
  });

  it("opens scopes directly only in the composer modules", () => {
    const openers = sources
      .filter((file) => /\bopenOrganizationScope\(/.test(readFileSync(file, "utf8")))
      .filter((file) => !SCOPE_OPENERS.has(file))
      .map((file) => path.relative(SRC, file));
    expect(openers, "Compose a capability instead of opening a request scope directly").toEqual([]);
  });
});
