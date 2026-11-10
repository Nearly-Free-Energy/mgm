/**
 * What a GUI contribution names must exist and hold: the checks that need the
 * file system or the TypeScript compiler, so they run in CI rather than in
 * contribute() (src/lib/gui/host/server/contribution-schema.ts). The test boots
 * the real runtime root and reads its surface snapshot.
 *
 * Actions: 1. the route file exists and exports the method; 2. the handler
 * parses its body with parseJsonBody(request, S), S imported from the plugin's
 * schemas module, and S is the action's `input` itself; 3. the route is gated
 * or composes, or carries a PaymentExemption; 4. the route is released.
 * Views: 5. each example, as a loader would return it, passes
 * strictParseModel; 6. no declared key or prefix, nor any name in its ext
 * schema, looks like a secret unless SECRET_LIKE_EXEMPTIONS says why; 7. each
 * LinkRef in its examples goes to a released page the plugin owns, a released
 * GET route or an OutHref.
 * Plugins: 8. nothing a contributing plugin's surface module runs uses a
 * capability method outside LOADER_READS, so its loaders, signals, search and
 * prepare steps write nothing through a capability.
 *
 * Each check is a function over its inputs and the self-tests feed it
 * violating fixtures, so the guard is shown to fail on kinds of entry the
 * snapshot does not hold yet, such as actions.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ViewModel } from "@/lib/gui/contract";
import type { ActionDef, Contribution, ViewDef } from "@/lib/gui/surface";
import { DATA_KEYS, schemaNames, strictParseModel } from "@/lib/gui/host/server/parse";
import { SurfaceRegistry, type SurfaceSnapshot } from "@/lib/gui/host/server/surface-registry";
import { isOutHref } from "@/lib/gui/host/shared/href";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { MGM_BUNDLED_PLUGINS, getRouteOwner, matchCatalogPage, type MgmPluginName } from "@/lib/plugins/bundled";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import { UNGATED_WRITES, exemptionKey, handlerSources } from "@/lib/runtime/__tests__/route-rules";
import { BILLING_SURFACE } from "./fixtures/billing-surface";

const REPO = path.resolve(__dirname, "../../../..");
const APP = path.join(REPO, "src/app");

/** Each plugin's module of action body schemas. Add a plugin's entry with its first action. */
const SCHEMA_MODULES: Partial<Record<MgmPluginName, string>> = {
  "community-management": "@/lib/community-management/schemas",
  metering: "@/lib/metering/schemas",
  billing: "@/lib/billing/schemas",
  payments: "@/lib/payments/schemas",
};
/** The helper routes parse bodies with. It arrives with the first schemas module; if it moves, change this. */
const PARSE_BODY = { module: "@/lib/validation/parse-body", name: "parseJsonBody" };

/**
 * The module exporting each contributing plugin's contribution, as an "@/"
 * specifier like SCHEMA_MODULES'. Check 8 reads what it loads, and its exports
 * must reach every function the plugin's registered contribution holds.
 */
const SURFACE_MODULES: Partial<Record<MgmPluginName, string>> = {
  "organization-directory": "@/lib/organization-directory/surface",
  "community-management": "@/lib/community-management/surface",
  metering: "@/lib/metering/surface",
  billing: "@/lib/billing/surface",
  payments: "@/lib/payments/surface",
};

/** Words that make a declared name look like a secret, alone or with an "s". */
const SECRET_WORDS = new Set([
  "secret", "token", "password", "passwd", "passphrase", "credential", "key", "apikey", "auth", "bearer",
  "cookie", "encrypted", "ciphertext", "otp",
]);
/** Secret-looking names that are not secrets, as "<view id> <name>": why. */
const SECRET_LIKE_EXEMPTIONS: Readonly<Record<string, string>> = {};

/**
 * The capability methods code a contribution runs may use: each only reads.
 * Every other member of a *CapabilityContract interface, or of
 * a class implementing one, is refused, so a new method is refused until it is
 * listed. A test below fails when a contract is missing here or a name is not
 * one of its members.
 */
const LOADER_READS: Readonly<Record<string, readonly string[]>> = {
  BillingCapabilityContract: ["getPeriodSummary", "listTariffs"],
  CommunityManagementCapabilityContract: ["resolveHierarchy"],
  MeteringCapabilityContract: ["getAssignmentHistory", "getConsumption", "getSiteDay"],
  PaymentsCapabilityContract: ["getReadiness", "listHistory"],
};
const CONTRACT = /CapabilityContract$/;

type Problems = string[];
type RouteFile = { route: string; text: string };
type Binding = { module: string; name: string };
interface Facts {
  apiRoutes: readonly RouteFile[];
  /** A schemas module's exports; undefined when it does not exist. */
  schemas(module: string): Record<string, unknown> | undefined;
  released(path: string): boolean;
  secretExemptions?: Readonly<Record<string, string>>;
}

const sourceOf = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
const unique = (values: Iterable<string>) => [...new Set(values)].sort();

// ── Actions (checks 1 to 4) ─────────────────────────────────────────────────

