/**
 * Request scopes must be disposed (docs/cordis-runtime.md § "Lifetime notes").
 *
 * A composed scope that is never disposed stays registered on the root for
 * the life of the process, together with the caller's Supabase client. Every
 * caller disposes in `finally` today; this test keeps it that way:
 *
 *   1. every composer call outside the composer modules binds its result to a
 *      `const`, and the statements right after it (past `if (!c.ok) return`
 *      guards) enter a `try` whose `finally` disposes that const as its first
 *      statement, unconditionally, in a function that is not a generator (an
 *      abandoned generator never runs its `finally`);
 *   2. a composer is referenced only as the callee of such a call, so no call
 *      escapes rule 1: it is not stored, passed, re-exported or loaded with a
 *      dynamic `import()` or `require()`, and no module load computes its
 *      specifier;
 *   3. only the composer modules bind the low-level `openOrganizationScope`,
 *      which hands ownership of `dispose` to its caller.
 *
 * Names are resolved through each file's import declarations, renamed and
 * namespace imports included, and through the barrels that re-export them,
 * so importing under another name does not get past either rule.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const SRC = path.resolve(__dirname, "..", "..", "..");
const inSrc = (file: string) => path.join(SRC, file);

type Tracked = { kind: "composer" | "opener"; name: string };
type Offense = { kind: "undisposed" | "escapes" | "opens"; at: string };

/**
 * Every function that returns a composition the caller must dispose, by the
 * module that defines it. A new composer module goes here: until it does, its
 * own `openOrganizationScope` binding fails rule 3.
 */
const COMPOSER_MODULES = new Map<string, readonly string[]>([
  [inSrc("lib/community-management/compose.ts"), ["composeCommunityManagement"]],
  [inSrc("lib/metering/compose.ts"), ["composeMetering"]],
  [inSrc("lib/billing/compose.ts"), ["composeBilling"]],
  [inSrc("lib/payments/compose.ts"), ["composePayments", "composePaymentsPublic"]],
  [inSrc("lib/cordis/billing-review.ts"), ["composeBillingReview"]],
]);

const OPENER = "openOrganizationScope";
const OPENER_MODULE = inSrc("lib/runtime/scope.ts");

/** The modules that may open scopes directly: the opener's own and the composers'. */
const SCOPE_OPENERS = new Set([OPENER_MODULE, ...COMPOSER_MODULES.keys()]);

/**
 * Barrels that may re-export a composer or the opener, by what they may
 * re-export. Resolution follows the re-export, so their importers are still
 * checked. A namespace re-export (`export * as ns`) is never allowed: it is
 * not followed.
 */
const BARRELS = new Map<string, Tracked["kind"]>([
  [inSrc("lib/community-management/index.ts"), "composer"],
  [inSrc("lib/runtime/index.ts"), "opener"],
]);

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (EXTENSIONS.includes(path.extname(entry)) && !/\.(test|spec)\.[jt]sx?$/.test(entry)) out.push(full);
  }
  return out;
}

const parsed = new Map<string, ts.SourceFile>();

/** `text` parses a source that is not on disk (the shape cases); otherwise the file is read and cached. */
function parse(file: string, text?: string): ts.SourceFile {
  if (text !== undefined) return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, source);
  }
  return source;
}

/**
 * The file an import specifier names, or null for a package. `@/` is the
 * `paths` alias tsconfig.json maps to src/; if that mapping changes, change
 * it here too, or every `@/` import stops resolving and the rules see nothing.
 */
