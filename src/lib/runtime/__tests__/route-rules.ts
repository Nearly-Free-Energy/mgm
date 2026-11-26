/**
 * The route lists and route-file helpers the route tests share:
 * route-surface.test.ts and described-writes.test.ts (both here), and
 * gui-surface.test.ts (src/lib/gui/__tests__).
 *
 * - The gate exemptions (UNGATED_WRITES), which plugins may hold a
 *   PaymentExemption, and the Payments capability's gating as
 *   capability-gating.test.ts classifies it. gui-surface.test.ts reads the
 *   exemptions and the gating to decide which actions and views may declare
 *   `whilePluginOff` (src/lib/gui/surface.ts).
 * - The write routes no action describes (UNDESCRIBED_WRITES), and the
 *   issues that will describe them (DESCRIBING_ISSUES).
 * - How the route files under src/app/api are found (`apiRouteFiles`), and
 *   how a route file's handlers and their code are found.
 *
 * Kept here so no test imports another, which would run its tests twice.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { PaymentsCapabilityContract } from "@/lib/payments/repository";
import {
  BILLING_PLUGIN_NAME,
  COMMUNITY_MANAGEMENT_PLUGIN_NAME,
  METERING_PLUGIN_NAME,
  ORGANIZATION_DIRECTORY_PLUGIN_NAME,
  PAYMENTS_PLUGIN_NAME,
  PESAPAL_PLUGIN_NAME,
  type MgmPluginName,
} from "@/lib/plugins/bundled";

/**
 * A handler's key in UNGATED_WRITES and UNDESCRIBED_WRITES: `METHOD /api/route`,
 * every bracket spelled `[id]`.
 */
export function exemptionKey(method: string, route: string): string {
  return `${method} ${route.replace(/\[[^\]]+\]/g, "[id]")}`;
}

/**
 * An exemption for a write route that reaches the Payments capability. Its
 * reason is not taken on trust: route-surface.test.ts's "holds each payment
 * exemption to the method it names" checks that the route file (all of it, not only the handler)
 * composes Payments, calls exactly `reaches` on the capability, hands
 * neither the capability nor its composition on, and consults no plugin gate
 * (the GUI host keeps an action declaring `whilePluginOff` enabled on the
 * exemption's word that the route accepts it while off). What `reaches` may write or
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
export type PaymentExemption = {
  reason: string;
  /** The one capability method the route calls. It may not refuse a disabled plugin. */
  reaches: keyof PaymentsCapabilityContract;
};

/**
 * Write handlers that intentionally do not consult the gate. Each needs a
 * reason a reviewer can check; a handler that reaches the Payments
 * capability needs a `PaymentExemption`, which the test checks too.
 */