/** A file's value imports: local name → module and exported name ("*" for a namespace). */
function valueImports(file: ts.SourceFile): Map<string, Binding> {
  const out = new Map<string, Binding>();
  for (const s of file.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause || s.importClause.isTypeOnly) continue;
    const from = path.posix.normalize(s.moduleSpecifier.text);
    const named = s.importClause.namedBindings;
    if (s.importClause.name) out.set(s.importClause.name.text, { module: from, name: "default" });
    if (named && ts.isNamespaceImport(named)) out.set(named.name.text, { module: from, name: "*" });
    else for (const e of named?.elements ?? []) if (!e.isTypeOnly) out.set(e.name.text, { module: from, name: (e.propertyName ?? e.name).text });
  }
  return out;
}

/** The imported schemas a handler, with the local helpers it calls, passes to parseJsonBody. */
function parsedSchemas(text: string, handler: string): { schemas: Binding[]; problems: Problems } {
  const imports = valueImports(sourceOf("route.ts", text));
  const code = sourceOf("handler.ts", handler);
  // A local of the same name shadows an import.
  const local = new Set<string>();
  const collect = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isBindingElement(node)) &&
        node.name && ts.isIdentifier(node.name)) local.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(code);
  const imported = (name: string) => (local.has(name) ? undefined : imports.get(name));
  const schemas: Binding[] = [];
  const problems: Problems = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === PARSE_BODY.name) {
      const helper = imported(PARSE_BODY.name);
      if (helper?.module !== PARSE_BODY.module || helper.name !== PARSE_BODY.name) problems.push(`calls a ${PARSE_BODY.name} that is not ${PARSE_BODY.module}'s`);
      const arg = node.arguments[1];
      let binding: Binding | undefined;
      if (arg && ts.isIdentifier(arg)) binding = imported(arg.text);
      else if (arg && ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)) {
        const ns = imported(arg.expression.text);
        if (ns?.name === "*") binding = { module: ns.module, name: arg.name.text };
      }
      if (binding && binding.name !== "*") schemas.push(binding);
      else problems.push(`parses with ${arg?.getText(code) ?? "no schema"}, which is not an imported schema`);
    }
    ts.forEachChild(node, visit);
  };
  visit(code);
  return { schemas, problems };
}

function actionProblems(plugin: MgmPluginName, a: ActionDef, facts: Facts): Problems {
  const problems: Problems = [];
  const text = facts.apiRoutes.find((r) => r.route === a.path)?.text;
  const handler = text === undefined ? undefined : handlerSources(text).get(a.method);
  if (text === undefined) problems.push(`no route file at src/app${a.path}/route.ts`);
  else if (handler === undefined) problems.push(`the route exports no ${a.method}`);
  else {
    const parsed = parsedSchemas(text, handler);
    problems.push(...parsed.problems);
    const used = unique(parsed.schemas.map((s) => `${s.module} ${s.name}`));
    const expected = SCHEMA_MODULES[plugin];
    if (used.length === 0) problems.push(`does not parse its body with ${PARSE_BODY.name}(request, <schema>)`);
    else if (used.length > 1) problems.push(`parses with several schemas: ${used.join(", ")}`);
    else {
      const [{ module, name }] = parsed.schemas;
      if (module !== expected) problems.push(`parses with ${name} from ${module}, not from ${expected ?? `a schemas module for ${plugin}`}`);
      else if (facts.schemas(module)?.[name] !== a.input) problems.push(`input is not ${module}'s ${name}, which the route parses with`);
    }
  }
  // route-surface.test.ts already holds every write handler of a non-core
  // plugin to the gate or a composer unless UNGATED_WRITES exempts it, so only
  // the exemptions that are plain reasons are left to refuse here. If that
  // test stops covering every route, check the gate here instead.
  if (typeof UNGATED_WRITES[exemptionKey(a.method, a.path)] === "string") {
    problems.push("the route is exempt from the gate without a PaymentExemption");
  }
  if (!facts.released(a.path.replace(/\[[^\]]+\]/g, "0"))) problems.push("the route is not released");
  return problems.map((p) => `${a.id} (${a.method} ${a.path}): ${p}`);
}

// ── Views (checks 5 to 7) ───────────────────────────────────────────────────

/** An example as its loader would return it: no host-filled fields, ActionRefs cut to ActionLinks, embeds to their href. */
function asLoaded(example: ViewModel): unknown {
  const cut = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => cut(item));
    if (value === null || typeof value !== "object" || (key !== undefined && DATA_KEYS.has(key))) return value;
    const o = value as Record<string, unknown>;
    if (typeof o.action === "string" && typeof o.enabled === "boolean") {
      const link = { action: o.action, params: o.params, label: o.label, prefill: o.prefill, provenance: o.provenance };
      return Object.fromEntries(Object.entries(link).filter(([, v]) => v !== undefined));
    }
    const entries = Object.entries(o).filter(([k]) => !(o.type === "view" && k === "model"));
    return Object.fromEntries(entries.map(([k, v]) => [k, cut(v, k)]));
  };
  const hostFilled = new Set(["type", "view", "kind", "org", "trail", "attached", "notice", "live"]);
  return cut(Object.fromEntries(Object.entries(example).filter(([k]) => !hostFilled.has(k))));
}

