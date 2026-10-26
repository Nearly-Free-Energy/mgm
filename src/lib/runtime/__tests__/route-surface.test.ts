/**
 * Route surface of the MGM runtime (docs/cordis-runtime.md § "The gate").
 *
 * For every API route — released or not, so an inherited route is ready
 * when its release opens it in src/lib/mgm/released-routes.ts:
 *   1. exactly one bundled plugin owns it (catalog `routes`), and
 *   2. every write handler of a non-core plugin enters the runtime — through
 *      a capability composer or the plugin gate — unless it is listed below
 *      with the reason it is allowed to run while its plugin is disabled;
 *      an exempt route that reaches the Payments capability is held to the
 *      one method its exemption names.
 *
 * This is what keeps Settings → Plugins honest: a new write route that
 * forgets the gate fails the build instead of staying writable.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import * as bundled from "@/lib/plugins/bundled";
import {
  PAYMENTS_PLUGIN_NAME,
  PESAPAL_PLUGIN_NAME,
  getRouteOwner,
  type MgmPluginName,
} from "@/lib/plugins/bundled";
import type { PaymentsCapabilityContract } from "@/lib/payments/repository";

const API_ROOT = path.resolve(__dirname, "..", "..", "..", "app", "api");
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Routes no plugin owns. */
const UNOWNED = new Set(["/api/mgm/health"]);

// GETs that call integrations are gated as writes, not historical data reads.
const EXTERNAL_GETS = new Set([
  "/api/openems/status",
  "/api/edges/[id]/discover-devices",
]);

/**
 * An exemption for a write route that reaches the Payments capability. Its
 * reason is not taken on trust: "holds each payment exemption to the method
 * it names" checks that the route file (all of it, not only the handler)
 * composes Payments, calls exactly `reaches` on the capability, and hands
 * neither the capability nor its composition on. What `reaches` may write or
 * ask the provider is pinned by capability-gating.test.ts, and what the
 * route does besides (no write and no outbound call outside the capability,
 * apart from the exceptions listed there) by check 4 of
 * payments-route-boundary.test.ts, both in src/lib/payments/__tests__.
 * Check 4 also refuses any other module the route runs that loads the
 * composer, which is why the route file is the only place this looks for
 * capability calls; if check 4 stops doing that, follow the route's imports
 * here instead. Check 4 holds only routes Payments or Pesapal owns, so an
 * exempt route must be owned by one of them; if check 4's `COMPOSER_OWNERS`
 * changes, revisit that requirement here.
 */
type PaymentExemption = {
  reason: string;
  /** The one capability method the route calls. It may not refuse a disabled plugin. */
  reaches: keyof PaymentsCapabilityContract;
};

/**
 * Write handlers that intentionally do not consult the gate. Each needs a
 * reason a reviewer can check; a handler that reaches the Payments
 * capability needs a `PaymentExemption`, which the test checks too.
 */
const UNGATED_WRITES: Record<string, string | PaymentExemption> = {
  "POST /api/edges":
    "Retired endpoint; always answers 410 without touching data.",
  "POST /api/organizations/[id]/payment-accounts":
    "Merchant setup precedes enabling Payments (docs/payments-rollout.md); checkout is gated in the capability.",
  "PUT /api/communities/[id]/payment/override":
    "Payment configuration is allowed while Payments is off; checkout is gated in the capability.",
  "DELETE /api/communities/[id]/payment/override":
    "Payment configuration is allowed while Payments is off; checkout is gated in the capability.",
  "PUT /api/communities/[id]/payment":
    "Informational stub; always answers 409 without touching data.",
  "POST /api/communities/[id]/invoice-preview":
    "Renders a preview from submitted branding; billing reads stay available while disabled.",
  // The payment write routes below each reach one Payments capability method
  // that only reads, or keeps running while Payments or Pesapal is off by
  // design (docs/payments-rollout.md).
  "POST /api/billing-line-items/[id]/url": {
    reason:
      "Returns the stable payment link without contacting the provider; checkout starts when the customer follows it, behind ensureCheckout's plugin check. Wrong once the link starts a checkout itself.",
    reaches: "stablePaymentLink",
  },
  "POST /api/payments/attempts/[id]/refresh": {
    reason:
      "Re-verifies an attempt already submitted to the provider; the rollout rule keeps verification available while Payments is off. Wrong once that rule changes or refresh submits anything new.",
    reaches: "refreshPaymentStatus",
  },
  "POST /api/payments/attempts/[id]/reconcile": {
    reason:
      "Records a manager's resolution of an attempt already flagged for reconciliation, which the payments_disabled message promises to preserve; calls no provider. Wrong once that promise is withdrawn.",
    reaches: "reconcile",
  },
  "POST /api/payments/ipn": {
    reason:
      "The provider's notification about money that already moved; verification stays available while Payments or Pesapal is off. Wrong once the rollout rule stops keeping verification available.",
    reaches: "handleNotification",
  },
  "POST /api/payments/reconcile-worker": {
    reason:
      "Retries stored provider notifications through the same verification as the IPN route. Wrong once the rollout rule stops keeping verification available.",
    reaches: "handleNotification",
  },
};

