/**
 * Requests reach payment providers and payment records only through the
 * Payments capability.
 *
 * Neither `composePayments` nor `composePaymentsPublic` checks plugin
 * state: the capability refuses new checkouts itself and keeps history,
 * verification and reconciliation running while Payments is off
 * (`capability-gating.test.ts`). That is safe only while nothing a request
 * runs can contact a provider or write payment records another way. From
 * every entry point Next.js loads (everything under src/app, the middleware
 * and the instrumentation hook) this follows each runtime import, and fails
 * when the code it reaches:
 *
 *   1. imports a provider, the payments infrastructure or the capability
 *      class, except through the composer (`STOPS`);
 *   2. names the root's payment provider registry; or
 *   3. writes a payment table, or a payment column of any table, or calls a
 *      payment database function, as named in database.gen.ts. A row it
 *      cannot read (a variable, a spread) written to a table with payment
 *      columns fails too, unless an exception says why it holds none.
 *
 * A route Payments or Pesapal owns that composes the capability runs while
 * those plugins are off: route-surface.test.ts exempts its write handlers
 * from the gate, each pinned to the one capability method it calls, and
 * its GETs are never gated. So it is held to more:
 *
 *   4. the code it runs writes no table, calls no database function,
 *      invokes no Edge Function, makes no Supabase Auth call but a read,
 *      makes no outbound call (`fetch`) and imports no package but those in
 *      `ROUTE_PACKAGES`, except through the capability; and no module it
 *      runs but the route file itself loads the composer, so every
 *      capability call the request makes is in the route file, where
 *      route-surface.test.ts pins an exempt route to one method.
 *
 * Each exception says what it reaches, why that is allowed while Payments
 * is off, and what would make the reason wrong.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { PAYMENTS_PLUGIN_NAME, PESAPAL_PLUGIN_NAME, getRouteOwner } from "@/lib/plugins/bundled";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SRC = path.join(REPO_ROOT, "src");

/** Where requests start. */
const ENTRY_ROOTS = ["src/app", "src/middleware.ts", "src/instrumentation.ts"];

/** Modules the walk does not enter, and why what lies behind them is safe. */
const STOPS: Record<string, string> = {
  "src/lib/payments/compose.ts":
    "The capability's composer: its repository and provider factory serve only the capability.",
  "src/lib/runtime/root.ts":
    "Registers provider plugins into the root registry, which only the capability's provider factory calls (check 2).",
};

/** Modules that contact a provider or write payment records themselves. */
const FORBIDDEN: Record<string, string> = {
  "src/lib/payments/providers/": "provider implementations",
  "src/lib/payments/pesapal/": "the legacy Pesapal client",
  "src/lib/payments/infrastructure/": "the payments repository and merchant configuration",
  "src/lib/payments/capability.ts": "the capability class, constructed only by its composer",
  "src/lib/payments/factory.ts": "the legacy provider factory",
  "src/lib/payments/ensure-payment-link.ts": "the legacy checkout path, which calls the provider",
  "src/lib/payments/config.ts": "the legacy provider configuration, with the decrypted secret",
};

const MERCHANT_SETUP =
  "Merchant setup precedes enabling Payments (docs/payments-rollout.md: configure and test a sandbox merchant, then enable Payments and Pesapal) and creates no checkout; route-surface.test.ts exempts the route for the same reason. Wrong once merchant setup requires Payments to be enabled.";

const MANUAL_RECORDING =
  "Manual payment recording belongs to Billing and stays independent of the Payments plugin (docs/payments-rollout.md: \"Manual payment recording remains independent\"); Billing's gate covers it. Wrong once manual recording moves into Payments.";

/** Entry point → forbidden module → name it may import → why. */
const ALLOWED_IMPORTS: Record<string, Record<string, Record<string, string>>> = {
  "src/app/api/organizations/[id]/payment-accounts/route.ts": {
    "src/lib/payments/infrastructure/merchant-configuration.ts": {
      testMerchantConfiguration: `Tests merchant credentials and registers the notification URL with the provider. ${MERCHANT_SETUP}`,
    },
  },
};