/** Every LinkRef href in a model, outside data subtrees. */
function linkHrefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => linkHrefs(item, out));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (DATA_KEYS.has(key)) continue;
      if (key === "links" && Array.isArray(child)) out.push(...child.map((link) => String((link as { href?: unknown }).href)));
      else linkHrefs(child, out);
    }
  }
  return out;
}

function isSecretLike(name: string): boolean {
  // "DBPassword" → "DB Password", "clientSecret" → "client Secret".
  const spaced = name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const words = spaced.toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => SECRET_WORDS.has(w) || (w.endsWith("s") && SECRET_WORDS.has(w.slice(0, -1))));
}

function linkProblem(plugin: MgmPluginName, href: string, facts: Facts): string | null {
  if (isOutHref(href)) return null;
  const pathname = href.split(/[?#]/)[0];
  if (!facts.released(pathname)) return "not released";
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    // The route file serving it; a fixed segment beats a bracket.
    const parts = pathname.split("/").filter(Boolean);
    const fixed = (r: RouteFile) => r.route.split("/").filter((s) => s && !s.startsWith("[")).length;
    const fits = facts.apiRoutes
      .filter((r) => {
        const segments = r.route.split("/").filter(Boolean);
        return segments.length === parts.length && segments.every((s, i) => /^\[.+\]$/.test(s) || s === parts[i]);
      })
      .sort((x, y) => fixed(y) - fixed(x));
    if (!fits.length) return "no route file serves it";
    return handlerSources(fits[0].text).has("GET") ? null : `${fits[0].route} exports no GET`;
  }
  const page = matchCatalogPage(pathname);
  if (!page) return "not a catalog page";
  const owner = getRouteOwner(page.page.path)?.name;
  return page.plugin.name === plugin && owner === plugin ? null : `${page.page.path} is ${owner ?? page.plugin.name}'s page`;
}

function viewProblems(plugin: MgmPluginName, def: ViewDef, facts: Facts): Problems {
  const problems: Problems = [];
  def.examples.forEach((example, i) => {
    const loaded = asLoaded(example as ViewModel);
    const parsed = strictParseModel(def, loaded);
    if (!parsed.ok) problems.push(`example ${i} fails the strict parse at ${parsed.paths.join("; ")}`);
    // An embedded view's model is the host's to fill, so its links are not this view's.
    for (const href of linkHrefs(loaded)) {
      const problem = linkProblem(plugin, href, facts);
      if (problem) problems.push(`example ${i} links to ${href}: ${problem}`);
    }
  });
  const names = [...def.declares.keys, ...(def.declares.prefixes ?? []), ...(def.ext ? schemaNames(def.ext.zod) : [])];
  for (const name of unique(names)) {
    if (isSecretLike(name) && !Object.hasOwn(facts.secretExemptions ?? SECRET_LIKE_EXEMPTIONS, `${def.id} ${name}`)) {
      problems.push(`declares "${name}", which looks like a secret; rename it or exempt it with a reason`);
    }
  }
  return problems.map((p) => `${def.id}: ${p}`);
}

/** Every registered entry, with the plugin that contributed it and a name for messages. */
function registered(s: SurfaceSnapshot): { plugin: MgmPluginName; name: string; entry: object }[] {
  return [
    ...[...s.views, ...s.actions.values(), ...s.nav].map((e) => ({ plugin: e.plugin, name: e.def.id, entry: e })),
    ...[...s.signals, ...s.status].map((e) => ({ plugin: e.plugin, name: e.id, entry: e })),
    ...s.search.map((e) => ({ plugin: e.plugin, name: `search ${e.prefix}${e.entity}`, entry: e })),
    ...[...s.entities].map(([kind, e]) => ({ plugin: e.plugin, name: `entity ${kind}`, entry: e })),
  ];
}

const contributingPlugins = (s: SurfaceSnapshot) => unique(registered(s).map((e) => e.plugin));

/** The functions in a value's plain objects and arrays, with where each was first found. */
function functionsIn(value: unknown, at: string, out = new Map<unknown, string>(), seen = new Set<unknown>()) {
  if (typeof value === "function") {
    if (!out.has(value)) out.set(value, at);
  } else if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value) || proto === Object.prototype || proto === null) {
      for (const [k, v] of Object.entries(value)) functionsIn(v, `${at}.${k}`, out, seen);
    }
  }
  return out;
}

/** The functions a plugin's registered contribution holds that the listed module's exports do not reach. */
function untiedFunctions(snapshot: SurfaceSnapshot, plugin: MgmPluginName, exports: Record<string, unknown>): Problems {
  const reached = functionsIn(exports, "exports");
  const held = new Map<unknown, string>();
  for (const { name, entry } of registered(snapshot).filter((e) => e.plugin === plugin)) functionsIn(entry, name, held);
  return [...held].filter(([fn]) => !reached.has(fn)).map(([, at]) => `${at} is not reached from ${plugin}'s SURFACE_MODULES exports`);
}

