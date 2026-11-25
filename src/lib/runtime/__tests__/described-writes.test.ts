/**
 * Every write route is a described action or has a written reason (RFC #259
 * § 3, "Coverage is a build rule").
 *
 * Every POST, PUT, PATCH and DELETE handler under src/app/api whose path
 * src/lib/mgm/released-routes.ts releases is named, by its method and path,
 * by an action a plugin contributes to the GUI surface, or is listed in
 * UNDESCRIBED_WRITES (./route-rules.ts): `permanent`, with the reason the
 * route is not a person's action, or `not-yet-described`, with the issue in
 * DESCRIBING_ISSUES that will describe its owner's routes. The actions come
 * from the snapshot of the runtime root, as in gui-surface.test.ts
 * (src/lib/gui/__tests__). That test holds each action to a real, released
 * handler; this one holds each released write handler to an action or an
 * entry. Core plugins are covered too. route-surface.test.ts's gate rule
 * skips them because a core plugin cannot be turned off, which has nothing to
 * do with being described.
 *
 * It also refuses an entry an action now names, an entry whose handler is
 * gone, an entry not keyed as `exemptionKey` spells it, a permanent entry
 * with no reason, a not-yet-described entry whose issue does not list the
 * route's owner, and an issue no entry names. An entry may name a handler
 * that is not released yet, so releasing a route decides nothing new when
 * its entry is already there.
 *
 * Handlers are found with the TypeScript AST (`exportedWriteMethods`), and
 * the test checks that route-surface.test.ts's regex (`handlerSources`) finds
 * each of them too, so that test's gate rule cannot skip a write handler
 * exported in a form it does not read.
 *
 * Scope: route files under src/app/api, and only their write methods,
 * because an action is never a GET (`WriteMethod` in src/lib/gui/surface.ts).
 * `POST /payment/callback` (src/app/payment/callback/route.ts) is outside
 * src/app/api and only renders a page. Revisit if actions gain GET, if a
 * route file outside src/app/api starts writing, or if released-routes.ts
 * starts deciding release per method.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { getRouteOwner } from "@/lib/plugins/bundled";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import {
  DESCRIBING_ISSUES,
  UNDESCRIBED_WRITES,
  WRITE_METHODS,
  exemptionKey,
  exportedWriteMethods,
  handlerSources,
} from "./route-rules";

const APP = path.resolve(__dirname, "..", "..", "..", "app");

type RouteFile = { route: string; text: string };
type WriteHandler = { key: string; route: string };
/** An entry as this test reads it: loose, so a fixture can hold what `UndescribedWrite` refuses. */
type Entry = { kind: string; reason?: string; issue?: string };
interface Facts {
  handlers: readonly WriteHandler[];
  /** `exemptionKey(method, path)` of each action → the ids of the actions naming it. */
  described: ReadonlyMap<string, readonly string[]>;
  undescribed: Readonly<Record<string, Entry>>;
  issues: Readonly<Record<string, readonly string[]>>;
  released(path: string): boolean;
  owner(route: string): string | undefined;
}

/** The route files under src/app/api, each with its route as spelled there (`/api/tenants/[id]`). */
function routeFiles(dir = path.join(APP, "api")): RouteFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : routeFiles(path.join(dir, entry.name));
    if (!entry.isFile() || entry.name !== "route.ts") return [];
    return [{ route: `/${path.relative(APP, dir).split(path.sep).join("/")}`, text: readFileSync(path.join(dir, entry.name), "utf8") }];
  });
}

function writeHandlers(files: readonly RouteFile[]): WriteHandler[] {
  return files.flatMap(({ route, text }) =>
    [...exportedWriteMethods(text)].map((method) => ({ key: exemptionKey(method, route), route }))
  );
}

/** A route with each bracketed segment filled, as a request reaches it. */
const filled = (route: string) => route.replace(/\[[^\]]+\]/g, "0");