/** Module → table or database function it may write or call → why (checks 3 and 4). */
const ALLOWED_DIRECT_ACCESS: Record<string, Record<string, string>> = {
  "src/app/api/billing-line-items/[lineItemId]/payment-status/route.ts": {
    fn_apply_payment_event: MANUAL_RECORDING,
  },
  "src/lib/billing/infrastructure/supabase-repository.ts": {
    fn_apply_payment_event: MANUAL_RECORDING,
  },
  "src/app/api/communities/[id]/payment/override/route.ts": {
    community_payment_overrides:
      "Chooses which merchant account a community uses and contacts no provider; payment configuration is allowed while Payments is off (route-surface.test.ts exempts the route). Wrong once configuration requires Payments to be enabled.",
  },
  "src/app/api/organizations/[id]/payment-accounts/route.ts": {
    fn_get_payment_merchant_secret: `Re-tests a saved account when no new secret is given. ${MERCHANT_SETUP}`,
    fn_payment_save_account: `Saves the tested account. ${MERCHANT_SETUP}`,
  },
  "src/app/api/payments/ipn/route.ts": {
    payment_notifications:
      "Stores a notification whose merchant reference matches no attempt, so there is no organization to compose the capability for; the worker looks the reference up again, verifies it through handleNotification if an attempt now matches, and dead-letters it otherwise. Contacts no provider. Wrong once the capability can be composed without an organization.",
  },
  "src/app/api/payments/reconcile-worker/route.ts": {
    payment_notifications:
      "Queues pending attempts for verification and dead-letters references with no attempt; each queued notification is verified through handleNotification. Wrong once queueing moves into the capability.",
    fn_payment_due_notifications:
      "Leases this run's due notifications; each one whose reference matches an attempt is verified through handleNotification, the rest are dead-lettered. Wrong once leasing moves into the capability.",
  },
  "src/lib/community-management/infrastructure/supabase-repository.ts": {
    communities:
      "Inserts and updates rows typed CommunityCreateInput and CommunityUpdateInput, which parseCreateInput and parseUpdateInput (operations/communities.ts) build field by field with no payment column. Wrong once either type or parser gains a payment column.",
  },
};

/** The names of the root's payment provider registry (check 2). */
const REGISTRY_NAMES = new Set(["paymentProviderRegistry", "paymentProviders", "PaymentProviderRegistry"]);

/** Modules that define the registry rather than call it. */
const REGISTRY_OWNERS: Record<string, string> = {
  "src/lib/runtime/services.ts": "Defines the registry and its Cordis service name.",
  "src/lib/runtime/scope.ts": "Lists the request service names, so each request gets its own slot.",
};

const WRITE_METHODS = new Set(["insert", "upsert", "update", "delete"]);

/** Columns that carry payment state, on whichever table (check 3). */
const PAYMENT_NAME = /payment|merchant|pesapal|paid/i;

/**
 * The plugins whose composing routes check 4 holds: Payments, and Pesapal,
 * whose webhook is delivered through the Payments capability.
 * route-surface.test.ts accepts a `PaymentExemption` only for a route one
 * of them owns, relying on this check for what the route writes and calls
 * and for the route file being the only module that composes the
 * capability; if this set changes, change its `BOUNDARY_OWNERS` too.
 */
const COMPOSER_OWNERS = new Set<string>([PAYMENTS_PLUGIN_NAME, PESAPAL_PLUGIN_NAME]);

/**
 * The capability's composer; a route that reaches it composes the
 * capability, and only the route file itself may load it (check 4).
 */
const PAYMENTS_COMPOSER = "src/lib/payments/compose.ts";

/**
 * The packages code a composing route runs may import (check 4), by import
 * specifier, and why none of them calls out. Any other package might: an
 * SDK wraps `fetch` where the checks here cannot see it.
 */
const ROUTE_PACKAGES: Record<string, string> = {
  "next/server":
    "The handler's request and response classes (NextRequest, NextResponse), which call out to nothing. Wrong once a route uses one of its exports that fetches, such as ImageResponse.",
  "next/headers":
    "Reads the incoming request's cookies and headers for the Supabase session; calls out to nothing. Wrong once a route uses an export of it that does.",
  "server-only":
    "A build-time marker that keeps a module out of client bundles; it exports nothing and runs nothing. Wrong once the package gains runtime code.",
  "@supabase/supabase-js":
    "The database client. Check 4 reads its table writes and database function calls (`directAccess`) and its Edge Function and Auth calls (`supabaseCalls`). Wrong once a route uses a part of the client neither reads, such as Realtime channels.",
  "@supabase/ssr":
    "Builds the same Supabase client bound to the request's cookies (createServerClient). Wrong for the same reason as @supabase/supabase-js.",
};

/** Globals `fetch` can be reached through. */
const GLOBALS = new Set(["globalThis", "window", "self", "global"]);

/**
 * Supabase Auth calls (`<client>.auth.<method>`, auth-js) that only read.
 * Every other Auth call counts as a side effect (check 4), so a method
 * auth-js adds is one until it is listed here.
 */
const AUTH_READS = new Set(["getUser", "getSession", "getClaims"]);

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
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

/** The repository file an import names, or null for a package. */
function resolveModule(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`${relative(from)}: cannot resolve "${specifier}"`);
  return found;
}

/** Names a module import uses; `*` when it may use any. */
type Names = string[] | "*";
type ModuleImport = { specifier: string; names: Names };