function surfaceProblems(snapshot: SurfaceSnapshot, facts: Facts): Problems {
  return [
    ...[...snapshot.actions.values()].flatMap(({ plugin, def }) => actionProblems(plugin, def, facts)),
    ...snapshot.views.flatMap(({ plugin, def }) => viewProblems(plugin, def, facts)),
  ];
}

// ── Capability writes (check 8) ─────────────────────────────────────────────

function classContract(cls: ts.ClassDeclaration): string | null {
  const implemented = (cls.heritageClauses ?? []).filter((c) => c.token === ts.SyntaxKind.ImplementsKeyword);
  return implemented.flatMap((c) => c.types.map((t) => t.expression.getText())).find((n) => CONTRACT.test(n)) ?? null;
}

/** The contract a declaration is a member of: through its interface, or a class implementing one. */
function contractOf(decl: ts.Declaration): string | null {
  const owner = decl.parent;
  if (owner && ts.isInterfaceDeclaration(owner)) return CONTRACT.test(owner.name.text) ? owner.name.text : null;
  return owner && ts.isClassDeclaration(owner) ? classContract(owner) : null;
}

/** A class implementing a capability contract: its body is the capability's own code. */
function isCapabilityClass(node: ts.Node): boolean {
  return ts.isClassDeclaration(node) && classContract(node) !== null;
}

/**
 * The files `roots` load at run time: value imports, re-exports, and import()
 * or require of a literal. The body of a class implementing a capability is
 * not entered: other code reaches what it runs only through its members, which
 * are checked where they are used. The rest of its file is, so a helper
 * exported beside the class is checked like any other code. A module named at
 * run time cannot be followed and is refused.
 */
function loadedFiles(program: ts.Program, host: ts.ModuleResolutionHost, roots: readonly string[]) {
  const files: ts.SourceFile[] = [];
  const problems: Problems = [];
  for (const root of roots) {
    const file = program.getSourceFile(root);
    if (!file || file.isDeclarationFile) problems.push(`${root}: no source file to check`);
  }
  const queue = [...roots];
  while (queue.length) {
    const file = program.getSourceFile(queue.shift() as string);
    if (!file || files.includes(file) || file.isDeclarationFile) continue;
    files.push(file);
    const follow = (spec: string) => {
      const resolved = ts.resolveModuleName(spec, file.fileName, program.getCompilerOptions(), host).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport) queue.push(resolved.resolvedFileName);
    };
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && !node.isTypeOnly)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const [arg] = node.arguments;
        if (arg && ts.isStringLiteralLike(arg)) follow(arg.text);
        else problems.push(`${path.relative(REPO, file.fileName)}: loads a module named at run time`);
      }
      if (!isCapabilityClass(node)) ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { files, problems };
}

/** Each use, in what `roots` load, of a capability member not in `reads`: resolved by type, or by name on an untyped value. */
function capabilityWrites(program: ts.Program, host: ts.ModuleResolutionHost, roots: readonly string[], reads = LOADER_READS): Problems {
  const checker = program.getTypeChecker();
  const denied = new Set<string>();
  for (const file of program.getSourceFiles()) {
    for (const s of file.statements) {
      if (!ts.isInterfaceDeclaration(s) || !CONTRACT.test(s.name.text)) continue;
      for (const m of s.members) if (m.name && !reads[s.name.text]?.includes(m.name.getText(file))) denied.add(m.name.getText(file));
    }
  }
  const { files, problems } = loadedFiles(program, host, roots);
  const report = (node: ts.Node, what: string) => {
    const file = node.getSourceFile();
    problems.push(`${path.relative(REPO, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: uses ${what}`);
  };
  const check = (node: ts.Node, object: ts.Node, name: string | null) => {
    const type = checker.getTypeAtLocation(object);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      if (name === null || denied.has(name)) report(node, `${name ?? "a computed member"} of an untyped value`);
      return;
    }
    for (const part of type.isUnion() ? type.types : [type]) {
      const props = name === null ? checker.getPropertiesOfType(part) : [checker.getPropertyOfType(part, name)];
      for (const prop of props) {
        const contract = prop?.declarations?.map(contractOf).find(Boolean);
        if (prop && contract && !reads[contract]?.includes(prop.name)) return report(node, `${contract}.${prop.name}`);
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) check(node, node.expression, node.name.text);
    else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      check(node, node.expression, ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : null);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      check(node, node.parent, node.dotDotDotToken ? null : ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null);
    }
    if (!isCapabilityClass(node)) ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return problems;
}

// ── Facts from this repository ──────────────────────────────────────────────

function apiRoutes(dir = path.join(APP, "api")): RouteFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : apiRoutes(path.join(dir, entry.name));
    if (!entry.isFile() || entry.name !== "route.ts") return [];
    return [{ route: `/${path.relative(APP, dir).split(path.sep).join("/")}`, text: readFileSync(path.join(dir, entry.name), "utf8") }];
  });
}

function repoFacts(schemas = new Map<string, Record<string, unknown>>()): Facts {
  return { apiRoutes: apiRoutes(), schemas: (module) => schemas.get(module), released: isReleasedRoute };
}