/** `METHOD /api/route` of a write method. */
const KEY_FORM = /^([A-Z]+) (\/api(?:\/[^\s/]+)+)$/;

function coverageProblems(f: Facts): string[] {
  const problems: string[] = [];
  const handlers = new Map(f.handlers.map((handler) => [handler.key, handler]));
  const listed = new Map(Object.entries(f.undescribed));
  const issues = new Map(Object.entries(f.issues));

  for (const { key, route } of f.handlers) {
    if (!f.released(filled(route)) || f.described.has(key) || listed.has(key)) continue;
    problems.push(`${key} (${f.owner(route) ?? "no owner"}): no action names it, and UNDESCRIBED_WRITES does not list it`);
  }

  for (const [key, entry] of listed) {
    const form = KEY_FORM.exec(key);
    if (!form || !WRITE_METHODS.has(form[1])) {
      problems.push(`${key}: not a \`METHOD /api/route\` key of a write method`);
      continue;
    }
    if (exemptionKey(form[1], form[2]) !== key) {
      problems.push(`${key}: spell every bracket [id], as exemptionKey does`);
      continue;
    }
    const ids = f.described.get(key);
    if (ids) {
      problems.push(`${key}: ${ids.join(", ")} ${ids.length === 1 ? "names" : "name"} it now; remove its entry`);
      continue;
    }
    const handler = handlers.get(key);
    if (!handler) {
      problems.push(`${key}: no such write handler; remove its entry`);
      continue;
    }
    if (entry.kind === "permanent") {
      if (!entry.reason?.trim()) problems.push(`${key}: a permanent entry needs its reason`);
    } else if (entry.kind === "not-yet-described") {
      const owner = f.owner(handler.route) ?? "no owner";
      const plugins = entry.issue === undefined ? undefined : issues.get(entry.issue);
      if (entry.issue === undefined) problems.push(`${key}: a not-yet-described entry needs its issue`);
      else if (!plugins) problems.push(`${key}: ${entry.issue} is not in DESCRIBING_ISSUES`);
      else if (!plugins.includes(owner)) problems.push(`${key}: ${entry.issue} describes ${plugins.join(", ")} routes, not ${owner}'s`);
    } else {
      problems.push(`${key}: kind "${entry.kind}" is neither "permanent" nor "not-yet-described"`);
    }
  }

  const named = new Set([...listed.values()].filter((entry) => entry.kind === "not-yet-described").map((entry) => entry.issue));
  for (const issue of issues.keys()) {
    if (!named.has(issue)) problems.push(`${issue}: no entry names it; remove it from DESCRIBING_ISSUES`);
  }
  return problems;
}

/** Write handlers that `handlerSources` does not find, which route-surface.test.ts's gate rule would skip. */
function finderProblems(files: readonly RouteFile[]): string[] {
  return files.flatMap(({ route, text }) => {
    const found = handlerSources(text);
    return [...exportedWriteMethods(text)]
      .filter((method) => !found.has(method))
      .map((method) =>
        `${method} ${route}: handlerSources (HANDLER_RE in route-rules.ts) does not find this handler, so route-surface.test.ts's gate rule skips it; ` +
        `export it as \`export async function ${method}\` or \`export const ${method} = <name>;\`, or teach HANDLER_RE its form`
      );
  });
}

async function repoFacts(files: readonly RouteFile[]): Promise<Facts> {
  const described = new Map<string, string[]>();
  for (const { def } of (await getMgmRuntime()).mgmSurface.snapshot().actions.values()) {
    const key = exemptionKey(def.method, def.path);
    described.set(key, [...(described.get(key) ?? []), def.id]);
  }
  return {
    handlers: writeHandlers(files),
    described,
    undescribed: UNDESCRIBED_WRITES,
    issues: DESCRIBING_ISSUES,
    released: isReleasedRoute,
    owner: (route) => getRouteOwner(route)?.name,
  };
}