export const UNGATED_WRITES: Record<string, string | PaymentExemption> = {
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

/**
 * The issues that describe the write routes still in UNDESCRIBED_WRITES, each
 * with the plugins whose routes it describes. An issue leaves this map in the
 * pull request that removes its last entry; described-writes.test.ts fails
 * while an issue stays with no entry, so after that nothing can be listed
 * under it.
 */
export const DESCRIBING_ISSUES = {
  /** ACM B4: describe community management's actions. */
  "#278": [COMMUNITY_MANAGEMENT_PLUGIN_NAME],
  /** ACM B5: describe metering's actions. */
  "#279": [METERING_PLUGIN_NAME],
  /** ACM B7: describe the organization directory's and users' actions. */
  "#281": [ORGANIZATION_DIRECTORY_PLUGIN_NAME],
  /** ACM B9: make billing's and payments' person routes into actions. */
  "#310": [BILLING_PLUGIN_NAME, PAYMENTS_PLUGIN_NAME],
} as const satisfies Record<`#${number}`, readonly MgmPluginName[]>;

/**
 * Why no action names a write route. `permanent`: the route is not a
 * person's action (no person sends it, or it writes nothing: an action is a
 * write a person confirms, and RFC #259 § 3 serves reads as views), and its
 * reason says why and what would make that wrong ("Wrong once …", which
 * described-writes.test.ts requires).
 * `not-yet-described`: the issue that will describe it.
 */
export type UndescribedWrite =
  | { kind: "permanent"; reason: string }
  | { kind: "not-yet-described"; issue: keyof typeof DESCRIBING_ISSUES };

/**
 * Write handlers that no action names (RFC #259 § 3, "Coverage is a build
 * rule"). described-writes.test.ts holds every POST, PUT, PATCH and DELETE
 * handler under src/app/api on a released path to an action whose method and
 * path name it, or to an entry here, keyed as UNGATED_WRITES is. An entry may
 * name a handler that is not released yet.
 *
 * A `not-yet-described` entry's issue must list the route's owner in
 * DESCRIBING_ISSUES. The pull request that describes the route removes its
 * entry: the test fails while an action names a listed route. A new entry of
 * either kind is a change to a code-owned file, and that review is what keeps
 * a new route from being parked here under an open issue; the test checks the
 * issue's plugins, not when the route was written.
 *
 * One block per kind and per issue, each sorted by route, and a route's
 * methods in the order POST, PUT, PATCH, DELETE, so the pull requests for
 * each issue touch only their own lines.
 */
export const UNDESCRIBED_WRITES: Readonly<Record<string, UndescribedWrite>> = {
  // ── Permanent: not a person's action ──
  // A POST that writes nothing is here rather than an action: what it
  // answers is a read, and the twice-sent test (repeat.db.test.ts) can show
  // no action "safe" whose first send writes nothing.
  "POST /api/auth/sign-in-link": {
    kind: "permanent",
    reason:
      "Emails a sign-in link to someone who has no session yet (RFC #186), while an action is offered to a signed-in person. Wrong once it reads the caller's session.",
  },
  "POST /api/communities/[id]/invoice-preview": {
    kind: "permanent",
    reason:
      "A preview that writes nothing: it renders the invoice settings form's unsaved state to a PDF for the person to look at, stores nothing and is answered while billing is off (its UNGATED_WRITES reason). Wrong once it stores anything.",
  },
  "PUT /api/communities/[id]/payment": {
    kind: "permanent",
    reason:
      "A stub that refuses every request (400 for a malformed id, 404 for a community the caller cannot see, else 409 use_organization_payment_settings) and writes nothing; no page calls it. Wrong once it does anything but refuse.",
  },
  "POST /api/gui/prepare": {
    kind: "permanent",
    reason:
      "The GUI host's own step: builds an action's form and confirmation and writes nothing, and the action's write goes to the action's own route. Wrong once prepare writes.",
  },
  "POST /api/mgm/bootstrap": {
    kind: "permanent",
    reason:
      "First-run setup: creates the first organization for the holder of the deployment's bootstrap token, before any organization exists to offer an action in, and answers 409 after. Wrong once it acts after the first organization exists.",
  },
  "POST /api/payments/ipn": {
    kind: "permanent",
    reason:
      "The payment provider's server-to-server notification, sent with no session; no person sends it. Wrong once it reads the caller's session or acts for a signed-in person.",
  },
  "POST /api/payments/reconcile-worker": {
    kind: "permanent",
    reason:
      "The scheduled worker that retries stored provider notifications, authenticated by its header secret with no session. Wrong once a signed-in person can run it.",
  },

  // ── Not yet described: #278 (ACM B4), community management ──
  "POST /api/communities": { kind: "not-yet-described", issue: "#278" },
  "PATCH /api/communities/[id]": { kind: "not-yet-described", issue: "#278" },
  "DELETE /api/communities/[id]": { kind: "not-yet-described", issue: "#278" },
  "POST /api/microgrids": { kind: "not-yet-described", issue: "#278" },
  "PATCH /api/microgrids/[id]": { kind: "not-yet-described", issue: "#278" },
  "DELETE /api/microgrids/[id]": { kind: "not-yet-described", issue: "#278" },
  "PATCH /api/tenants/[id]": { kind: "not-yet-described", issue: "#278" },
  "DELETE /api/tenants/[id]": { kind: "not-yet-described", issue: "#278" },
  "POST /api/tenants/[id]/access": { kind: "not-yet-described", issue: "#278" },
  "DELETE /api/tenants/[id]/access/[id]": { kind: "not-yet-described", issue: "#278" },
  "POST /api/tenants/with-meter": { kind: "not-yet-described", issue: "#278" },

  // ── Not yet described: #279 (ACM B5), metering ──
  // Two of these routes cannot become actions as they stand.
  // `POST /api/openems/channels` is not released: released-routes.ts does not
  // open /api/openems/*, and gui-surface.test.ts refuses an action on an
  // unreleased route (check 4), so describing it means releasing
  // /api/openems/* first. It is listed so #279 decides it with the rest of
  // metering's routes. `POST /api/edges` is retired (it always answers 410)
  // and carries a plain-string gate exemption in UNGATED_WRITES above, and
  // gui-surface.test.ts refuses an action on such a route (check 3). If
  // released-routes.ts opens /api/openems/*, or check 3 or 4 changes, revisit
  // this note.
  "POST /api/devices": { kind: "not-yet-described", issue: "#279" },
  "PATCH /api/devices/[id]": { kind: "not-yet-described", issue: "#279" },
  "POST /api/edges": { kind: "not-yet-described", issue: "#279" },
  "PATCH /api/edges/[id]": { kind: "not-yet-described", issue: "#279" },
  "DELETE /api/edges/[id]": { kind: "not-yet-described", issue: "#279" },
  "POST /api/meter-readings/opening": { kind: "not-yet-described", issue: "#279" },
  "POST /api/metering/readings": { kind: "not-yet-described", issue: "#279" },
  "POST /api/microgrids/[id]/edges/register": { kind: "not-yet-described", issue: "#279" },
  "PUT /api/microgrids/[id]/openems-backend": { kind: "not-yet-described", issue: "#279" },
  "POST /api/microgrids/[id]/openems-backend/discover": { kind: "not-yet-described", issue: "#279" },
  "POST /api/microgrids/[id]/openems-backend/test": { kind: "not-yet-described", issue: "#279" },
  "POST /api/openems/channels": { kind: "not-yet-described", issue: "#279" },

  // ── Not yet described: #281 (ACM B7), organization directory and users ──
  "POST /api/organizations": { kind: "not-yet-described", issue: "#281" },
  "PATCH /api/organizations/[id]": { kind: "not-yet-described", issue: "#281" },
  "DELETE /api/organizations/[id]": { kind: "not-yet-described", issue: "#281" },
  "PUT /api/organizations/[id]/email-sender": { kind: "not-yet-described", issue: "#281" },
  "DELETE /api/organizations/[id]/email-sender": { kind: "not-yet-described", issue: "#281" },
  "PATCH /api/organizations/[id]/plugins": { kind: "not-yet-described", issue: "#281" },
  "DELETE /api/users/[id]": { kind: "not-yet-described", issue: "#281" },
  "PATCH /api/users/[id]/profile": { kind: "not-yet-described", issue: "#281" },
  "POST /api/users/[id]/resend-invite": { kind: "not-yet-described", issue: "#281" },
  "PATCH /api/users/[id]/role": { kind: "not-yet-described", issue: "#281" },
  "POST /api/users/invite": { kind: "not-yet-described", issue: "#281" },

  // ── Not yet described: #310 (ACM B9), billing's and payments' person routes ──
  // The payment-accounts route and the override PUT and DELETE carry a
  // plain-string gate exemption in UNGATED_WRITES above. gui-surface.test.ts
  // refuses an action on such a route (check 3), so describing one means
  // giving it a PaymentExemption first. If check 3 stops refusing a
  // plain-string exemption, revisit this note.
  "POST /api/billing-review/preview": { kind: "not-yet-described", issue: "#310" },
  "PATCH /api/communities/[id]/invoice-config": { kind: "not-yet-described", issue: "#310" },
  "POST /api/communities/[id]/invoice-logo": { kind: "not-yet-described", issue: "#310" },
  "PUT /api/communities/[id]/payment/override": { kind: "not-yet-described", issue: "#310" },
  "DELETE /api/communities/[id]/payment/override": { kind: "not-yet-described", issue: "#310" },
  "DELETE /api/microgrids/[id]/grid-tariffs/[id]": { kind: "not-yet-described", issue: "#310" },
  "POST /api/organizations/[id]/payment-accounts": { kind: "not-yet-described", issue: "#310" },
  "POST /api/rate-schedules": { kind: "not-yet-described", issue: "#310" },
  "PUT /api/rate-schedules/[id]": { kind: "not-yet-described", issue: "#310" },
};

/**
 * The name a property key spells (`readOnly`, `"readOnly"`, `["readOnly"]`
 * all → `readOnly`); null when it cannot be known statically.
 */
export function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
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
export function paymentsGating(): Map<string, string> {
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

/**
 * The plugins whose routes check 4 of payments-route-boundary.test.ts holds,
 * and so the only owners of a route with a PaymentExemption (see
 * `PaymentExemption`; route-surface.test.ts refuses any other). If that
 * check's `COMPOSER_OWNERS` changes, revisit.
 */
export const PAYMENT_EXEMPTION_OWNERS: ReadonlySet<string> = new Set<string>([PAYMENTS_PLUGIN_NAME, PESAPAL_PLUGIN_NAME]);

const HANDLER_RE =
  /^export\s+(?:(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\b|(?:const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*=\s*([A-Za-z_$][\w$]*)\s*;)/gm;

/** The HTTP methods of a write handler. */
export const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const APP = path.resolve(__dirname, "..", "..", "..", "app");

/** A route file under src/app/api: its route as spelled there (`/api/tenants/[id]`) and its source. */
export type RouteFile = { route: string; text: string };

/** Every `route.ts` under src/app/api, outside `__tests__` folders. */
export function apiRouteFiles(dir = path.join(APP, "api")): RouteFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : apiRouteFiles(path.join(dir, entry.name));
    if (!entry.isFile() || entry.name !== "route.ts") return [];
    return [{ route: `/${path.relative(APP, dir).split(path.sep).join("/")}`, text: readFileSync(path.join(dir, entry.name), "utf8") }];
  });
}

/**
 * The write methods a route file exports, read with the TypeScript AST so
 * that every export form counts: `export [async] function M`,
 * `export const M =` with any initializer (a named function, an arrow
 * function, a factory call), a destructured `export const { M } =`, and
 * `export { h as M }` with or without `from`. `handlerSources` below finds
 * only the first form and `export const M = name;` (HANDLER_RE);
 * described-writes.test.ts checks that it finds every method this does.
 * Throws on `export * from`, which hides what the file exports.
 */
export function exportedWriteMethods(text: string): Set<string> {
  const file = ts.createSourceFile("route.ts", text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  for (const statement of file.statements) {
    const exported = ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && exported && statement.name) names.push(statement.name.text);
    else if (ts.isVariableStatement(statement) && exported) statement.declarationList.declarations.forEach((d) => bind(d.name));
    else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (!statement.exportClause) {
        throw new Error(`\`${statement.getText(file)}\` hides which handlers the route exports; export them by name`);
      }
      // `export * as ns from` exports one namespace object, never a handler.
      if (ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) if (!specifier.isTypeOnly) names.push(specifier.name.text);
      }
    }
  }
  return new Set(names.filter((name) => WRITE_METHODS.has(name)));
}

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
 * against the whole route file instead (`paymentExemptionProblems`
 * in route-surface.test.ts).
 */
export function handlerSources(source: string): Map<string, string> {
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