async function loadSchemaModules(): Promise<Map<string, Record<string, unknown>>> {
  const loaded = new Map<string, Record<string, unknown>>();
  for (const specifier of Object.values(SCHEMA_MODULES)) {
    try {
      loaded.set(specifier, await import(/* @vite-ignore */ path.join(REPO, "src", specifier.slice(2))));
    } catch {
      // Not written yet: an action naming it fails check 2.
    }
  }
  return loaded;
}

/** The *CapabilityContract interfaces under src/lib, with their members. */
function contractsInRepo(dir = path.join(REPO, "src/lib"), out = new Map<string, string[]>()): Map<string, string[]> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "__tests__") contractsInRepo(full, out);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const text = readFileSync(full, "utf8");
    if (!text.includes("CapabilityContract")) continue;
    const file = sourceOf(full, text);
    for (const s of file.statements) {
      if (ts.isInterfaceDeclaration(s) && CONTRACT.test(s.name.text)) out.set(s.name.text, s.members.flatMap((m) => (m.name ? [m.name.getText(file)] : [])));
    }
  }
  return out;
}

/** A program over this repository from "@/" specifiers. One that resolves to no file stays as written, for loadedFiles to report. */
function projectProgram(specifiers: readonly string[]) {
  const config = ts.readConfigFile(path.join(REPO, "tsconfig.json"), ts.sys.readFile);
  const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, REPO).options, incremental: false };
  const host = ts.createCompilerHost(options);
  const from = path.join(REPO, "src/index.ts");
  const roots = specifiers.map((s) => ts.resolveModuleName(s, from, options, host).resolvedModule?.resolvedFileName ?? s);
  return { program: ts.createProgram(roots, options, host), host, roots };
}

/** A program over in-memory files under /guard, with the real default library. */
function memoryProgram(files: Record<string, string>) {
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  const text = new Map(Object.entries(files).map(([name, source]) => [`/guard/${name}`, source]));
  const { getSourceFile, fileExists, readFile, directoryExists } = host;
  host.getSourceFile = (name, version, ...rest) =>
    text.has(name) ? ts.createSourceFile(name, text.get(name) as string, version, true) : getSourceFile.call(host, name, version, ...rest);
  host.fileExists = (name) => text.has(name) || fileExists.call(host, name);
  host.readFile = (name) => text.get(name) ?? readFile.call(host, name);
  host.directoryExists = (name) => name === "/guard" || (directoryExists?.call(host, name) ?? false);
  return { program: ts.createProgram([...text.keys()], options, host), host };
}

// ── The contributions the runtime registers ─────────────────────────────────

describe("GUI surface contributions", () => {
  afterAll(() => resetMgmRuntimeForTests());

  it("hold every action and view to their routes, schemas, names and links", async () => {
    const snapshot = (await getMgmRuntime()).mgmSurface.snapshot();
    const facts = repoFacts(snapshot.actions.size ? await loadSchemaModules() : undefined);
    expect(surfaceProblems(snapshot, facts)).toEqual([]);
  });

  it("come from listed modules that write nothing through a capability", async () => {
    const s = (await getMgmRuntime()).mgmSurface.snapshot();
    expect(contributingPlugins(s), "List each contributing plugin's module in SURFACE_MODULES")
      .toEqual(unique(Object.keys(SURFACE_MODULES)));
    const listed = Object.entries(SURFACE_MODULES) as [MgmPluginName, string][];
    if (!listed.length) return;
    const { program, host, roots } = projectProgram(listed.map(([, module]) => module));
    expect(capabilityWrites(program, host, roots)).toEqual([]);
    const untied = await Promise.all(listed.map(async ([plugin], i) => untiedFunctions(s, plugin, await import(/* @vite-ignore */ roots[i]))));
    expect(untied.flat()).toEqual([]);
  }, 120_000);

  it("list the read methods of every capability contract, and only real ones", () => {
    const contracts = contractsInRepo();
    expect(unique(contracts.keys())).toEqual(unique(Object.keys(LOADER_READS)));
    expect(Object.entries(LOADER_READS).flatMap(([c, reads]) => reads.filter((r) => !contracts.get(c)?.includes(r)))).toEqual([]);
  });
});

// ── Self-tests: each check refuses what it should ───────────────────────────