// ── This repository ─────────────────────────────────────────────────────────

describe("described writes", () => {
  afterAll(() => resetMgmRuntimeForTests());
  const files = routeFiles();

  it("hold every released write handler to an action or an entry with its reason", async () => {
    expect(
      coverageProblems(await repoFacts(files)),
      "Describe the route as an action in its plugin's surface contribution, or list it in UNDESCRIBED_WRITES " +
        "(src/lib/runtime/__tests__/route-rules.ts) with the reason it is not a person's action, or the issue that will describe it"
    ).toEqual([]);
  });

  it("find every write handler with route-surface.test.ts's handler finder too", () => {
    expect(finderProblems(files)).toEqual([]);
  });
});

// ── Self-tests: each check refuses what it should ───────────────────────────

describe("the described-writes guard", () => {
  const facts = (over: Partial<Facts> = {}): Facts => ({
    handlers: [
      { key: "POST /api/things", route: "/api/things" },
      { key: "DELETE /api/things/[id]", route: "/api/things/[thingId]" },
    ],
    described: new Map(),
    undescribed: {},
    issues: {},
    released: () => true,
    owner: () => "billing",
    ...over,
  });
  const NEITHER = "no action names it, and UNDESCRIBED_WRITES does not list it";
  const PERMANENT = { kind: "permanent", reason: "Not a person's action. Wrong once a person sends it." };

  it("refuses a released write handler in neither place, naming its owner, and passes one not released", () => {
    expect(coverageProblems(facts())).toEqual([
      `POST /api/things (billing): ${NEITHER}`,
      `DELETE /api/things/[id] (billing): ${NEITHER}`,
    ]);
    // Release is asked of the route with each bracket filled, as a request reaches it.
    expect(coverageProblems(facts({ released: (p) => p === "/api/things/0" }))).toEqual([
      `DELETE /api/things/[id] (billing): ${NEITHER}`,
    ]);
    expect(coverageProblems(facts({ released: () => false }))).toEqual([]);
    expect(coverageProblems(facts({ owner: () => undefined }))[0]).toBe(`POST /api/things (no owner): ${NEITHER}`);
  });

  it("refuses an entry an action now names, however each side spells its brackets", () => {
    const key = "PATCH /api/lines/[id]/status";
    expect(exemptionKey("PATCH", "/api/lines/[lineItemId]/status")).toBe(key);
    expect(exemptionKey("PATCH", "/api/lines/[periodId]/status")).toBe(key);
    const lines = {
      handlers: [{ key: exemptionKey("PATCH", "/api/lines/[lineItemId]/status"), route: "/api/lines/[lineItemId]/status" }],
      described: new Map([[exemptionKey("PATCH", "/api/lines/[periodId]/status"), ["billing.mark-paid", "billing.mark-void"]]]),
    };
    expect(coverageProblems(facts({ ...lines, undescribed: { [key]: { kind: "not-yet-described", issue: "#280" } }, issues: { "#280": ["billing"] } })))
      .toEqual([`${key}: billing.mark-paid, billing.mark-void name it now; remove its entry`]);
    expect(coverageProblems(facts({ ...lines, undescribed: { [key]: PERMANENT } })))
      .toEqual([`${key}: billing.mark-paid, billing.mark-void name it now; remove its entry`]);
    // Described and not listed passes.
    expect(coverageProblems(facts(lines))).toEqual([]);
  });

  it("refuses an entry with no handler, or with a key exemptionKey would not spell", () => {
    const undescribed = {
      "POST /api/gone": PERMANENT,
      "PUT /api/things": PERMANENT,
      "DELETE /api/things/[thingId]": PERMANENT,
      "GET /api/things": PERMANENT,
      "POST things": PERMANENT,
    };
    expect(coverageProblems(facts({ undescribed, released: () => false }))).toEqual([
      "POST /api/gone: no such write handler; remove its entry",
      "PUT /api/things: no such write handler; remove its entry",
      "DELETE /api/things/[thingId]: spell every bracket [id], as exemptionKey does",
      "GET /api/things: not a `METHOD /api/route` key of a write method",
      "POST things: not a `METHOD /api/route` key of a write method",
    ]);
  });

  it("lets an entry name a handler that is not released yet", () => {
    const undescribed = { "POST /api/things": PERMANENT, "DELETE /api/things/[id]": { kind: "not-yet-described", issue: "#280" } };
    expect(coverageProblems(facts({ undescribed, issues: { "#280": ["billing"] }, released: () => false }))).toEqual([]);
    expect(coverageProblems(facts({ undescribed, issues: { "#280": ["billing"] } }))).toEqual([]);
  });

  it("keeps each issue to its own plugins' routes, each kind to its fields, and every issue to an entry", () => {
    expect(coverageProblems(facts({
      undescribed: {
        "POST /api/things": { kind: "not-yet-described", issue: "#278" },
        "DELETE /api/things/[id]": { kind: "not-yet-described", issue: "#999" },
      },
      issues: { "#278": ["community-management"], "#281": ["organization-directory"] },
    }))).toEqual([
      "POST /api/things: #278 describes community-management routes, not billing's",
      "DELETE /api/things/[id]: #999 is not in DESCRIBING_ISSUES",
      "#281: no entry names it; remove it from DESCRIBING_ISSUES",
    ]);
    expect(coverageProblems(facts({
      undescribed: {
        "POST /api/things": { kind: "not-yet-described" },
        "DELETE /api/things/[id]": { kind: "permanent", reason: "  " },
      },
    }))).toEqual([
      "POST /api/things: a not-yet-described entry needs its issue",
      "DELETE /api/things/[id]: a permanent entry needs its reason",
    ]);
    expect(coverageProblems(facts({ undescribed: { "POST /api/things": { kind: "exempt", reason: "Because." } }, released: () => false })))
      .toEqual(['POST /api/things: kind "exempt" is neither "permanent" nor "not-yet-described"']);
  });

  it("finds a write handler in every export form, and only write handlers", () => {
    const text = [
      'import { build } from "@/lib/entity-deletion/factory";',
      'export const dynamic = "force-dynamic";',
      "export async function GET() { return new Response(); }",
      "export async function PATCH() { return new Response(); }",
      "async function processNotification() { return new Response(); }",
      "export const POST = processNotification;",
      'export const DELETE = build({ kind: "thing" });',
      "const h = async () => new Response();",
      "export { h as PUT };",
    ].join("\n");
    expect([...exportedWriteMethods(text)].sort()).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
    expect([...exportedWriteMethods("export const POST = async (request: Request) => new Response();")]).toEqual(["POST"]);
    expect([...exportedWriteMethods('export { DELETE } from "./shared";')]).toEqual(["DELETE"]);
    expect([...exportedWriteMethods("export const { POST, GET } = handlers;")]).toEqual(["POST"]);
    expect([...exportedWriteMethods("export function HEAD() {}\nexport type POST = string;\nfunction PUT() {}\nexport { type PATCH };")]).toEqual([]);
    expect(() => exportedWriteMethods('export * from "./shared";')).toThrow(/export them by name/);
    expect(writeHandlers([{ route: "/api/things/[thingId]", text }]).map((h) => h.key).sort()).toEqual([
      "DELETE /api/things/[id]",
      "PATCH /api/things/[id]",
      "POST /api/things/[id]",
      "PUT /api/things/[id]",
    ]);
  });

  it("flags a write handler that handlerSources does not find", () => {
    const text = 'export const DELETE = buildDeleteHandler({ kind: "thing" });\nexport async function PATCH() { return new Response(); }';
    const problems = finderProblems([{ route: "/api/things/[id]", text }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^DELETE \/api\/things\/\[id\]: handlerSources \(HANDLER_RE in route-rules\.ts\) does not find this handler/);
  });
});