/** Composer → plugins whose disabled state it refuses before opening a scope. */
const COMPOSERS: Record<string, MgmPluginName[]> = {
  composeCommunityManagement: ["community-management"],
  composeMetering: ["metering"],
  composeBilling: ["billing"],
};
// Only composers that refuse a disabled plugin belong above, because a call
// to one counts as gating the route. This is the rule in
// docs/cordis-runtime.md. `composeBillingReview` opens a scope without
// checking plugin state, so its route must gate itself. If it ever starts
// checking, it can come back.
//
// `composePayments` and `composePaymentsPublic` are left out for another
// reason: the Payments capability decides per method and refuses only a new
// checkout (ensureCheckout), which no write route starts; checkout begins at
// the `/pay` GET. The payment write routes are therefore exemptions above,
// each naming the method it reaches. A payments write route that must refuse
// a disabled plugin outright calls `checkGate`/`gateRoute` itself.

/**
 * Composer options that skip the composer's plugin check. A call passing one
 * of these does not count as entering the runtime; the route needs its own
 * `checkGate`/`gateRoute`. Keep in step with the option's handling in the
 * composer (`composeBilling` in src/lib/billing/compose.ts).
 */
const SKIPS_PLUGIN_CHECK: Record<string, string[]> = {
  composeBilling: ["readOnly"],
};

/**
 * The name a property key spells (`readOnly`, `"readOnly"`, `["readOnly"]`
 * all → `readOnly`); null when it cannot be known statically.
 */
function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

function skipsPluginCheck(call: ts.CallExpression, composer: string): boolean {
  const options = call.arguments[0];
  const names = SKIPS_PLUGIN_CHECK[composer] ?? [];
  if (!names.length) return false;
  // Options we cannot read statically (a variable, a spread, a computed key)
  // are treated as skipping the check, so the route has to prove it gates.
  if (!options || !ts.isObjectLiteralExpression(options)) return true;
  return options.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return true;
    if (!property.name) return false;
    const key = propertyKey(property.name);
    if (key === null) return true;
    if (!names.includes(key)) return false;
    if (ts.isShorthandPropertyAssignment(property)) return true;
    return !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword);
  });
}

function collectRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectRoutes(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function routePath(file: string): string {
  const relative = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join("/");
  return `/api/${relative}`;
}

const HANDLER_RE =
  /^export\s+(?:(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b|(?:const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*=\s*([A-Za-z_$][\w$]*)\s*;)/gm;

/** Top-level declarations: `name → source text` (functions and arrow consts). */
function topLevelBlocks(source: string): Map<string, string> {
  const starts = [
    ...source.matchAll(
      /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=)/gm
    ),
  ];
  const blocks = new Map<string, string>();
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    blocks.set(match[1] ?? match[2], source.slice(match.index, end));
  });
  return blocks;
}

/**
 * The source a handler runs: its own body plus the bodies of local
 * functions it calls (transitively), so a gate inside a shared helper counts
 * but a gate in a sibling handler does not. Payment exemptions are checked
 * against the whole route file instead (`paymentExemptionProblems`).
 */
function handlerSources(source: string): Map<string, string> {
  const blocks = topLevelBlocks(source);
  const reach = (name: string): string => {
    const seen = new Set<string>();
    const queue = [name];
    let text = "";
    while (queue.length) {
      const next = queue.shift() as string;
      if (seen.has(next) || !blocks.has(next)) continue;
      seen.add(next);
      const block = blocks.get(next) as string;
      text += block;
      for (const candidate of blocks.keys()) {
        if (!seen.has(candidate) && new RegExp(`\\b${candidate}\\(`).test(block)) {
          queue.push(candidate);
        }
      }
    }
    return text;
  };
  const result = new Map<string, string>();
  for (const match of source.matchAll(HANDLER_RE)) {
    const method = match[1] ?? match[2];
    result.set(method, reach(match[3] ?? method));
  }
  return result;
}

/** `METERING_PLUGIN_NAME` → "metering", from the catalog's own constants. */
const PLUGIN_CONSTANTS = new Map(
  Object.entries(bundled)
    .filter(([name, value]) => name.endsWith("_PLUGIN_NAME") && typeof value === "string")
    .map(([name, value]) => [name, value as string])
);