describe("the GUI surface guard", () => {
  const [createPeriod, generateBills] = BILLING_SURFACE.actions as ActionDef[];
  const [periods, review] = BILLING_SURFACE.views as ViewDef[];
  const facts = repoFacts();
  const quietly = <T,>(run: () => T): T => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return run();
    } finally {
      spy.mockRestore();
    }
  };

  it("runs every check over a registered contribution (the billing fixture)", () => {
    const registry = new SurfaceRegistry({ plugins: MGM_BUNDLED_PLUGINS });
    // One view declares a secret-looking key, so the view checks are shown to run.
    const views = BILLING_SURFACE.views?.map((v) => (v === periods ? { ...v, declares: { ...v.declares, keys: [...v.declares.keys, "apiKey"] } } : v));
    registry.contribute({ ...BILLING_SURFACE, views } as Contribution);
    const snapshot = registry.snapshot();
    // Check 2 compares by identity, so the registry must keep each action's schema object.
    expect(snapshot.actions.get(createPeriod.id)?.def.input).toBe(createPeriod.input);
    // Today's routes read their bodies by hand, so each action fails check 2 alone.
    const unparsed = "does not parse its body with parseJsonBody(request, <schema>)";
    expect(surfaceProblems(snapshot, facts)).toEqual([
      `billing.create-period (POST /api/billing-periods): ${unparsed}`,
      `billing.generate-bills (POST /api/billing/generate): ${unparsed}`,
      `billing.close-period (POST /api/billing-periods/[periodId]/close): ${unparsed}`,
      'billing.periods: declares "apiKey", which looks like a secret; rename it or exempt it with a reason',
    ]);
  });

  it("finds every contributing plugin, and ties its listed module to the functions it registered", () => {
    const registry = new SurfaceRegistry({ plugins: MGM_BUNDLED_PLUGINS });
    registry.contribute(BILLING_SURFACE);
    const load = async () => [];
    registry.contribute({ plugin: "metering", signals: [{ id: "metering.quiet", load }] });
    registry.contribute({ plugin: "payments", search: [{ prefix: "#", entity: "billingPeriod", find: load }] });
    const snapshot = registry.snapshot();
    expect(contributingPlugins(snapshot)).toEqual(["billing", "metering", "payments"]);

    expect(untiedFunctions(snapshot, "billing", { BILLING_SURFACE })).toEqual([]);
    expect(untiedFunctions(snapshot, "billing", { other: { views: [] } })).toEqual([
      "billing.periods.def.load is not reached from billing's SURFACE_MODULES exports",
      "billing.period-due.load is not reached from billing's SURFACE_MODULES exports",
    ]);
    expect(untiedFunctions(snapshot, "metering", { load })).toEqual([]);
    expect(untiedFunctions(snapshot, "payments", {})).toEqual(["search #billingPeriod.find is not reached from payments's SURFACE_MODULES exports"]);
  });

  it("refuses an action whose route is missing, unreleased, exempt or parses with another schema", () => {
    const IMPORTS = 'import { parseJsonBody } from "@/lib/validation/parse-body";\nimport { Body } from "@/lib/billing/schemas";\n';
    const PARSE = "await parseJsonBody(request, Body);";
    const file = (body = PARSE, imports = IMPORTS) => `${imports}export async function POST(request: Request) { ${body} }`;
    const check = (text: string | null, o: { path?: string; module?: Record<string, unknown> } = {}) => {
      const route = o.path ?? "/api/billing-periods";
      return actionProblems("billing", { ...createPeriod, path: route } as ActionDef, {
        apiRoutes: text === null ? [] : [{ route, text }],
        schemas: (m) => (m === "@/lib/billing/schemas" ? (o.module ?? { Body: createPeriod.input }) : undefined),
        released: (p) => p !== "/api/unreleased",
      }).map((p) => p.replace(/^.*?\): /, ""));
    };

    expect(check(file())).toEqual([]);
    // An aliased or namespace import, and a parse in a local helper the handler calls.
    expect(check(file("await parseJsonBody(request, B);", IMPORTS.replace("{ Body }", "{ Body as B }")))).toEqual([]);
    expect(check(file("await parseJsonBody(request, s.Body);", IMPORTS.replace("{ Body }", "* as s")))).toEqual([]);
    expect(check(`${IMPORTS}async function read(request: Request) { return ${PARSE} }\nexport async function POST(request: Request) { await read(request); }`))
      .toEqual([]);

    expect(check(null)).toEqual(["no route file at src/app/api/billing-periods/route.ts"]);
    expect(check(file().replace("POST", "PUT"))).toEqual(["the route exports no POST"]);
    expect(check(file(), { path: "/api/unreleased" })).toEqual(["the route is not released"]);
    // A PaymentExemption names the one method the route reaches, so it passes.
    expect(check(file(), { path: "/api/payments/attempts/[id]/refresh" })).toEqual([]);
    // "POST /api/edges" is exempt from the gate with a plain reason in route-rules.ts.
    expect(check(file(), { path: "/api/edges" })).toEqual(["the route is exempt from the gate without a PaymentExemption"]);

    expect(check(file("await request.json();"))).toEqual(["does not parse its body with parseJsonBody(request, <schema>)"]);
    expect(check(file(), { module: { Body: generateBills.input } })).toEqual(["input is not @/lib/billing/schemas's Body, which the route parses with"]);
    expect(check(file(PARSE, IMPORTS.replace("billing/schemas", "metering/schemas")))).toEqual(["parses with Body from @/lib/metering/schemas, not from @/lib/billing/schemas"]);
    expect(check(file(`const Body = z.object({}); ${PARSE}`)))
      .toEqual(["parses with Body, which is not an imported schema", "does not parse its body with parseJsonBody(request, <schema>)"]);
    expect(check(`${IMPORTS}async function read(request: Request, Body: unknown) { return parseJsonBody(request, Body); }\nexport async function POST(request: Request) { await read(request, null); }`))
      .toEqual(["parses with Body, which is not an imported schema", "does not parse its body with parseJsonBody(request, <schema>)"]);
    expect(check(file(PARSE, IMPORTS.replace("@/lib/validation/parse-body", "./parse")))).toEqual(["calls a parseJsonBody that is not @/lib/validation/parse-body's"]);
    expect(check(file(PARSE, IMPORTS.replace("{ parseJsonBody }", "{ other as parseJsonBody }")))).toEqual(["calls a parseJsonBody that is not @/lib/validation/parse-body's"]);
    expect(check(file(`${PARSE} await parseJsonBody(request, Other);`, `${IMPORTS}import { Other } from "@/lib/billing/schemas";\n`)))
      .toEqual(["parses with several schemas: @/lib/billing/schemas Body, @/lib/billing/schemas Other"]);
  });

  it("parses a view's examples as loader output, and refuses undeclared keys, unreleased hrefs and stray links", () => {
    expect(BILLING_SURFACE.views?.flatMap((def) => viewProblems("billing", def, facts))).toEqual([]);
    const example = periods.examples[0] as ViewModel & { kind: "collection" };
    const changed = (change: (model: typeof example) => void) => {
      const model = structuredClone(example);
      change(model);
      return quietly(() => viewProblems("billing", { ...periods, examples: [model] } as ViewDef, facts));
    };
    expect(changed((m) => void (m.body.rows[0].cells.extra = { t: "text", text: "x" })))
      .toEqual([expect.stringMatching(/^billing\.periods: example 0 fails the strict parse at .*undeclared/)]);
    expect(changed((m) => void (m.body.rows[0].href = "/microgrids/x/nowhere")))
      .toEqual([expect.stringMatching(/^billing\.periods: example 0 fails the strict parse at .*href/)]);

    const M = "00000000-0000-4000-8000-0000000000b1";
    const ref = (href: string, i: number) => ({ id: `billing.l${i}` as const, label: "Link", href: href as `/${string}` });
    const links = changed((m) => {
      m.links = [
        `/microgrids/${M}/billing`, `/api/billing-periods/${M}/export-csv`, "tel:+256700000000",
        `/microgrids/${M}/operations`, `/api/billing-periods/${M}/close`, "/api/org-api-tokens", "/review",
      ].map(ref);
      m.body.rows[0].links = [ref(`/microgrids/${M}/operations?row`, 9)];
      // An embedded view's model is filled by the host: its links are not checked as this view's.
      Object.assign(m, { embed: { type: "view", href: `/microgrids/${M}/operations`, model: { links: [ref(`/microgrids/${M}/operations?embed`, 8)] } } });
    });
    expect(links.filter((p) => p.includes("links to"))).toEqual([
      `billing.periods: example 0 links to /microgrids/${M}/operations: /microgrids/[id]/operations is metering's page`,
      `billing.periods: example 0 links to /api/billing-periods/${M}/close: /api/billing-periods/[periodId]/close exports no GET`,
      "billing.periods: example 0 links to /api/org-api-tokens: not released",
      "billing.periods: example 0 links to /review: not a catalog page",
      `billing.periods: example 0 links to /microgrids/${M}/operations?row: /microgrids/[id]/operations is metering's page`,
    ]);
  });

  it("refuses secret-looking names in declares and ext, except listed exemptions", () => {
    // Each word in SECRET_WORDS is the only one in at least one name here.
    const secret = ["apiKey", "token.", "basic_auth_password", "Secrets", "accessToken", "clientSecret", "dbPassword", "DBPassword", "JWTToken",
      "SMTPPassword", "credentials", "storedCredential", "passwd", "passphrase", "authHeader", "bearer", "sessionCookie", "encryptedValue",
      "ciphertext", "otpCode", "privateKey", "APIKEY"];
    expect(secret.filter(isSecretLike)).toEqual(secret);
    for (const w of SECRET_WORDS) expect([w, `stored${w[0].toUpperCase()}${w.slice(1)}`].filter(isSecretLike), w).toHaveLength(2);
    expect(["period", "keyboard", "monkey", "author", "tier.1"].filter(isSecretLike)).toEqual([]);
    const exempt: Facts = { ...facts, secretExemptions: { "billing.periods keyCount": "A count of keys, not a key." } };
    const named = { ...periods, examples: [], declares: { keys: [...periods.declares.keys, "keyCount", "apiKey"], prefixes: ["secret."] } };
    const ext = { ...review, examples: [], ext: { schema: "billing.period-review@1", zod: z.strictObject({ login: z.strictObject({ password: z.string() }) }) } };
    const why = "which looks like a secret; rename it or exempt it with a reason";
    expect([named, ext].flatMap((def) => viewProblems("billing", def as ViewDef, exempt))).toEqual([
      `billing.periods: declares "apiKey", ${why}`,
      `billing.periods: declares "secret.", ${why}`,
      `billing.period-review: declares "password", ${why}`,
    ]);
  });

  it("refuses a capability write method however a surface module reaches it", () => {
    const C = 'import { compose } from "./compose";\n';
    const surfaces: Record<string, string> = {
      // A read, a same-named member of something else, and a type-only import of the helper.
      ok: `${C}import type { run } from "./helper";\nconst cart = { buy() {} };\nexport const load = () => { cart.buy(); return compose().shop.list(); };`,
      direct: `${C}export const load = () => compose().shop.buy("1");`,
      cls: 'import { ShopCapability } from "./capability";\nexport const load = () => new ShopCapability().buy("1");',
      literal: `${C}export const load = () => compose().shop["buy"]("1");`,
      computed: `${C}export const load = (k: "list" | "buy") => compose().shop[k]("1");`,
      destructured: `${C}export const load = () => { const { buy } = compose().shop; buy("1"); };`,
      rest: `${C}export const load = () => { const { ...all } = compose().shop; return all; };`,
      untyped: `${C}export const load = () => (compose().shop as any).buy("1");`,
      untypedComputed: `${C}export const load = (k: string) => (compose().shop as any)[k]("1");`,
      optional: 'import type { ShopCapabilityContract } from "./contract";\nexport const load = (s?: ShopCapabilityContract) => s?.buy("1");',
      indirect: 'import { run } from "./helper";\nexport const load = () => run();',
      reexport: 'export { run } from "./helper";\n',
      star: 'export * from "./helper";\n',
      required: '// A require of a literal path is followed.\nexport const load = () => require("./helper").run();',
      dynamic: "export const load = async (name: string) => import(name);",
    };
    const { program, host } = memoryProgram({
      "contract.ts": "export interface ShopCapabilityContract { list(): number[]; buy(id: string): void; }",
      // The capability's own code is not entered, so its own call to buy() is not counted.
      "capability.ts": 'import type { ShopCapabilityContract } from "./contract";\nexport class ShopCapability implements ShopCapabilityContract { list() { return []; } buy(id: string) { void id; this.buy("again"); } }',
      "compose.ts": 'import { ShopCapability } from "./capability";\nimport type { ShopCapabilityContract } from "./contract";\nexport function compose(): { shop: ShopCapabilityContract } { return { shop: new ShopCapability() }; }',
      "helper.ts": `${C}export function run() { compose().shop.buy("1"); }`,
      ...Object.fromEntries(Object.entries(surfaces).map(([name, text]) => [`${name}.ts`, text])),
    });
    const writes = (surface: string) =>
      capabilityWrites(program, host, [`/guard/${surface}.ts`], { ShopCapabilityContract: ["list"] }).map((p) => p.replace(/^.*guard\//, ""));

    expect(writes("ok")).toEqual([]);
    for (const name of ["direct", "cls", "literal", "computed", "destructured", "rest", "optional"]) {
      expect(writes(name), name).toEqual([`${name}.ts:2: uses ShopCapabilityContract.buy`]);
    }
    expect(writes("untyped")).toEqual(["untyped.ts:2: uses buy of an untyped value"]);
    expect(writes("untypedComputed")).toEqual(["untypedComputed.ts:2: uses a computed member of an untyped value"]);
    for (const name of ["indirect", "reexport", "star", "required"]) expect(writes(name), name).toEqual(["helper.ts:2: uses ShopCapabilityContract.buy"]);
    expect(writes("missing")).toEqual(["missing.ts: no source file to check"]);
    expect(writes("dynamic")).toEqual(["dynamic.ts: loads a module named at run time"]);
  }, 30_000);

  it("checks a helper exported beside a capability class, but not the class's own body", () => {
    const { program, host } = memoryProgram({
      "contract.ts": "export interface ShopCapabilityContract { list(): number[]; buy(id: string): void; }",
      "capability.ts": [
        'import type { ShopCapabilityContract } from "./contract";',
        'export class ShopCapability implements ShopCapabilityContract { list() { return []; } buy(id: string) { void id; this.buy("again"); } }',
        'export function writeHelper() { new ShopCapability().buy("1"); }',
      ].join("\n"),
      "viaHelper.ts": 'import { writeHelper } from "./capability";\nexport const load = () => writeHelper();',
      "viaClass.ts": 'import { ShopCapability } from "./capability";\nexport const load = () => new ShopCapability().list();',
    });
    const writes = (surface: string) =>
      capabilityWrites(program, host, [`/guard/${surface}.ts`], { ShopCapabilityContract: ["list"] }).map((p) => p.replace(/^.*guard\//, ""));

    // Both load capability.ts, so both see writeHelper; neither sees the class's own this.buy().
    expect(writes("viaHelper")).toEqual(["capability.ts:3: uses ShopCapabilityContract.buy"]);
    expect(writes("viaClass")).toEqual(["capability.ts:3: uses ShopCapabilityContract.buy"]);
  }, 30_000);

  it("resolves SURFACE_MODULES entries as \"@/\" specifiers, and reports one that names no file", () => {
    const { program, host, roots } = projectProgram(["@/lib/gui/fmt", "@/lib/gui/nowhere", "src/lib/gui/fmt"]);
    expect(roots).toEqual([path.join(REPO, "src/lib/gui/fmt.ts"), "@/lib/gui/nowhere", "src/lib/gui/fmt"]);
    expect(loadedFiles(program, host, roots).problems).toEqual(["@/lib/gui/nowhere: no source file to check", "src/lib/gui/fmt: no source file to check"]);
  }, 30_000);
});
