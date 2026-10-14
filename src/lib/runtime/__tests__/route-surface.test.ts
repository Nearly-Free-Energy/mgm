/**
 * Route surface of the MGM runtime (docs/cordis-runtime.md § "The gate").
 *
 * For every API route — released or not, so an inherited route is ready
 * when its release opens it in src/lib/mgm/released-routes.ts:
 *   1. exactly one bundled plugin owns it (catalog `routes`), and
 *   2. every write handler of a non-core plugin enters the runtime — through
 *      a capability composer or the plugin gate — unless it is listed below
 *      with the reason it is allowed to run while its plugin is disabled.
 *
 * This is what keeps Settings → Plugins honest: a new write route that
 * forgets the gate fails the build instead of staying writable.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import * as bundled from "@/lib/plugins/bundled";
import { getRouteOwner, type MgmPluginName } from "@/lib/plugins/bundled";

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
 * Write handlers that intentionally do not consult the gate. Each needs a
 * reason a reviewer can check.
 */
const UNGATED_WRITES: Record<string, string> = {
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
};

/**
 * Composer → plugins it enters. Payments composers also serve the Pesapal
 * provider plugin, whose webhook is delivered through the Payments capability.
 */
const COMPOSERS: Record<string, MgmPluginName[]> = {
  composeCommunityManagement: ["community-management"],
  composeMetering: ["metering"],
  composeBilling: ["billing"],
  composeBillingReview: ["billing"],
  composePayments: ["payments", "pesapal"],
  composePaymentsPublic: ["payments", "pesapal"],
};

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
 * but a gate in a sibling handler does not.
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
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && COMPOSERS[node.expression.text]?.includes(owner)) composed = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return gatesPlugin(source, owner) || composed;
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