function resolveModule(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = inSrc(specifier.slice(2));
  else if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(from), specifier);
  } else return null;
  const stem = base.replace(/\.jsx?$/, "");
  const candidates = [base, ...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`))];
  return candidates.find((file) => existsSync(file) && statSync(file).isFile()) ?? null;
}

function resolveSpecifier(specifier: ts.Expression | undefined, from: string): string | null {
  return specifier && ts.isStringLiteralLike(specifier) ? resolveModule(specifier.text, from) : null;
}

const exportCache = new Map<string, Map<string, Tracked>>();

/**
 * What a module exports that the rules track, by exported name: its own
 * definitions plus what its `export … from`, `export { local }` and
 * `export default local` declarations pass on.
 */
function exportsOf(file: string, visiting = new Set<string>()): Map<string, Tracked> {
  const cached = exportCache.get(file);
  if (cached) return cached;
  const exported = new Map<string, Tracked>();
  if (visiting.has(file)) return exported;
  // `visiting` is the current resolution path: a module already on it (an
  // import cycle) reads as exporting nothing, so only a result computed from
  // the top is complete.
  const complete = visiting.size === 0;
  visiting.add(file);
  for (const name of COMPOSER_MODULES.get(file) ?? []) exported.set(name, { kind: "composer", name });
  if (file === OPENER_MODULE) exported.set(OPENER, { kind: "opener", name: OPENER });

  const source = parse(file);
  // A local name is this module's own composer or opener, or whatever the
  // import that binds it resolves to.
  const imported = (local: string): Tracked | undefined => {
    if (COMPOSER_MODULES.get(file)?.includes(local)) return { kind: "composer", name: local };
    if (file === OPENER_MODULE && local === OPENER) return { kind: "opener", name: OPENER };
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const element = bindings.elements.find((candidate) => candidate.name.text === local);
      const target = element && resolveSpecifier(statement.moduleSpecifier, file);
      if (element && target) return exportsOf(target, visiting).get((element.propertyName ?? element.name).text);
    }
    return undefined;
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (statement.moduleSpecifier) {
        const target = resolveSpecifier(statement.moduleSpecifier, file);
        const from = target ? exportsOf(target, visiting) : new Map<string, Tracked>();
        if (!clause) {
          for (const [name, tracked] of from) if (name !== "default") exported.set(name, tracked);
        } else if (ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            const tracked = element.isTypeOnly ? undefined : from.get((element.propertyName ?? element.name).text);
            if (tracked) exported.set(element.name.text, tracked);
          }
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const tracked = element.isTypeOnly ? undefined : imported((element.propertyName ?? element.name).text);
          if (tracked) exported.set(element.name.text, tracked);
        }
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const tracked = imported(statement.expression.text);
      if (tracked) exported.set("default", tracked);
    } else if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      // export default function composeX(…)
      const tracked = imported(statement.name.text);
      if (tracked) exported.set("default", tracked);
    }
  }
  visiting.delete(file);
  if (complete) exportCache.set(file, exported);
  return exported;
}

function isName(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

/** `<name>.ok`, without optional chaining. */
function isOk(node: ts.Expression, name: string): boolean {
  return ts.isPropertyAccessExpression(node) && !node.questionDotToken && node.name.text === "ok" && isName(node.expression, name);
}

/** `<anything>.<method>(…)`, without optional chaining. */
function isMethodCall(
  node: ts.Expression,
  method: string
): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return (
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    ts.isPropertyAccessExpression(node.expression) &&
    !node.expression.questionDotToken &&
    node.expression.name.text === method
  );
}

/** True if `statements` declare `name` at their own level, shadowing it for the whole block. */
function declares(statements: readonly ts.Statement[], name: string): boolean {
  const binds = (binding: ts.BindingName): boolean =>
    ts.isIdentifier(binding)
      ? binding.text === name
      : binding.elements.some((element) => !ts.isOmittedExpression(element) && binds(element.name));
  return statements.some((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.some((declaration) => binds(declaration.name))
      : (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name
  );
}

/**
 * True if the first statement of `block` is `[await] <name>.dispose()` or
 * `[await] <name>.data.dispose()`, optionally followed by `.catch(…)`, and
 * the block does not redeclare `name`. Code before it, a condition or `&&`
 * around it, or a function wrapping it can each skip the dispose, so nothing
 * else is accepted and nothing nested is searched.
 */
function disposesFirst(block: ts.Block, name: string): boolean {
  const [first] = block.statements;
  if (!first || !ts.isExpressionStatement(first) || declares(block.statements, name)) return false;
  let expression: ts.Expression = first.expression;
  if (ts.isAwaitExpression(expression)) expression = expression.expression;
  if (isMethodCall(expression, "catch")) expression = expression.expression.expression;
  if (!isMethodCall(expression, "dispose") || expression.arguments.length > 0) return false;
  const target = expression.expression.expression;
  return (
    isName(target, name) ||
    (ts.isPropertyAccessExpression(target) &&
      !target.questionDotToken &&
      target.name.text === "data" &&
      isName(target.expression, name))
  );
}

/** `const <name> = await <composer>(…)`, alone in its declaration → name; anything else → null. */
function boundName(call: ts.CallExpression): string | null {
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited)) return null;
  const declaration = awaited.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return null;
  return list.declarations.length === 1 ? declaration.name.text : null;
}

/** `if (!<name>.ok) return/throw/continue/break;` (or a block ending in one), no else. */
function isNotOkExit(statement: ts.Statement, name: string): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const condition = statement.expression;
  if (
    !ts.isPrefixUnaryExpression(condition) ||
    condition.operator !== ts.SyntaxKind.ExclamationToken ||
    !isOk(condition.operand, name)
  ) {
    return false;
  }
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
function protectedFromStart(statements: readonly ts.Statement[], name: string): boolean {
  for (const statement of statements) {
    if (ts.isTryStatement(statement)) return !!statement.finallyBlock && disposesFirst(statement.finallyBlock, name);
    if (isNotOkExit(statement, name)) continue;
    if (
      ts.isIfStatement(statement) &&
      !statement.elseStatement &&
      isOk(statement.expression, name) &&
      ts.isBlock(statement.thenStatement) &&
      !declares(statement.thenStatement.statements, name)
    ) {
      return protectedFromStart(statement.thenStatement.statements, name);
    }
    return false;
  }
  return false;
}

/**
 * True if the nearest function around `node` is a generator. Its `finally`
 * runs only if its consumer finishes it or calls `return()`; one abandoned at
 * a `yield` never disposes.
 */
function inGenerator(node: ts.Node): boolean {
  const fn = ts.findAncestor(node, ts.isFunctionLike);
  return !!fn && "asteriskToken" in fn && !!fn.asteriskToken;
}

/** True if the composer `call` is bound and then disposed on every path, per the rules above. */
function disposedAfter(call: ts.CallExpression): boolean {
  const name = boundName(call);
  // const c = await compose…(…) → its VariableStatement, which must sit
  // directly in a block so the statements after it can be checked.
  const statement = name ? call.parent.parent.parent.parent : undefined;
  if (!name || !statement || !ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return false;
  if (inGenerator(call)) return false;
  const siblings = statement.parent.statements;
  return protectedFromStart(siblings.slice(siblings.indexOf(statement) + 1), name);
}

/** False for an identifier that names a property, key or label rather than a binding in scope. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isQualifiedName(parent)) return parent.left === node;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent)) return parent.propertyName !== node;
  if (ts.isExportSpecifier(parent)) return !parent.propertyName || parent.propertyName === node;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return parent.label !== node;
  return true;
}

/** `import(…)` or `require(…)`. */
function isModuleLoad(call: ts.CallExpression): boolean {
  return call.expression.kind === ts.SyntaxKind.ImportKeyword || isName(call.expression, "require");
}

/**
 * Applies the three rules to one file. `calls` counts the composer calls it
 * resolved, whatever their local names.
 */
function analyze(text: string, file: string): { calls: number; offenses: Offense[] } {
  const source = parse(file, text);
  const offenses: Offense[] = [];
  let calls = 0;
  const report = (kind: Offense["kind"], node: ts.Node, detail: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    offenses.push({ kind, at: `${path.relative(SRC, file)}:${line + 1} ${detail}` });
  };

  // Local names bound to a composer, and namespace objects of modules that
  // export a composer or the opener.
  const composers = new Map<string, Tracked>();
  const namespaces = new Map<string, Map<string, Tracked>>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const target = clause && !clause.isTypeOnly ? resolveSpecifier(statement.moduleSpecifier, file) : null;
      const exported = target ? exportsOf(target) : undefined;
      if (!clause || !exported?.size) continue;
      const bind = (local: ts.Identifier, tracked: Tracked | undefined) => {
        if (tracked?.kind === "opener") report("opens", local, `binds ${OPENER} as ${local.text}`);
        else if (tracked) composers.set(local.text, tracked);
      };
      if (clause.name) bind(clause.name, exported.get("default"));
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, exported);
      else {
        for (const element of bindings?.elements ?? []) {
          if (!element.isTypeOnly) bind(element.name, exported.get((element.propertyName ?? element.name).text));
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      // import ns = require("…")
      const target = resolveSpecifier(statement.moduleReference.expression, file);
      const exported = target ? exportsOf(target) : undefined;
      if (exported?.size) namespaces.set(statement.name.text, exported);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      const target = resolveSpecifier(statement.moduleSpecifier, file);
      const exported = target ? exportsOf(target) : new Map<string, Tracked>();
      const clause = statement.exportClause;
      const passed =
        clause && ts.isNamedExports(clause)
          ? clause.elements.map((element) =>
              element.isTypeOnly ? undefined : exported.get((element.propertyName ?? element.name).text)
            )
          : [...exported].filter(([name]) => clause || name !== "default").map(([, tracked]) => tracked);
      for (const tracked of passed) {
        if (!tracked) continue;
        if (BARRELS.get(file) === tracked.kind && !(clause && ts.isNamespaceExport(clause))) continue;
        report(tracked.kind === "opener" ? "opens" : "escapes", statement, `re-exports ${tracked.name}`);
      }
    }
  }

  // A composer reached through `reference` (a local name, or `ns.<member>`)
  // may be called, checked for disposal, or named in a `typeof`.
  const checkComposerUse = (reference: ts.Expression, tracked: Tracked) => {
    const parent = reference.parent;
    if (ts.isCallExpression(parent) && parent.expression === reference) {
      calls++;
      if (!disposedAfter(parent)) {
        const detail = inGenerator(parent)
          ? "is called in a generator, whose finally does not run if its consumer abandons it"
          : "is not bound to a const and disposed first in a finally";
        report("undisposed", parent, `${reference.getText(source)}(…) ${detail}`);
      }
    } else if (!ts.isTypeQueryNode(parent)) {
      report("escapes", reference, `${tracked.name} is referenced other than by calling it`);
    }
  };

  // A namespace object may only be read one member at a time (`ns.<member>`,
  // or `ns.<Type>` in a type); anything else could hand on a composer unseen.
  const checkNamespaceUse = (namespace: ts.Identifier, members: Map<string, Tracked>) => {
    const parent = namespace.parent;
    if (ts.isPropertyAccessExpression(parent)) {
      const tracked = members.get(parent.name.text);
      if (tracked?.kind === "opener") report("opens", parent, `uses ${namespace.text}.${OPENER}`);
      else if (tracked) checkComposerUse(parent, tracked);
    } else if (ts.isQualifiedName(parent)) {
      // A type names `ns.<member>` harmlessly; `import x = ns.<member>` binds it.
      const tracked = members.get(parent.right.text);
      if (tracked?.kind === "opener") report("opens", parent, `uses ${namespace.text}.${OPENER}`);
      else if (tracked && ts.isImportEqualsDeclaration(parent.parent)) {
        report("escapes", parent, `${tracked.name} is referenced other than by calling it`);
      }
    } else if (!ts.isTypeQueryNode(parent)) {
      report("escapes", namespace, `namespace ${namespace.text} is used other than as ${namespace.text}.<member>`);
    }
  };

  const visit = (node: ts.Node): void => {
    // Import bindings were read above; `export … from` names belong to the other module.
    if (ts.isImportDeclaration(node)) return;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;
    if (ts.isCallExpression(node) && isModuleLoad(node)) {
      const [specifier] = node.arguments;
      // What a computed specifier loads cannot be resolved here, so it may be a composer module.
      if (!specifier || !ts.isStringLiteralLike(specifier)) report("escapes", node, "loads a module with a non-literal specifier");
      const target = resolveSpecifier(specifier, file);
      const exported = target ? [...exportsOf(target).values()] : [];
      if (exported.length > 0) {
        const kind = exported.some((tracked) => tracked.kind === "composer") ? "escapes" : "opens";
        report(kind, node, `loads ${specifier.getText(source)} dynamically`);
      }
    }
    if (ts.isIdentifier(node) && isReference(node)) {
      const composer = composers.get(node.text);
      if (composer) checkComposerUse(node, composer);
      const members = namespaces.get(node.text);
      if (members) checkNamespaceUse(node, members);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, offenses };
}

/**
 * The names a module exports by declaring them: exported function declarations
 * and `export const|let` declarators, since a composer can be written either way.
 */
function declaredExports(file: string): string[] {
  return parse(file).statements.flatMap((statement) => {
    if (!ts.canHaveModifiers(statement)) return [];
    if (!ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.isFunctionDeclaration(statement)) return [statement.name?.text ?? ""];
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
    );
  });
}

/** Runs `check` as if the real `file` read `edit(its text)`, then restores it. */
function withSource<T>(file: string, edit: (text: string) => string, check: () => T): T {
  const real = parse(file);
  parsed.set(file, parse(file, edit(real.text)));
  exportCache.clear();
  try {
    return check();
  } finally {
    parsed.set(file, real);
    exportCache.clear();
  }
}

/** A hypothetical route: the shape cases resolve their imports from here, against the real modules. */
const ROUTE = inSrc("app/api/example/route.ts");

/** The composer calls `analyze` resolved and the kinds of offense it reported. */
function outcome(text: string, file = ROUTE): { calls: number; kinds: Offense["kind"][] } {
  const { calls, offenses } = analyze(text, file);
  return { calls, kinds: offenses.map((offense) => offense.kind) };
}

const BILLING = 'import { composeBilling } from "@/lib/billing/compose";';

const callers = collectSources(SRC).filter((file) => !SCOPE_OPENERS.has(file));
const reports = callers.map((file) => analyze(readFileSync(file, "utf8"), file));
const offenses = reports.flatMap((report) => report.offenses);

describe("request scope disposal", () => {
  it("knows where each composer and the opener are defined", () => {
    for (const [file, names] of COMPOSER_MODULES) {
      // A composer renamed or added under the compose* prefix must be listed,
      // or its callers resolve to nothing and are never checked.
      expect(declaredExports(file).filter((name) => /^compose[A-Z]/.test(name)).sort(), file).toEqual([...names].sort());
    }
    expect(declaredExports(OPENER_MODULE)).toContain(OPENER);
    // Resolution through the barrels: if one stops re-exporting, drop it from BARRELS.
    expect(exportsOf(inSrc("lib/community-management/index.ts")).get("composeCommunityManagement")?.kind).toBe("composer");
    expect(exportsOf(inSrc("lib/runtime/index.ts")).get(OPENER)?.kind).toBe("opener");
  });

  it("recognises the disposal shapes callers use", () => {
    const ok = [
      `${BILLING} async function a() { const c = await composeBilling(o); if (!c.ok) return; try { use(c); } finally { await c.data.dispose(); } }`,
      'import { composeBillingReview } from "@/lib/cordis/billing-review"; async function a() { const c = await composeBillingReview(o); try { use(c); } finally { await c.dispose(); } }',
      'import { composePaymentsPublic } from "@/lib/payments/compose"; async function a() { const c = await composePaymentsPublic(o); if (c.ok) { try { use(c); } finally { await c.data.dispose().catch(() => {}); } } }',
      `${BILLING} async function a() { const c = await composeBilling(o); if (!c.ok) { log(c); return respond(c); } try { use(c); } finally { await c.data.dispose(); } }`,
      // The nearest function is what counts: this one runs to completion.
      `${BILLING} async function* g() { yield async () => { const c = await composeBilling(o); try { use(c); } finally { await c.data.dispose(); } }; }`,
    ];
    for (const source of ok) expect(analyze(source, ROUTE), source).toEqual({ calls: 1, offenses: [] });

    const bad = [
      `${BILLING} async function a() { const c = await composeBilling(o); use(c); }`,
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } catch { await c.data.dispose(); } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } finally { await other.data.dispose(); } }`,
      `${BILLING} async function a() { let c = await composeBilling(o); try { use(c); } finally { await c.data.dispose(); } }`,
      `${BILLING} async function a() { return composeBilling(o); }`,
      `${BILLING} async function a() { const c = await composeBilling(o); const f = async () => { try {} finally { await c.data.dispose(); } }; }`,
      `${BILLING} async function a() { const c = await composeBilling(o), d = prepare(); try { use(c); } finally { await c.data.dispose(); } }`,
      // The finally is reached only on some paths, or after code that can throw.
      `${BILLING} async function a() { const c = await composeBilling(o); if (run) { try { use(c); } finally { await c.data.dispose(); } } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); prepare(); try { use(c); } finally { await c.data.dispose(); } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); if (!c.ok) log(c); try { use(c); } finally { await c.data.dispose(); } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); if (c.ok) { prepare(); try { use(c); } finally { await c.data.dispose(); } } }`,
      // The finally does not run the dispose first, or not unconditionally.
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } finally { const f = () => c.data.dispose(); } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } finally { if (debug) await c.data.dispose(); } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } finally { flag && c.data.dispose(); } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } finally { await audit(); await c.data.dispose(); } }`,
      // The dispose names a different binding than the composition.
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } finally { const c = other; await c.data.dispose(); } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); try { use(c); } finally { await c.data.dispose(); const c = other; } }`,
      `${BILLING} async function a() { const c = await composeBilling(o); if (c.ok) { try { use(c); } finally { await c.data.dispose(); } const c = other; } }`,
      // A generator abandoned at a yield never runs its finally.
      `${BILLING} async function* a() { const c = await composeBilling(o); if (!c.ok) return; try { yield c; } finally { await c.data.dispose(); } }`,
      `${BILLING} class A { async *m() { const c = await composeBilling(o); try { yield c; } finally { await c.data.dispose(); } } }`,
    ];
    for (const source of bad) expect(analyze(source, ROUTE).offenses, source).toHaveLength(1);
  });

  it("resolves composers and the opener however they are imported", () => {
    const ok: { source: string; file?: string; calls: number }[] = [
      {
        source:
          'import { composeBilling as cb } from "@/lib/billing/compose"; async function a() { const c = await cb(o); if (!c.ok) return; try { use(c); } finally { await c.data.dispose(); } }',
        calls: 1,
      },
      {
        source:
          'import * as billing from "@/lib/billing/compose"; let t: billing.BillingComposition; async function a() { const c = await billing.composeBilling(o); if (!c.ok) return; try { use(c); } finally { await c.data.dispose(); } }',
        calls: 1,
      },
      {
        source:
          'import { composeCommunityManagement } from "@/lib/community-management"; async function a() { const c = await composeCommunityManagement(o); if (!c.ok) return; try { use(c); } finally { await c.data.dispose(); } }',
        calls: 1,
      },
      {
        source:
          'import { composeMetering as m } from "../metering/compose"; async function a() { const c = await m(o); if (!c.ok) return; try { use(c); } finally { await c.data.dispose(); } }',
        file: inSrc("lib/example/use.ts"),
        calls: 1,
      },
      // A type cannot call the composer.
      { source: `${BILLING} type R = Awaited<ReturnType<typeof composeBilling>>;`, calls: 0 },
      // The rest of the runtime barrel is free to use.
      {
        source:
          'import * as runtime from "@/lib/runtime"; import { checkGate } from "@/lib/runtime"; const r = await runtime.getMgmRuntime(); checkGate(r);',
        calls: 0,
      },
      // The barrels' own re-exports.
      {
        source: 'export { openOrganizationScope, authorizeOrganization } from "./scope";',
        file: inSrc("lib/runtime/index.ts"),
        calls: 0,
      },
      {
        source: 'export { composeCommunityManagement } from "./compose";',
        file: inSrc("lib/community-management/index.ts"),
        calls: 0,
      },
    ];
    for (const { source, file = ROUTE, calls } of ok) expect(analyze(source, file), source).toEqual({ calls, offenses: [] });

    const bad = [
      // Composer calls under another name, still undisposed.
      'import { composeBilling as cb } from "@/lib/billing/compose"; async function a() { const c = await cb(o); use(c); }',
      'import * as billing from "@/lib/billing/compose"; async function a() { const c = await billing.composeBilling(o); use(c); }',
      'import * as cm from "@/lib/community-management"; async function a() { const c = await cm.composeCommunityManagement(o); use(c); }',
      // A composer that leaves the file or is called out of sight.
      `${BILLING} const f = composeBilling;`,
      `${BILLING} run(composeBilling);`,
      `${BILLING} export { composeBilling };`,
      `${BILLING} export default composeBilling;`,
      'import * as billing from "@/lib/billing/compose"; const { composeBilling: cb } = billing;',
      'import * as billing from "@/lib/billing/compose"; billing["composeBilling"](o);',
      'import * as billing from "@/lib/billing/compose"; import cb = billing.composeBilling;',
      `${BILLING} import cb = composeBilling;`,
      'export { composeBilling } from "@/lib/billing/compose";',
      'export * from "@/lib/billing/compose";',
      'export * as billing from "@/lib/billing/compose";',
      'const { composeBilling } = await import("@/lib/billing/compose");',
      // A load whose target cannot be read off the source.
      "async function a(n) { const m = await import(`@/lib/billing/${n}`); }",
      'const spec = "@/lib/billing/compose"; const m = await import(spec);',
      'const m = require("@/lib/billing/" + name);',
      // The opener under any name, outside the composer modules.
      'import { openOrganizationScope as open } from "@/lib/runtime/scope"; await open(r);',
      'import { openOrganizationScope } from "@/lib/runtime"; await openOrganizationScope(r);',
      'import * as runtime from "@/lib/runtime"; await runtime.openOrganizationScope(r);',
      'export { openOrganizationScope } from "@/lib/runtime/scope";',
      'const runtime = await import("@/lib/runtime");',
    ];
    for (const source of bad) expect(analyze(source, ROUTE).offenses, source).toHaveLength(1);
  });

  it("follows every way a module can pass a composer or the opener on", () => {
    // Each module is edited in memory only. A barrel that names the same
    // module in two re-export statements passes on both.
    withSource(
      inSrc("lib/community-management/index.ts"),
      (text) => `${text}\nexport { composeCommunityManagement as composeCommunities } from "./compose";`,
      () =>
        expect(
          outcome(
            'import { composeCommunities } from "@/lib/community-management"; async function a() { const c = await composeCommunities(o); use(c); }'
          )
        ).toEqual({ calls: 1, kinds: ["undisposed"] })
    );
    // A composer module's own alias and default export.
    withSource(
      inSrc("lib/billing/compose.ts"),
      (text) => `${text}\nexport { composeBilling as buildBilling };\nexport default composeBilling;`,
      () =>
        expect(
          outcome(
            'import bb, { buildBilling } from "@/lib/billing/compose"; async function a() { const c = await buildBilling(o); const d = await bb(o); use(c, d); }'
          )
        ).toEqual({ calls: 2, kinds: ["undisposed", "undisposed"] })
    );
    withSource(
      inSrc("lib/billing/compose.ts"),
      (text) => {
        const edited = text.replace("export async function composeBilling(", "export default async function composeBilling(");
        expect(edited, "the declaration this case rewrites").not.toBe(text);
        return edited;
      },
      () =>
        expect(
          outcome('import cb from "@/lib/billing/compose"; async function a() { const c = await cb(o); use(c); }')
        ).toEqual({ calls: 1, kinds: ["undisposed"] })
    );
    // The opener's own alias.
    withSource(
      OPENER_MODULE,
      (text) => `${text}\nexport { openOrganizationScope as openScope };`,
      () => expect(outcome('import { openScope } from "@/lib/runtime/scope"; await openScope(r);')).toEqual({ calls: 0, kinds: ["opens"] })
    );
    // A composer declared as a const must be listed like a function one.
    withSource(
      inSrc("lib/billing/compose.ts"),
      (text) => `${text}\nexport const composeBillingFast = async (o: never) => composeBilling(o);`,
      () => expect(declaredExports(inSrc("lib/billing/compose.ts"))).toContain("composeBillingFast")
    );
  });

  it("finds the composer call sites", () => {
    const calls = reports.reduce((sum, report) => sum + report.calls, 0);
    expect(calls).toBeGreaterThan(20);
  });

  it("disposes every composition in a finally block", () => {
    expect(
      offenses.filter((offense) => offense.kind !== "opens").map((offense) => offense.at),
      "Call each composer directly, bind the result to a const and make `[await] <name>.data.dispose()` (or `<name>.dispose()`) the first statement of a finally block"
    ).toEqual([]);
  });

  it("opens scopes directly only in the composer modules", () => {
    expect(
      offenses.filter((offense) => offense.kind === "opens").map((offense) => offense.at),
      "Compose a capability instead of opening a request scope directly"
    ).toEqual([]);
  });
});