function gatesPlugin(source: string, owner: MgmPluginName): boolean {
  const file = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
  let guarded = false;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isAwaitExpression(node.initializer) && ts.isCallExpression(node.initializer.expression)) {
      const call = node.initializer.expression;
      if (ts.isIdentifier(call.expression) && ["gateRoute", "checkGate"].includes(call.expression.text)) {
        const options = call.arguments[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          const property = options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === "plugin") as ts.PropertyAssignment | undefined;
          const value = property?.initializer;
          const plugin = value && (ts.isStringLiteral(value) ? value.text : ts.isIdentifier(value) ? PLUGIN_CONSTANTS.get(value.text) : undefined);
          if (plugin === owner) {
            const name = node.name.text;
            const statement = node.parent.parent;
            const block = statement.parent;
            if (ts.isBlock(block)) {
              guarded ||= block.statements.some(s => {
                if (s.pos < statement.end || !ts.isIfStatement(s)) return false;
                const direct = ts.isIdentifier(s.expression) && s.expression.text === name;
                const decision = ts.isPrefixUnaryExpression(s.expression) && s.expression.operator === ts.SyntaxKind.ExclamationToken && ts.isPropertyAccessExpression(s.expression.operand) && ts.isIdentifier(s.expression.operand.expression) && s.expression.operand.expression.text === name && s.expression.operand.name.text === "ok";
                if (!direct && !decision) return false;
                const returned = ts.isBlock(s.thenStatement) ? s.thenStatement.statements[0] : s.thenStatement;
                if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return false;
                if (direct) return ts.isIdentifier(returned.expression) && returned.expression.text === name;
                return ts.isCallExpression(returned.expression) && ts.isIdentifier(returned.expression.expression) && returned.expression.expression.text === "gateResponse" && returned.expression.arguments[0]?.getText(file) === name;
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return guarded;
}

function entersRuntime(source: string, owner: MgmPluginName): boolean {
  const file = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
  let composed = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      COMPOSERS[node.expression.text]?.includes(owner) &&
      !skipsPluginCheck(node, node.expression.text)
    ) composed = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return gatesPlugin(source, owner) || composed;
}

const unique = (values: Iterable<string>) => [...new Set(values)].sort();

/** Each identifier and string literal in a file, in order. */
function identifiersAndStrings(file: ts.SourceFile, visit: (text: string, node: ts.Node) => void) {
  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) visit(node.text, node);
    ts.forEachChild(node, walk);
  };
  walk(file);
}

/** `node.name` or `node["name"]`: the member read off `node`, and its name if it is spelled out. */
function memberRead(node: ts.Node): { access: ts.Expression; name: string | null } | undefined {
  const parent = node.parent;
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
  return ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
}

const PAYMENT_COMPOSERS = new Set(["composePayments", "composePaymentsPublic"]);

/**
 * Where a route can get the Payments capability: the composers and
 * `PaymentsPlugin` in src/lib/payments/compose.ts, and the
 * `PaymentsCapability` class in src/lib/payments/capability.ts. If another
 * module starts handing it out, add it and its exports here.
 */
const CAPABILITY_NAMES = new Set([...PAYMENT_COMPOSERS, "PaymentsPlugin", "PaymentsCapability"]);
const CAPABILITY_MODULE = /(?:^|\/)payments\/(?:compose|capability)(?:\.[cm]?[jt]s)?$/i;
const COMPOSE_MODULE = "@/lib/payments/compose";

/**
 * A module specifier as the path it resolves to: `./` and `../` segments
 * and repeated slashes folded, and a query, fragment or trailing slash
 * dropped, so `@/lib/payments/./compose` and `@/lib/payments/compose?v=1`
 * both read as `@/lib/payments/compose`. `CAPABILITY_MODULE` ignores case,
 * as a case-insensitive file system does.
 */
function modulePath(specifier: string): string {
  return path.posix.normalize(specifier.replace(/[?#].*$/, "")).replace(/\/+$/, "");
}

/**
 * How a route file could reach the Payments capability: a mention of one of
 * `CAPABILITY_NAMES`, a module that hands it out named anywhere by any path
 * that resolves to it (imported under any binding, re-exported, loaded with
 * `import()`), or `import()`/`require` at all, since a module named at
 * runtime cannot be read. Type-only imports load nothing and are skipped.
 */
function capabilityReach(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
    if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
    if (ts.isIdentifier(node) && (CAPABILITY_NAMES.has(node.text) || node.text === "require")) found.push(node.text);
    if (ts.isStringLiteralLike(node) && CAPABILITY_MODULE.test(modulePath(node.text))) found.push(node.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push("import()");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return unique(found);
}

/**
 * The capability methods a route calls, as `<x>.payments.<method>(`, and
 * every other use of the name `payments` that could hold the capability or
 * read it (aliased, destructured, indexed or handed on), after which it
 * could call anything. A key of an object literal (`{ payments: rows }`)
 * and a string that is not an element-access key (a log label) are left
 * alone: the capability comes only from a composition, and any read of a
 * composition but `.data.payments.<method>(` is `compositionEscapes`'s to
 * refuse, assignment destructuring included.
 */
function capabilityCalls(file: ts.SourceFile): { methods: string[]; escapes: string[] } {
  const methods: string[] = [];
  const escapes: string[] = [];
  identifiersAndStrings(file, (text, node) => {
    if (text !== "payments") return;
    const access = node.parent;
    const method = access?.parent;
    if (ts.isPropertyAssignment(access) && access.name === node) return;
    if (ts.isStringLiteralLike(node) && !(ts.isElementAccessExpression(access) && access.argumentExpression === node)) return;
    if (
      ts.isIdentifier(node) &&
      ts.isPropertyAccessExpression(access) && access.name === node &&
      ts.isPropertyAccessExpression(method) && method.expression === access &&
      calledAt(method)
    ) {
      methods.push(method.name.text);
    } else {
      escapes.push(node.parent.getText(file));
    }
  });
  return { methods: unique(methods), escapes };
}

/**
 * What a route may read off a composer's result besides `data`: the members
 * of `PaymentsResult` (src/lib/payments/repository.ts) that describe its
 * outcome. If that type gains one a route needs, add it here.
 */
const COMPOSITION_OUTCOME = new Set(["ok", "status", "code", "message", "field", "reason"]);

/**
 * Uses of a Payments composer, and of the result it returns, other than the
 * ones that lead only to the capability method a route names. A composer may
 * only be imported under its own name and awaited straight into a `const`
 * (`const composed = await composePayments(…)`), and that result only read
 * for its outcome, used to call `data.payments.<method>(…)` and
 * `data.dispose()`. Anything else (the composer aliased; the result or its
 * `data` aliased, destructured, indexed or handed on) could reach the scope
 * or any capability method. Names are matched, not bindings, so a shadowing
 * variable of the same name is held to the same rule.
 */
function compositionEscapes(file: ts.SourceFile): { results: string[]; escapes: string[] } {
  const results = new Set<string>();
  const declared = new Set<ts.Node>();
  const escapes: string[] = [];
  const findComposers = (node: ts.Node) => {
    if (ts.isIdentifier(node) && PAYMENT_COMPOSERS.has(node.text)) {
      const call = calledAt(node);
      const awaited = call?.parent;
      const declaration = awaited?.parent;
      const list = declaration?.parent;
      const ownName = ts.isImportSpecifier(node.parent) && node.parent.name === node && !node.parent.propertyName;
      if (ownName) {
        // `import { composePayments }`: the binding the calls below use.
      } else if (
        awaited && ts.isAwaitExpression(awaited) &&
        declaration && ts.isVariableDeclaration(declaration) && declaration.initializer === awaited &&
        ts.isIdentifier(declaration.name) &&
        list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
      ) {
        results.add(declaration.name.text);
        declared.add(declaration.name);
      } else {
        escapes.push(node.parent.getText(file));
      }
    }
    ts.forEachChild(node, findComposers);
  };
  findComposers(file);
  const allowed = (node: ts.Identifier): boolean => {
    const read = memberRead(node);
    if (!read?.name) return false;
    if (COMPOSITION_OUTCOME.has(read.name)) return true;
    if (read.name !== "data") return false;
    const next = memberRead(read.access);
    if (next?.name === "dispose") return Boolean(calledAt(next.access));
    const method = next?.name === "payments" ? memberRead(next.access) : undefined;
    return Boolean(method?.name && calledAt(method.access));
  };
  // The whole expression a use belongs to (`composed.data.scope`, `run(composed)`).
  const expressionOf = (node: ts.Node): ts.Node => {
    let whole = node;
    while (
      (ts.isPropertyAccessExpression(whole.parent) || ts.isElementAccessExpression(whole.parent) ||
        ts.isCallExpression(whole.parent)) && whole.parent.expression === whole
    ) whole = whole.parent;
    return whole === node ? node.parent : whole;
  };
  const checkUses = (node: ts.Node) => {
    if (ts.isIdentifier(node) && results.has(node.text) && !declared.has(node) && !allowed(node)) {
      escapes.push(expressionOf(node).getText(file));
    }
    ts.forEachChild(node, checkUses);
  };
  checkUses(file);
  return { results: [...results], escapes };
}

const CAPABILITY_GATING = path.resolve(__dirname, "..", "..", "payments", "__tests__", "capability-gating.test.ts");

let gatingCache: Map<string, string> | null = null;

/**
 * Each Payments capability method's `gate` in the `GATING` table of
 * src/lib/payments/__tests__/capability-gating.test.ts
 * ("refuses-when-disabled" or "available-while-disabled"), which that test
 * checks against the capability itself. It is read from the source because
 * importing a test file runs its tests. If the table is renamed or stops
 * being an object literal of `{ gate: "…" }` entries, this throws; follow it.
 */
function paymentsGating(): Map<string, string> {
  if (gatingCache) return gatingCache;
  const file = ts.createSourceFile("capability-gating.test.ts", readFileSync(CAPABILITY_GATING, "utf8"), ts.ScriptTarget.Latest, true);
  let table: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "GATING") table = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(file);
  while (table && (ts.isAsExpression(table) || ts.isSatisfiesExpression(table) || ts.isParenthesizedExpression(table))) {
    table = table.expression;
  }
  if (!table || !ts.isObjectLiteralExpression(table)) {
    throw new Error(`${CAPABILITY_GATING}: no \`GATING\` object literal to read the capability's classification from`);
  }
  const gating = new Map<string, string>();
  for (const entry of table.properties) {
    const method = entry.name ? propertyKey(entry.name) : null;
    const gate = ts.isPropertyAssignment(entry) && ts.isObjectLiteralExpression(entry.initializer)
      ? entry.initializer.properties.find((field) => field.name && propertyKey(field.name) === "gate")
      : undefined;
    if (!method || !gate || !ts.isPropertyAssignment(gate) || !ts.isStringLiteralLike(gate.initializer)) {
      throw new Error(`${CAPABILITY_GATING}: cannot read the \`gate\` of GATING entry \`${entry.getText(file).split("\n")[0]}\``);
    }
    gating.set(method, gate.initializer.text);
  }
  gatingCache = gating;
  return gating;
}

/** The plugins whose routes check 4 of payments-route-boundary.test.ts holds (see `PaymentExemption`). */
const BOUNDARY_OWNERS = new Set<string>([PAYMENTS_PLUGIN_NAME, PESAPAL_PLUGIN_NAME]);

/**
 * What is wrong with a handler's exemption, given its route and its route
 * file's text. All of the file is checked, not only the handler: a helper
 * can be declared in any form, code at the top of the module runs when it
 * loads, and the handlers of one file share its module state, so any code in
 * the file can end up running for the exempt handler. A plain-string
 * exemption may not reach the Payments capability at all
 * (`capabilityReach`); a `PaymentExemption` holds the file to the one method
 * it names.
 */
function paymentExemptionProblems(exemption: string | PaymentExemption, text: string, route: string): string[] {
  const file = ts.createSourceFile("route.ts", text, ts.ScriptTarget.Latest, true);
  const reach = capabilityReach(file);
  if (typeof exemption === "string") {
    return reach.length
      ? [`reaches the Payments capability (${reach.join(", ")}); give it a PaymentExemption naming the method it calls`]
      : [];
  }
  const problems: string[] = [];
  const { reaches } = exemption;
  const owner = getRouteOwner(route)?.name;
  if (!owner || !BOUNDARY_OWNERS.has(owner)) {
    problems.push(
      `is owned by ${owner ?? "no plugin"}, so payments-route-boundary.test.ts does not check what it writes or calls; gate it instead`
    );
  }
  const gate = paymentsGating().get(reaches);
  if (gate !== "available-while-disabled") {
    problems.push(
      gate === undefined
        ? `${reaches} is not classified in capability-gating.test.ts`
        : `${reaches} refuses a disabled plugin; an exemption is for a method that runs while it is off`
    );
  }
  const composition = compositionEscapes(file);
  if (!composition.results.length) problems.push("does not compose Payments, so it reaches no capability method");
  const calls = capabilityCalls(file);
  const escapes = [...calls.escapes, ...composition.escapes];
  if (escapes.length) problems.push(`hands the capability on: ${escapes.join("; ")}`);
  if (calls.methods.join() !== reaches) {
    problems.push(`calls ${calls.methods.join(", ") || "nothing"} on the capability, not just ${reaches}`);
  }
  const other = reach.filter((found) => !PAYMENT_COMPOSERS.has(found) && modulePath(found) !== COMPOSE_MODULE);
  if (other.length) problems.push(`reaches the capability other than through a composer (${other.join(", ")})`);
  return problems;
}

/**
 * The problems with each exemption a route file's handlers carry, keyed
 * `METHOD /api/route` as in UNGATED_WRITES. Handlers without one are left out.
 */
function exemptionProblems(
  text: string,
  route: string,
  exemptions: Record<string, string | PaymentExemption> = UNGATED_WRITES
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const method of handlerSources(text).keys()) {
    const key = `${method} ${route.replace(/\[[^\]]+\]/g, "[id]")}`;
    if (Object.hasOwn(exemptions, key)) result.set(key, paymentExemptionProblems(exemptions[key], text, route));
  }
  return result;
}

const routes = collectRoutes(API_ROOT).map((file) => ({ file, route: routePath(file) }));

describe("MGM runtime route surface", () => {
  it("rejects a gate whose blocked response is ignored, including commented calls", () => {
    expect(gatesPlugin('export async function POST() { const gate = await gateRoute(db, { plugin: "billing" }); mutate(); }', "billing")).toBe(false);
    expect(gatesPlugin('export async function POST() { /* gateRoute(db, { plugin: "billing" }) */ mutate(); }', "billing")).toBe(false);
    expect(gatesPlugin('export async function POST() { const gate = await gateRoute(db, { plugin: "billing" }); if (gate) return gate; mutate(); }', "billing")).toBe(true);
    expect(entersRuntime('export async function POST() { /* composeBilling({}) */ mutate(); }', "billing")).toBe(false);
    expect(gatesPlugin('export async function POST() { const gate = await checkGate(db, { plugin: "billing" }); if (!gate.ok) return gateResponse(gate); mutate(); }', "billing")).toBe(true);
  });

  it("does not count a composer call that skips the plugin check", () => {
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ supabase, organizationId }); }', "billing")).toBe(true);
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ supabase, organizationId, readOnly: false }); }', "billing")).toBe(true);
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ supabase, organizationId, readOnly: true }); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ supabase, organizationId, readOnly }); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ supabase, organizationId, "readOnly": true }); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ supabase, organizationId, ["readOnly"]: true }); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ supabase, organizationId, [key]: true }); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composeBilling({ ...options }); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composeBilling(options); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composeBillingReview({ supabase, organizationId }); }', "billing")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composePayments({ supabase, organizationId }); }', "payments")).toBe(false);
    expect(entersRuntime('export async function POST() { const c = await composePaymentsPublic({ supabase, organizationId }); }', "pesapal")).toBe(false);
    expect(entersRuntime('export async function POST() { const gate = await checkGate(db, { plugin: "payments" }); if (!gate.ok) return gateResponse(gate); const c = await composePayments({ supabase, organizationId }); }', "payments")).toBe(true);
    expect(entersRuntime('export async function POST() { const gate = await checkGate(db, { plugin: "billing" }); if (!gate.ok) return gateResponse(gate); const c = await composeBilling({ supabase, organizationId, readOnly: true }); }', "billing")).toBe(true);
  });

  // Inline route files for the payment exemption checks, run the way the
  // real check runs them (`exemptionProblems`).
  const exemption: PaymentExemption = { reason: "test", reaches: "refreshPaymentStatus" };
  const IMPORTS = 'import { NextResponse } from "next/server";\nimport { composePayments } from "@/lib/payments/compose";\n';
  const handler = (body: string) =>
    `export async function POST() { const composed = await composePayments({ supabase, organizationId }); ${body} }`;
  const CALL = "await composed.data.payments.refreshPaymentStatus(id);";
  const check = (file: string, entry: string | PaymentExemption = exemption, route = "/api/payments/test") =>
    (exemptionProblems(file, route, { [`POST ${route}`]: entry }).get(`POST ${route}`) ?? ["no POST handler"]).join("\n");
  const problems = (body: string, entry: string | PaymentExemption = exemption, imports = "") =>
    check(IMPORTS + imports + handler(body), entry);

  it("holds a payment exemption to the method it names", () => {
    expect(problems(CALL)).toBe("");
    expect(problems(`if (!composed.ok) return NextResponse.json({ error: composed.message, reason: composed.code }, { status: composed.status }); ${CALL} await composed.data.dispose().catch(() => {});`))
      .toBe("");
    // Another capability method, instead or as well.
    expect(problems("await composed.data.payments.ensureCheckout(id);")).toMatch(/calls ensureCheckout on the capability, not just refreshPaymentStatus/);
    expect(problems(`${CALL} await composed.data.payments.reconcile(id, {});`)).toMatch(/calls reconcile, refreshPaymentStatus/);
    // The capability handed on, so it could call anything.
    expect(problems("const { payments } = composed.data; await payments.refreshPaymentStatus(id);")).toMatch(/hands the capability on/);
    expect(problems('await composed.data["payments"].refreshPaymentStatus(id);')).toMatch(/hands the capability on/);
    expect(problems("const p = composed.data.payments; await p.refreshPaymentStatus(id);")).toMatch(/hands the capability on/);
    expect(problems("let p; ({ payments: p } = composed.data); await p.refreshPaymentStatus(id);"))
      .toMatch(/hands the capability on: composed\.data$/m);
    // The name `payments` where it cannot hold the capability: a new object's key, a label.
    expect(problems(`${CALL} console.info("payments", { payments: [] }); return NextResponse.json({ "payments": [] });`)).toBe("");
    // The composition used other than for its outcome, the method and dispose.
    expect(problems("const { data } = composed; await data.payments.refreshPaymentStatus(id);")).toMatch(/hands the capability on: \{ data \} = composed/);
    expect(problems(`${CALL} void composed.data.scope;`)).toMatch(/hands the capability on: composed\.data\.scope/);
    expect(problems(`${CALL} await settle(composed);`)).toMatch(/hands the capability on: settle\(composed\)/);
    expect(problems("const compose = composePayments; const c = await compose({ supabase, organizationId }); await c.data.payments.refreshPaymentStatus(id);"))
      .toMatch(/hands the capability on: compose = composePayments/);
    expect(problems(`${CALL} let other = await composePayments({ supabase, organizationId }); void other;`)).toMatch(/hands the capability on/);
    // A composer imported under another name, which the checks above would not follow.
    expect(check('import { composePayments as open } from "@/lib/payments/compose";\nexport async function POST() { const c = await open({ supabase, organizationId }); await c.data.payments.refreshPaymentStatus(id); void c.data.scope; }'))
      .toMatch(/hands the capability on: composePayments as open/);
    // A way to the capability other than a composer.
    expect(problems(CALL, exemption, 'import { PaymentsPlugin } from "@/lib/payments/compose";\n')).toMatch(/other than through a composer \(PaymentsPlugin\)/);
    expect(problems(`${CALL} await new PaymentsCapability(repository, scope, providers).ensureCheckout(id);`))
      .toMatch(/other than through a composer \(PaymentsCapability\)/);
    expect(problems(`${CALL} const m = await import("@/lib/payments/compose");`)).toMatch(/other than through a composer \(.*import\(\)/);
    // A gated method is not an exemption, and an exemption must reach its method.
    expect(problems("await composed.data.payments.ensureCheckout(id);", { ...exemption, reaches: "ensureCheckout" }))
      .toMatch(/ensureCheckout refuses a disabled plugin/);
    expect(check(`${IMPORTS}export async function POST() { mutate(); }`)).toMatch(/does not compose Payments/);
    // A route payments-route-boundary.test.ts does not hold.
    expect(check(IMPORTS + handler(CALL), exemption, "/api/billing-line-items/[id]/test")).toMatch(/is owned by billing/);
    expect(check(IMPORTS + handler("await composed.data.payments.handleNotification(raw);"), { ...exemption, reaches: "handleNotification" }, "/api/payments/ipn"))
      .toBe("");
  });

  it("checks all of an exempt route's file, whatever form its code takes", () => {
    const OTHER = "await composed.data.payments.ensureCheckout(id);";
    const COMPOSED = "const composed = await composePayments({ supabase, organizationId });";
    // A helper the handler uses, declared before it in each form a declaration can take.
    const helpers: [declaration: string, use: string][] = [
      [`const helper: () => Promise<void> = async () => { ${COMPOSED} ${OTHER} };`, "await helper();"],
      [`let helper = async () => { ${COMPOSED} ${OTHER} };`, "await helper();"],
      [`class Helper { static async run() { ${COMPOSED} ${OTHER} } }`, "await Helper.run();"],
      [`const helpers: Record<string, () => Promise<void>> = { run: async () => { ${COMPOSED} ${OTHER} } };`, "await helpers.run();"],
    ];
    for (const [declaration, use] of helpers) {
      expect(check(`${IMPORTS}${declaration}\n${handler(`${CALL} ${use}`)}`), declaration).toMatch(/calls ensureCheckout, refreshPaymentStatus/);
    }
    // Code that runs when the module loads, and a sibling handler sharing the module's state.
    expect(check(`${IMPORTS}${COMPOSED}\n${OTHER}\n${handler(CALL)}`)).toMatch(/calls ensureCheckout, refreshPaymentStatus/);
    expect(check(`${IMPORTS}export async function GET() { const composed = await composePayments({ supabase, organizationId }); return composed.data.payments.listHistory(id); }\n${handler(CALL)}`))
      .toMatch(/calls listHistory, refreshPaymentStatus/);
    // The webhook's shape: a named handler exported as POST.
    expect(check(`${IMPORTS}export async function processNotification() { ${COMPOSED} ${CALL} }\nexport const POST = processNotification;`))
      .toBe("");
  });

  it("keeps a plain-string exemption away from the capability under any name", () => {
    const allowed = "Allowed while disabled.";
    const reaches = /reaches the Payments capability .*give it a PaymentExemption/;
    expect(problems(CALL, allowed)).toMatch(reaches);
    expect(check('import { composePayments as open } from "@/lib/payments/compose";\nexport async function POST() { const c = await open({ supabase, organizationId }); await c.data.payments.ensureCheckout(id); }', allowed))
      .toMatch(reaches);
    expect(check('import { composePayments } from "@/lib/payments/compose";\nconst open: typeof composePayments = composePayments;\nexport async function POST() { const c = await open({ supabase, organizationId }); }', allowed))
      .toMatch(reaches);
    expect(check('import { PaymentsCapability } from "@/lib/payments/capability";\nexport async function POST() { await new PaymentsCapability(repository, providers).ensureCheckout(id); }', allowed))
      .toMatch(reaches);
    expect(check('export * from "@/lib/payments/compose";\nexport async function POST() { return gone(); }', allowed)).toMatch(reaches);
    expect(check('export async function POST() { const m = await import("@/lib/payments/" + "compose"); }', allowed))
      .toMatch(/reaches the Payments capability \(import\(\)\)/);
    expect(check("export async function POST() { const m = require(name); }", allowed)).toMatch(/reaches the Payments capability \(require\)/);
    // A module named by any path that resolves to it.
    expect(check('import * as m from "@/lib/payments/./compose";\nexport async function POST() { const open = m["compose" + "Payments"]; const c = await open({ supabase, organizationId }); await c.data.payments.ensureCheckout(id); }', allowed))
      .toMatch(reaches);
    expect(check('import * as m from "@/lib/payments/compose/../compose";\nexport async function POST() { const { ["compose" + "Payments"]: open } = m; void open; }', allowed))
      .toMatch(reaches);
    expect(check('import * as m from "@/lib//payments/Capability.ts?v=1";\nexport async function POST() { void m; }', allowed)).toMatch(reaches);
    // A type-only import loads nothing.
    expect(check('import type { PaymentsResult } from "@/lib/payments/compose";\nexport async function POST() { return gone(); }', allowed)).toBe("");
    expect(check("export async function POST() { return gone(); }", "Retired.")).toBe("");
  });

  it("finds the API routes", () => {
    expect(routes.length).toBeGreaterThan(55);
  });

  it("assigns every API route to one bundled plugin", () => {
    const unowned = routes
      .filter(({ route }) => !UNOWNED.has(route) && !getRouteOwner(route))
      .map(({ route }) => route);
    expect(unowned, "Add the route to a plugin's `routes` in src/lib/plugins/bundled.ts").toEqual([]);
  });

  it("enters the runtime from every write handler of a non-core plugin", () => {
    const offenders: string[] = [];
    for (const { file, route } of routes) {
      const owner = getRouteOwner(route);
      if (!owner || owner.core) continue;
      const sources = handlerSources(readFileSync(file, "utf8"));
      for (const [method, source] of sources) {
        const externalGet = method === "GET" && EXTERNAL_GETS.has(route);
        if (!(WRITE_METHODS as readonly string[]).includes(method) && !externalGet) continue;
        if (externalGet && !/access:\s*"write"/.test(source)) {
          offenders.push(`GET ${route} must classify integration access as write`);
        }
        const key = `${method} ${route.replace(/\[[^\]]+\]/g, "[id]")}`;
        if (UNGATED_WRITES[key]) continue;
        if (!entersRuntime(source, owner.name)) offenders.push(`${key} (${owner.name})`);
      }
    }
    expect(
      offenders,
      "Call gateRoute(...) with the owning plugin, compose its capability, or document an exemption"
    ).toEqual([]);
  });

  it("inventories every GET that constructs a vendor client", () => {
    const external = routes.filter(({ file }) => {
      const source = handlerSources(readFileSync(file, "utf8")).get("GET") ?? "";
      return /\bcreateOpenEmsClient\(/.test(source);
    }).map(({ route }) => route).sort();
    expect(external).toEqual([...EXTERNAL_GETS].sort());
  });

  it("reads the capability's classification from capability-gating.test.ts", () => {
    const gating = paymentsGating();
    expect(gating.get("ensureCheckout")).toBe("refuses-when-disabled");
    expect(gating.get("refreshPaymentStatus")).toBe("available-while-disabled");
  });

  it("holds each payment exemption to the method it names", () => {
    const offenders: string[] = [];
    const checked = new Set<string>();
    for (const { file, route } of routes) {
      for (const [key, found] of exemptionProblems(readFileSync(file, "utf8"), route)) {
        checked.add(key);
        offenders.push(...found.map((problem) => `${key}: ${problem}`));
      }
    }
    expect(offenders, "Fix the route, or its exemption").toEqual([]);
    expect(Object.keys(UNGATED_WRITES).filter((key) => !checked.has(key))).toEqual([]);
  });

  it("keeps every exemption pointed at a real write handler", () => {
    const known = new Set<string>();
    for (const { file, route } of routes) {
      for (const method of handlerSources(readFileSync(file, "utf8")).keys()) {
        known.add(`${method} ${route.replace(/\[[^\]]+\]/g, "[id]")}`);
      }
    }
    expect(Object.keys(UNGATED_WRITES).filter((key) => !known.has(key))).toEqual([]);
  });
});