/** Imports that load code at runtime. Type-only imports load nothing. */
function runtimeImports(source: ts.SourceFile): ModuleImport[] {
  const found: ModuleImport[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) {
        found.push({ specifier: node.moduleSpecifier.text, names: "*" });
      } else if (!clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          found.push({ specifier: node.moduleSpecifier.text, names: "*" });
        } else {
          const names = [
            ...(clause.name ? ["default"] : []),
            ...(bindings?.elements ?? [])
              .filter((element) => !element.isTypeOnly)
              .map((element) => (element.propertyName ?? element.name).text),
          ];
          if (names.length) found.push({ specifier: node.moduleSpecifier.text, names });
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      const clause = node.exportClause;
      if (!clause || !ts.isNamedExports(clause)) {
        found.push({ specifier: node.moduleSpecifier.text, names: "*" });
      } else {
        const names = clause.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => (element.propertyName ?? element.name).text);
        if (names.length) found.push({ specifier: node.moduleSpecifier.text, names });
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier = node.arguments[0];
      if (!specifier || !ts.isStringLiteralLike(specifier)) {
        throw new Error(`${source.fileName}: an import whose module cannot be read statically`);
      }
      found.push({ specifier: specifier.text, names: "*" });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push({ specifier: node.moduleReference.expression.text, names: "*" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A module made only of `export … from` statements, like src/lib/payments/index.ts. */
function isBarrel(source: ts.SourceFile): boolean {
  return source.statements.every(
    (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
  );
}

/** Where a barrel sends the names an importer uses. */
function forwarded(file: string, names: Names): { file: string; names: Names }[] {
  const targets: { file: string; names: Names }[] = [];
  for (const statement of parse(file).statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveModule(file, statement.moduleSpecifier.text);
    if (!target) continue;
    const clause = statement.exportClause;
    if (!clause) {
      targets.push({ file: target, names });
    } else if (!ts.isNamedExports(clause)) {
      if (names === "*" || names.includes(clause.name.text)) targets.push({ file: target, names: "*" });
    } else {
      const picked = clause.elements
        .filter((element) => !element.isTypeOnly && (names === "*" || names.includes(element.name.text)))
        .map((element) => (element.propertyName ?? element.name).text);
      if (picked.length) targets.push({ file: target, names: names === "*" ? "*" : picked });
    }
  }
  return targets;
}

function forbiddenAs(modulePath: string): string | null {
  const key = Object.keys(FORBIDDEN).find((entry) =>
    entry.endsWith("/") ? modulePath.startsWith(entry) : modulePath === entry
  );
  return key ? FORBIDDEN[key] : null;
}

type Reach = { entry: string; modulePath: string; names: Names; via: string[] };

/** Every module a request entering at `entry` can run, and the forbidden modules it imports. */
function walk(entry: string): { modules: Set<string>; reaches: Reach[] } {
  const modules = new Set<string>();
  const reaches: Reach[] = [];
  const barrels = new Set<string>();
  const queue: { file: string; names: Names; via: string[] }[] = [{ file: entry, names: "*", via: [] }];
  while (queue.length) {
    const { file, names, via } = queue.shift() as (typeof queue)[number];
    const modulePath = relative(file);
    if (forbiddenAs(modulePath)) {
      reaches.push({ entry: relative(entry), modulePath, names, via });
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    if (file !== entry && isBarrel(parse(file))) {
      const key = `${file} ${JSON.stringify(names)}`;
      if (barrels.has(key)) continue;
      barrels.add(key);
      for (const next of forwarded(file, names)) queue.push({ ...next, via: [...via, modulePath] });
      continue;
    }
    if (modules.has(modulePath)) continue;
    modules.add(modulePath);
    if (STOPS[modulePath]) continue;
    for (const { specifier, names: used } of runtimeImports(parse(file))) {
      const next = resolveModule(file, specifier);
      if (next) queue.push({ file: next, names: used, via: [...via, modulePath] });
    }
  }
  return { modules, reaches };
}

/**
 * The repository modules a module's own runtime imports load, followed
 * through barrels to the modules that define the names it uses.
 */
function loadedModules(source: ts.SourceFile): Set<string> {
  const loaded = new Set<string>();
  const seen = new Set<string>();
  const queue = runtimeImports(source).flatMap(({ specifier, names }) => {
    const file = resolveModule(source.fileName, specifier);
    return file ? [{ file, names }] : [];
  });
  while (queue.length) {
    const { file, names } = queue.shift() as (typeof queue)[number];
    const key = `${file} ${JSON.stringify(names)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (/\.tsx?$/.test(file) && isBarrel(parse(file))) queue.push(...forwarded(file, names));
    else loaded.add(relative(file));
  }
  return loaded;
}

function collectEntries(): string[] {
  const entries: string[] = [];
  const visit = (target: string) => {
    if (statSync(target).isDirectory()) {
      for (const entry of readdirSync(target)) {
        if (entry !== "__tests__") visit(path.join(target, entry));
      }
    } else if (/\.tsx?$/.test(target) && !/\.test\.tsx?$/.test(target)) {
      entries.push(target);
    }
  };
  for (const root of ENTRY_ROOTS) visit(path.join(REPO_ROOT, root));
  return entries;
}

/**
 * Payment tables and database functions, and the payment columns of every
 * table, read from the generated schema types.
 */
function paymentSchemaNames(): { tables: Set<string>; functions: Set<string>; columns: Map<string, Set<string>> } {
  const source = parse(path.join(SRC, "lib", "types", "database.gen.ts"));
  const members = (type: ts.TypeNode | undefined) =>
    type && ts.isTypeLiteralNode(type) ? type.members.filter(ts.isPropertySignature) : [];
  const member = (type: ts.TypeNode | undefined, name: string) =>
    members(type).find((property) => property.name.getText(source) === name)?.type;
  const database = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === "Database"
  );
  const schema = member(database?.type, "public");
  const payments = (section: string) =>
    new Set(
      members(member(schema, section))
        .map((property) => property.name.getText(source))
        .filter((name) => /payment|merchant|pesapal/i.test(name))
    );
  const columns = new Map(
    members(member(schema, "Tables")).map((table) => [
      table.name.getText(source),
      new Set(
        members(member(table.type, "Row"))
          .map((column) => column.name.getText(source))
          .filter((name) => PAYMENT_NAME.test(name))
      ),
    ])
  );
  return { tables: payments("Tables"), functions: payments("Functions"), columns };
}

/** A parameter or constant typed as string literals, e.g. `rpc: "fn_a" | "fn_b"`. */
function literalValues(expression: ts.Expression): string[] | null {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (!ts.isIdentifier(expression)) return null;
  const literals = (type: ts.TypeNode | undefined) => {
    const parts = type ? (ts.isUnionTypeNode(type) ? [...type.types] : [type]) : [];
    const values = parts.map((part) =>
      ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal) ? part.literal.text : null
    );
    return values.length && values.every((value) => value !== null) ? (values as string[]) : null;
  };
  for (let scope: ts.Node | undefined = expression.parent; scope; scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const declaration = statement.declarationList.declarations.find(
          (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === expression.text
        );
        if (!declaration) continue;
        const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        if (constant && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
          return [declaration.initializer.text];
        }
        return literals(declaration.type);
      }
    }
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === expression.text
      );
      if (parameter) return literals(parameter.type);
    }
  }
  return null;
}

type DirectAccess = {
  kind: "table" | "function";
  name: string | null;
  text: string;
  /** Columns the rows the chain inserts, upserts or updates name; null when a row is not a literal object. */
  columns: string[] | null;
};

/** The keys of object-literal rows, e.g. `{ a, b: 1 }` or `[{ a }]`; null when a row is a variable, a spread or a computed key. */
function rowKeys(argument: ts.Expression | undefined): string[] | null {
  if (!argument) return null;
  if (ts.isArrayLiteralExpression(argument)) {
    const keys = argument.elements.map((element) => rowKeys(element));
    return keys.every((row) => row !== null) ? (keys as string[][]).flat() : null;
  }
  if (!ts.isObjectLiteralExpression(argument)) return null;
  const keys: string[] = [];
  for (const property of argument.properties) {
    const name = property.name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) keys.push(name.text);
    else if (name && ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) keys.push(name.expression.text);
    else return null;
  }
  return keys;
}

/**
 * The member read off `node` (`node.name`, `node["name"]`) and the name it
 * spells; `name` is null under a computed key.
 */
function memberOf(node: ts.Node): { access: ts.Expression; name: string | null } | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return { access: parent, name: parent.name.text };
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    const key = parent.argumentExpression;
    return { access: parent, name: ts.isStringLiteralLike(key) ? key.text : null };
  }
  return undefined;
}

/** The call `node` is the callee of, if any. */
function calledAt(node: ts.Node): ts.CallExpression | undefined {
  return node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
}

/** Ways to call a method other than calling it directly. */
const INDIRECT_CALLS = new Set(["call", "apply", "bind"]);

/**
 * Supabase table writes and database function calls in a module. A `from()`
 * chain counts as a read only when it selects and never writes, so a builder
 * kept in a variable and written later counts as a write. A member may be
 * spelled `.from` or `["from"]`, and a method in the chain may be called
 * through `.call`, `.apply` or `.bind`. A `from` or `rpc` itself called that
 * way counts with a target that cannot be read (`name: null`).
 */
function directAccess(source: ts.SourceFile): DirectAccess[] {
  const found: DirectAccess[] = [];
  const text = (node: ts.Node) => node.getText(source).split("\n")[0];
  // `Array.from(…)`, `Buffer.from(…)`: static methods, not query builders.
  const staticCall = (receiver: ts.Node) => ts.isIdentifier(receiver) && /^[A-Z]/.test(receiver.text);
  const visit = (node: ts.Node) => {
    const read = memberOf(node);
    const kind = read?.name === "rpc" ? "function" : read?.name === "from" ? "table" : null;
    if (read && kind && !staticCall(node)) {
      const call = calledAt(read.access);
      const indirect = memberOf(read.access);
      if (call) {
        const chain: string[] = [];
        let columns: string[] | null = [];
        let link: ts.Expression = call;
        for (;;) {
          const method = memberOf(link);
          if (!method?.name) break;
          let next = calledAt(method.access);
          if (!next) {
            // `.update.call(q, row)`, `.update.apply(q, [row])`, `.update.bind(q)`.
            const via = memberOf(method.access);
            if (!via?.name || !INDIRECT_CALLS.has(via.name)) break;
            chain.push(method.name);
            if (method.name !== "delete" && WRITE_METHODS.has(method.name)) columns = null;
            next = via.name === "bind" ? undefined : calledAt(via.access);
            if (!next) break;
            link = next;
            continue;
          }
          chain.push(method.name);
          if (method.name !== "delete" && WRITE_METHODS.has(method.name)) {
            const keys = rowKeys(next.arguments[0]);
            columns = columns && keys ? [...columns, ...keys] : null;
          }
          link = next;
        }
        const writes =
          kind === "function" ||
          chain.some((method) => WRITE_METHODS.has(method)) ||
          !chain.includes("select");
        if (writes) {
          const argument = call.arguments[0];
          const values = argument ? literalValues(argument) : null;
          for (const name of values ?? [null]) found.push({ kind, name, text: text(call), columns });
        }
      } else if (indirect?.name && INDIRECT_CALLS.has(indirect.name)) {
        // `x.rpc.call(x, "fn")`: the target is an argument after `this`.
        found.push({ kind, name: null, text: text(indirect.access.parent), columns: null });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Outbound calls a module can make: any reference to the global `fetch`
 * (called, passed on, or reached through `globalThis.fetch` or
 * `globalThis["fetch"]`). Packages, which may call out where this cannot
 * see, are `packageImports`.
 */
function outboundCalls(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "fetch") {
      const parent = node.parent;
      const member = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const viaGlobal = member && ts.isIdentifier(parent.expression) && GLOBALS.has(parent.expression.text);
      const declares =
        (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent)) &&
        parent.name === node;
      if ((!member || viaGlobal) && !declares) found.push(`fetch: ${parent.getText(source).split("\n")[0]}`);
    }
    if (
      ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "fetch"
    ) {
      found.push(`fetch: ${node.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Supabase calls that leave the database but are not table or function
 * access: every Edge Function use (`<client>.functions…`) and every Auth
 * call but a read (`AUTH_READS`), named by the path it is called through
 * (`auth.admin.deleteUser`). An `auth` member that is not called straight
 * (destructured, held in a variable, under a computed key) counts too.
 */
function supabaseCalls(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const read = memberOf(node);
    if (read?.name === "functions") {
      found.push(`functions: ${read.access.getText(source)}`);
    } else if (read?.name === "auth") {
      const path: string[] = [];
      let access: ts.Node = read.access;
      for (let next = memberOf(access); !calledAt(access) && next?.name; next = memberOf(access)) {
        path.push(next.name);
        access = next.access;
      }
      if (!path.length || !calledAt(access)) found.push(`auth: ${access.getText(source).split("\n")[0]}`);
      else if (!AUTH_READS.has(path.join("."))) found.push(`auth.${path.join(".")}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Packages a module imports at runtime that `ROUTE_PACKAGES` does not allow (check 4). */
function packageImports(source: ts.SourceFile): string[] {
  return runtimeImports(source)
    .filter(({ specifier }) => resolveModule(source.fileName, specifier) === null && !Object.hasOwn(ROUTE_PACKAGES, specifier))
    .map(({ specifier }) => `imports ${specifier}`);
}

function registryReferences(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && REGISTRY_NAMES.has(node.text)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

let analysis: {
  entries: string[];
  modules: Set<string>;
  /** Entry point → every module a request entering there can run. */
  runs: Map<string, Set<string>>;
  reaches: Reach[];
} | null = null;
function analyse() {
  if (!analysis) {
    const entries = collectEntries();
    const modules = new Set<string>();
    const runs = new Map<string, Set<string>>();
    const reaches = new Map<string, Reach>();
    for (const entry of entries) {
      const walked = walk(entry);
      runs.set(relative(entry), walked.modules);
      for (const modulePath of walked.modules) modules.add(modulePath);
      for (const reach of walked.reaches) {
        const key = `${reach.entry} ${reach.modulePath} ${JSON.stringify(reach.names)}`;
        if (!reaches.has(key)) reaches.set(key, reach);
      }
    }
    analysis = { entries: entries.map(relative), modules, runs, reaches: [...reaches.values()] };
  }
  return analysis;
}

/** API routes Payments or Pesapal owns that compose the capability (check 4). */
function composingRoutes(): string[] {
  const { entries, runs } = analyse();
  return entries.filter((entry) => {
    const route = /^src\/app\/(api\/.+)\/route\.ts$/.exec(entry)?.[1];
    const owner = route ? getRouteOwner(`/${route}`) : undefined;
    return owner !== undefined && COMPOSER_OWNERS.has(owner.name) && runs.get(entry)?.has(PAYMENTS_COMPOSER) === true;
  });
}

/** Whether `name` is listed for `modulePath` in ALLOWED_DIRECT_ACCESS. */
function allowedAccess(modulePath: string, name: string | null): boolean {
  const allowed = ALLOWED_DIRECT_ACCESS[modulePath];
  return name !== null && allowed !== undefined && Object.hasOwn(allowed, name);
}

function sourceOf(text: string): ts.SourceFile {
  return ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true);
}

describe("payments route boundary", () => {
  // The walk every check below shares; seconds of parsing when other test
  // files run alongside, so it gets its own time budget.
  beforeAll(() => {
    analyse();
  }, 30_000);

  it("reads imports, barrels and database access the way the checks rely on", () => {
    expect(
      runtimeImports(
        sourceOf(
          'import type { A } from "./a"; import { type B } from "./b"; import { c, type D } from "./c"; export * from "./e"; export type { F } from "./f"; void import("./g");'
        )
      )
    ).toEqual([
      { specifier: "./c", names: ["c"] },
      { specifier: "./e", names: "*" },
      { specifier: "./g", names: "*" },
    ]);

    const barrel = path.join(SRC, "lib", "payments", "index.ts");
    expect(forwarded(barrel, ["PaymentError"]).map(({ file }) => relative(file))).toEqual([
      "src/lib/payments/errors.ts",
    ]);
    expect(forwarded(barrel, ["getPaymentProviderClient"]).map(({ file }) => relative(file))).toEqual([
      "src/lib/payments/factory.ts",
    ]);

    const accesses = (text: string) => directAccess(sourceOf(text)).map(({ kind, name }) => `${kind} ${name}`);
    expect(accesses('db.from("payment_attempts").select("id").eq("id", id);')).toEqual([]);
    expect(accesses('db.from("payment_attempts").update({}).eq("id", id);')).toEqual(["table payment_attempts"]);
    expect(accesses('db.from("payment_attempts").insert({}).select();')).toEqual(["table payment_attempts"]);
    expect(accesses('const q = db.from("payment_attempts"); q.delete();')).toEqual(["table payment_attempts"]);
    expect(accesses("db.from(table).upsert({});")).toEqual(["table null"]);
    expect(accesses("db.from(table).select();")).toEqual([]);
    expect(accesses("Array.from(rows);")).toEqual([]);
    expect(accesses('db.rpc("fn_payment_save_account", {});')).toEqual(["function fn_payment_save_account"]);
    expect(accesses("db.rpc(name);")).toEqual(["function null"]);
    expect(accesses('function f(name: "fn_a" | "fn_b") { return db.rpc(name); }')).toEqual([
      "function fn_a",
      "function fn_b",
    ]);
    expect(accesses('const name = "fn_a"; db.rpc(name);')).toEqual(["function fn_a"]);

    const columns = (text: string) => directAccess(sourceOf(text)).flatMap((access) => access.columns ?? [null]);
    expect(columns('db.from("billing_line_items").update({ payment_status: "paid", "paid_at": now }).eq("id", id);')).toEqual([
      "payment_status",
      "paid_at",
    ]);
    expect(columns('db.from("t").insert([{ a }, { ["b"]: 1 }]).select();')).toEqual(["a", "b"]);
    expect(columns('db.from("t").update(patch).eq("id", id);')).toEqual([null]);
    expect(columns('db.from("t").update({ ...patch }).eq("id", id);')).toEqual([null]);

    // The same, spelled with element access or called through `.call`, `.apply` or `.bind`.
    expect(accesses('db["from"]("payment_attempts").update({}).eq("id", id);')).toEqual(["table payment_attempts"]);
    expect(accesses('db["rpc"]("fn_apply_payment_event", {});')).toEqual(["function fn_apply_payment_event"]);
    expect(accesses('db.from("payment_attempts").select("id")["update"]({});')).toEqual(["table payment_attempts"]);
    expect(accesses('db.from("payment_attempts").select("id").update.call(q, {});')).toEqual(["table payment_attempts"]);
    expect(accesses('db.from("payment_attempts").select("id").delete.bind(q);')).toEqual(["table payment_attempts"]);
    expect(accesses('db.rpc.call(db, "fn_apply_payment_event", {});')).toEqual(["function null"]);
    expect(accesses('db["rpc"].apply(db, ["fn_apply_payment_event", {}]);')).toEqual(["function null"]);
    expect(accesses("const open = db.from.bind(db);")).toEqual(["table null"]);
    expect(accesses('db.from("t").select("id").eq.call(q, "id", id);')).toEqual([]);
    expect(accesses("const from = range.from; Array.from.call(null, rows);")).toEqual([]);
    expect(columns('db.from("billing_line_items").select("id").update.call(q, { paid_at: now });')).toEqual([null]);

    const outbound = (text: string) => outboundCalls(sourceOf(text));
    expect(outbound('await fetch("https://pay.pesapal.com/v3");')).toHaveLength(1);
    expect(outbound('await globalThis.fetch(url);')).toHaveLength(1);
    expect(outbound('await globalThis["fetch"](url); await window[\'fetch\'](url);')).toHaveLength(2);
    expect(outbound("const send = fetch; createClient(url, key, { global: { fetch } });")).toHaveLength(2);
    expect(outbound('client.fetch(url); const options = { fetch: custom }; class A { fetch() {} } headers["fetch"];')).toEqual([]);

    const calls = (text: string) => supabaseCalls(sourceOf(text));
    expect(calls('await db.functions.invoke("settle", { body: {} });')).toEqual(["functions: db.functions"]);
    expect(calls('await db["functions"].invoke("settle");')).toEqual(['functions: db["functions"]']);
    expect(calls("await db.auth.admin.deleteUser(id); await db.auth.signOut();")).toEqual([
      "auth.admin.deleteUser",
      "auth.signOut",
    ]);
    expect(calls('await db["auth"]["admin"].updateUserById(id, {});')).toEqual(["auth.admin.updateUserById"]);
    expect(calls("const { admin } = db.auth; const a = db.auth.admin;")).toEqual(["auth: db.auth", "auth: db.auth.admin"]);
    expect(calls("await db.auth.getUser(); await db.auth.getSession(); await db.auth.getClaims();")).toEqual([]);

    const packages = (text: string) => packageImports(sourceOf(text));
    expect(
      packages(
        'import { request } from "node:https"; import axios from "axios"; import { Resend } from "resend"; import type { Agent } from "undici"; import "server-only"; import { NextResponse } from "next/server"; import { createClient } from "@/lib/supabase/server";'
      )
    ).toEqual(["imports node:https", "imports axios", "imports resend"]);
    expect(packages('export { send } from "resend"; void import("resend"); require("node:http");')).toEqual([
      "imports resend",
      "imports resend",
      "imports node:http",
    ]);

    // The composer loaded directly, lazily or re-exported; a barrel followed to the names used.
    const loads = (text: string) => [...loadedModules(sourceOf(text))];
    expect(loads('import { composePayments } from "@/lib/payments/compose"; import type { X } from "@/lib/payments/scope";'))
      .toEqual([PAYMENTS_COMPOSER]);
    expect(loads('void import("@/lib/payments/compose"); export { composePayments as open } from "@/lib/payments/compose";'))
      .toEqual([PAYMENTS_COMPOSER]);
    expect(loads('import { PaymentError } from "@/lib/payments"; import "server-only";')).toEqual(["src/lib/payments/errors.ts"]);
  });

  it("walks every entry point, through the payment routes to the composer", () => {
    const { entries, modules } = analyse();
    expect(entries).toEqual(
      expect.arrayContaining([
        "src/app/api/billing-line-items/[lineItemId]/pay/route.ts",
        "src/app/api/payments/ipn/route.ts",
        "src/app/payment/callback/page.tsx",
        "src/middleware.ts",
      ])
    );
    expect(modules.has(PAYMENTS_COMPOSER)).toBe(true);
    const { tables, functions, columns } = paymentSchemaNames();
    expect(tables.has("payment_attempts")).toBe(true);
    expect(functions.has("fn_payment_reserve_checkout")).toBe(true);
    expect([...(columns.get("billing_line_items") ?? [])]).toEqual(
      expect.arrayContaining(["payment_status", "paid_at", "pesapal_order_id", "pesapal_redirect_url"])
    );
    expect(composingRoutes()).toEqual(
      expect.arrayContaining([
        "src/app/api/billing-line-items/[lineItemId]/pay/route.ts",
        "src/app/api/payments/ipn/route.ts",
      ])
    );
  });

  it("imports providers and the payments infrastructure only through the capability", () => {
    const offenders = analyse().reaches.flatMap(({ entry, modulePath, names, via }) => {
      const allowed = ALLOWED_IMPORTS[entry]?.[modulePath] ?? {};
      // A namespace, side-effect or dynamic import may use anything, so no
      // exception covers it.
      const unexplained = names === "*" ? ["*"] : names.filter((name) => !Object.hasOwn(allowed, name));
      return unexplained.map(
        (name) =>
          `${entry} reaches ${modulePath} (${forbiddenAs(modulePath)}) as ${
            name === "*" ? "a namespace, side-effect or dynamic import" : name
          } via ${[...via, modulePath].join(" → ")}`
      );
    });
    expect(
      offenders,
      "Call the Payments capability (composePayments) instead, or document an exception in ALLOWED_IMPORTS"
    ).toEqual([]);
  });

  it("names the payment provider registry only where it is defined", () => {
    const offenders: string[] = [];
    for (const modulePath of analyse().modules) {
      if (STOPS[modulePath] || REGISTRY_OWNERS[modulePath]) continue;
      for (const name of registryReferences(parse(path.join(REPO_ROOT, modulePath)))) {
        offenders.push(`${modulePath} names ${name}`);
      }
    }
    expect(offenders, "Reach providers through the Payments capability").toEqual([]);
  });

  it("writes payment records only through the capability", () => {
    const { tables, functions, columns } = paymentSchemaNames();
    const offenders: string[] = [];
    for (const modulePath of analyse().modules) {
      if (STOPS[modulePath]) continue;
      for (const access of directAccess(parse(path.join(REPO_ROOT, modulePath)))) {
        if (access.name === null) {
          offenders.push(`${modulePath}: cannot tell which ${access.kind} \`${access.text}\` uses`);
          continue;
        }
        if (allowedAccess(modulePath, access.name)) continue;
        if (access.kind === "function") {
          if (functions.has(access.name)) offenders.push(`${modulePath}: function ${access.name}`);
        } else if (tables.has(access.name)) {
          offenders.push(`${modulePath}: table ${access.name}`);
        } else if (access.columns === null) {
          if (columns.get(access.name)?.size) {
            offenders.push(`${modulePath}: cannot tell which columns \`${access.text}\` writes to ${access.name}`);
          }
        } else {
          const written = access.columns.filter((column) => columns.get(access.name as string)?.has(column));
          if (written.length) offenders.push(`${modulePath}: ${access.name} columns ${written.join(", ")}`);
        }
      }
    }
    expect(
      offenders,
      "Write payment records through a Payments capability method, or document an exception in ALLOWED_DIRECT_ACCESS"
    ).toEqual([]);
  });

  it("runs nothing but the capability for side effects in a route that composes it", () => {
    const { runs } = analyse();
    const offenders = new Set<string>();
    for (const entry of composingRoutes()) {
      for (const modulePath of runs.get(entry) ?? []) {
        if (STOPS[modulePath]) continue;
        const source = parse(path.join(REPO_ROOT, modulePath));
        const where = modulePath === entry ? entry : `${modulePath} (run by ${entry})`;
        for (const access of directAccess(source)) {
          if (!allowedAccess(modulePath, access.name)) {
            offenders.add(`${where}: ${access.kind} ${access.name ?? `\`${access.text}\``}`);
          }
        }
        for (const call of outboundCalls(source)) offenders.add(`${where}: ${call}`);
        for (const call of supabaseCalls(source)) offenders.add(`${where}: ${call}`);
        for (const found of packageImports(source)) offenders.add(`${where}: ${found}`);
        if (modulePath !== entry && loadedModules(source).has(PAYMENTS_COMPOSER)) {
          offenders.add(`${where}: loads ${PAYMENTS_COMPOSER} outside the route file`);
        }
      }
    }
    expect(
      [...offenders],
      "Do this through a Payments capability method the route file calls, or document an exception in ALLOWED_DIRECT_ACCESS or ROUTE_PACKAGES"
    ).toEqual([]);
  });

  it("keeps every exception in use", () => {
    const { modules, reaches } = analyse();
    const staleImports = Object.entries(ALLOWED_IMPORTS).flatMap(([entry, byModule]) =>
      Object.entries(byModule).flatMap(([modulePath, allowed]) =>
        Object.keys(allowed)
          .filter(
            (name) =>
              !reaches.some(
                (reach) =>
                  reach.entry === entry &&
                  reach.modulePath === modulePath &&
                  reach.names !== "*" &&
                  reach.names.includes(name)
              )
          )
          .map((name) => `${entry} → ${modulePath}: ${name}`)
      )
    );
    const staleAccess = Object.entries(ALLOWED_DIRECT_ACCESS).flatMap(([modulePath, allowed]) => {
      const used = modules.has(modulePath)
        ? new Set(directAccess(parse(path.join(REPO_ROOT, modulePath))).map((access) => access.name))
        : new Set<string | null>();
      return Object.keys(allowed)
        .filter((name) => !used.has(name))
        .map((name) => `${modulePath}: ${name}`);
    });
    const imported = new Set(
      composingRoutes().flatMap((entry) =>
        [...(analyse().runs.get(entry) ?? [])]
          .filter((modulePath) => !STOPS[modulePath])
          .flatMap((modulePath) => runtimeImports(parse(path.join(REPO_ROOT, modulePath))).map(({ specifier }) => specifier))
      )
    );
    const stalePackages = Object.keys(ROUTE_PACKAGES).filter((specifier) => !imported.has(specifier));
    expect([...staleImports, ...staleAccess, ...stalePackages], "Remove exceptions nothing needs any more").toEqual([]);
  });
});
