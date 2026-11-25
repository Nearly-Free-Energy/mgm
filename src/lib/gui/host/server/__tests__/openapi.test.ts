/**
 * The OpenAPI document of the described API (../openapi.ts), against the
 * registry it is generated from and the committed docs/api/openapi.json:
 * - the committed file is what the runtime root's surface snapshot
 *   generates, byte for byte, so a change to an action, a host schema, a
 *   host route's entry or an error code fails here until the file is
 *   written again with `npm run api:openapi` (which runs this file with
 *   MGM_WRITE_OPENAPI=1, writing the file before it compares);
 * - the document lists every registered action once, under its route, as
 *   the action catalog describes it, and every host route file under
 *   src/app/api/gui with the methods it exports;
 * - its references resolve, its path parameters match its paths, and the
 *   gate's codes it names on an action route agree with UNGATED_WRITES;
 * - generating it is deterministic, whatever order the registry holds
 *   things in.
 * The self-tests feed the generator actions the registry does not hold yet:
 * several on one route, one that runs while its plugin is off, an
 * unreleased route and a plugin's own kind of record.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { GUI_CONTRACT, type Json } from "@/lib/gui/contract";
import type { ActionDef } from "@/lib/gui/surface";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import { UNGATED_WRITES, apiRouteFiles, exemptionKey } from "@/lib/runtime/__tests__/route-rules";
import { describeAction } from "../catalog";
import { HOST_CODES, listedCodes } from "../error-codes";
import { HOST_ROUTES, HOST_SCHEMAS, openApiDocument, renderOpenApi, type DescribedSurface, type OpenApiDocument } from "../openapi";
import type { RegisteredAction } from "../surface-registry";

const REPO = path.resolve(__dirname, "../../../../../..");
const DOCUMENT = "docs/api/openapi.json";
const WRITE = process.env.MGM_WRITE_OPENAPI === "1";

type Obj = Record<string, Json>;
type Operation = Obj & { responses: Record<string, Obj>; "x-mgm-actions"?: Obj[]; parameters?: Obj[] };

const operations = (doc: OpenApiDocument) =>
  Object.entries(doc.paths as Record<string, Record<string, Operation>>).flatMap(([p, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path: p, method, op })),
  );
const codesOf = (op: Operation) => Object.values(op.responses).flatMap((r) => (r["x-mgm-codes"] as string[] | undefined) ?? []);

/** The JSON Pointer of the first place `a` and `b` differ, or null when they are equal. */
function firstDifference(a: unknown, b: unknown, at = ""): string | null {
  if (a === b) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return at || "/";
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) {
    const found = firstDifference((a as Obj)[key], (b as Obj)[key], `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    if (found) return found;
  }
  return Object.keys(a).join() === Object.keys(b).join() ? null : `${at || "/"} (key order)`;
}

/** Every `$ref` in `doc` that does not resolve, and every keyword an inline schema of an OpenAPI document should not carry. */
function referenceProblems(doc: Json): string[] {
  const problems: string[] = [];
  const resolve = (ref: string): boolean => {
    let node: Json | undefined = doc;
    for (const raw of ref.slice(2).split("/")) {
      const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
      if (node === null || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, key)) return false;
      node = node[key];
    }
    return true;
  };
  const walk = (node: Json, at: string) => {
    if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${at}/${i}`));
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      // Extensions carry data as the catalog serves it, not schemas of the document.
      if (key.startsWith("x-")) continue;
      if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/") || !resolve(child))) problems.push(`${at}: ${String(child)}`);
      if (key === "$defs" || key === "$id" || key === "$schema") problems.push(`${at}/${key}`);
      walk(child, `${at}/${key}`);
    }
  };
  walk(doc, "");
  return problems;
}

describe("the OpenAPI document", () => {
  let surface: DescribedSurface;
  let doc: OpenApiDocument;
  let rendered: string;
  beforeAll(async () => {
    surface = (await getMgmRuntime()).mgmSurface.snapshot();
    doc = openApiDocument(surface);
    rendered = renderOpenApi(doc);
  });
  afterAll(() => resetMgmRuntimeForTests());

  it(`is the committed ${DOCUMENT}`, () => {
    const file = path.join(REPO, DOCUMENT);
    if (WRITE) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, rendered);
    }
    expect(existsSync(file), `${DOCUMENT} is missing: run npm run api:openapi`).toBe(true);
    const committed = readFileSync(file, "utf8");
    if (committed !== rendered) {
      const at = firstDifference(JSON.parse(committed), doc) ?? "its formatting";
      expect.fail(`${DOCUMENT} is not what the registry generates (first difference: ${at}). Run npm run api:openapi and commit it.`);
    }
  });

  it("is the same whatever order the registry holds actions and views in", () => {
    const reversed = { actions: new Map([...surface.actions].reverse()), views: [...surface.views].reverse() };
    expect(renderOpenApi(openApiDocument(reversed))).toBe(rendered);
  });

  it("lists every registered action once, under its route, as the catalog describes it", () => {
    const listed = operations(doc).flatMap(({ path: p, method, op }) => (op["x-mgm-actions"] ?? []).map((action) => ({ p, method, action })));
    expect(listed.map((l) => l.action.id).sort()).toEqual([...surface.actions.keys()].sort());
    for (const { p, method, action } of listed) {
      const registered = surface.actions.get(action.id as ActionDef["id"])!;
      expect(action).toEqual(JSON.parse(JSON.stringify(describeAction(registered))));
      expect(p).toBe(registered.def.path.replace(/\[([^\]]+)\]/g, "{$1}"));
      expect(method).toBe(registered.def.method.toLowerCase());
    }
  });

  it("describes every host route file under src/app/api/gui with the methods it exports", () => {
    const handler = /export\s+(?:async\s+function|function|const)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g;
    const files = apiRouteFiles(path.join(REPO, "src/app/api/gui")).flatMap(({ route, text }) =>
      [...text.matchAll(handler)].map(([, method]) => `${method} ${route}`),
    );
    expect(HOST_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(files.sort());
    const hostPaths = operations(doc).filter(({ path: p }) => p.startsWith("/api/gui/"));
    expect(hostPaths.map(({ path: p, method }) => `${method.toUpperCase()} ${p}`).sort()).toEqual(files.sort());
  });

  it("has references that resolve, schemas with no $defs, and path parameters that match its paths", () => {
    expect(referenceProblems(doc)).toEqual([]);
    for (const { path: p, method, op } of operations(doc)) {
      const named = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const params = (op.parameters ?? []).filter((x) => x.in === "path").map((x) => x.name);
      expect(params, `${method} ${p}`).toEqual(named);
    }
    const ids = operations(doc).map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the gate's codes on exactly the action routes UNGATED_WRITES does not exempt", () => {
    for (const { method, op } of operations(doc)) {
      const actions = op["x-mgm-actions"];
      if (!actions) continue;
      const key = exemptionKey(method.toUpperCase(), actions[0].path as string);
      const gateCodes = codesOf(op).filter((c) => /_(disabled|gate_unavailable)$/.test(c));
      const plugin = actions[0].plugin as string;
      const core = plugin === "organization-directory";
      expect(gateCodes.length > 0, key).toBe(!core && !Object.hasOwn(UNGATED_WRITES, key));
    }
  });

  it("names only listed codes on the host's routes, and every host code a route answers", () => {
    const plugins = ["billing", "payments", "metering", "community-management", "pesapal", "tenant-app"] as const;
    const listed = new Set(listedCodes(plugins.flatMap((p) => [[p, "disabled"] as const, [p, "unavailable"] as const])).map((c) => c.code));
    const named = new Set(operations(doc).filter(({ path: p }) => p.startsWith("/api/gui/")).flatMap(({ op }) => codesOf(op)));
    for (const code of named) expect(listed.has(code), code).toBe(true);
    for (const [code, entry] of Object.entries(HOST_CODES)) if (entry.status.length > 0) expect(named.has(code), code).toBe(true);
    const published = (doc["x-mgm-error-codes"] as Obj[]).map((c) => c.code as string);
    for (const code of named) expect(published, code).toContain(code);
  });

  it("describes each host shape the same as a request or an answer, so one schema serves both", () => {
    for (const [name, schema] of Object.entries(HOST_SCHEMAS)) {
      expect(z.toJSONSchema(schema, { io: "input" }), name).toEqual(z.toJSONSchema(schema, { io: "output" }));
    }
  });

  it("says the API is experimental while GUI_CONTRACT is 0.x, and is versioned by it", () => {
    const info = doc.info as Obj;
    expect(info.version).toBe(GUI_CONTRACT);
    expect(GUI_CONTRACT.startsWith("0.")).toBe(true);
    expect(info["x-mgm-stability"]).toBe("experimental");
    expect(info.description).toContain("Experimental while GUI_CONTRACT is 0.x");
  });
});

describe("openApiDocument, on actions the registry does not hold yet", () => {
  const Body = z.strictObject({ note: z.string().max(10), confirmation: z.strictObject({ typed: z.string() }).optional() });
  const action = (id: string, over: Record<string, unknown> = {}, plugin = "billing"): RegisteredAction =>
    ({
      plugin,
      def: {
        id,
        title: `Title of ${id}`,
        target: "lineItem",
        input: Body,
        inputVersion: 1,
        repeat: "safe",
        method: "POST",
        path: "/api/billing-line-items/[lineItemId]/usage",
        bind: { path: { lineItemId: "lineItem" } },
        risk: "money",
        confirm: "confirm",
        humanOnly: true,
        ...over,
      },
    }) as unknown as RegisteredAction;
  const generate = (...actions: RegisteredAction[]) =>
    openApiDocument({ actions: new Map(actions.map((a) => [a.def.id, a])), views: [] });
  const operationOf = (doc: OpenApiDocument, p: string, method = "post") =>
    (doc.paths as Record<string, Record<string, Operation>>)[p][method];

  it("describes the actions sent to one route as one operation, each listed as the catalog lists it", () => {
    const doc = generate(action("billing.zz-b"), action("billing.zz-a", { prepareAgainOn: ["zz_changed"] }));
    const op = operationOf(doc, "/api/billing-line-items/{lineItemId}/usage");
    expect(op["x-mgm-actions"]!.map((a) => a.id)).toEqual(["billing.zz-a", "billing.zz-b"]);
    expect(op.summary).toBe("Title of billing.zz-a; Title of billing.zz-b");
    expect(op.operationId).toBe("postBillingLineItemsLineItemIdUsage");
    expect(op["x-mgm-released"]).toBe(true);
    expect(op.parameters).toEqual([
      expect.objectContaining({ name: "lineItemId", in: "path", required: true, schema: { type: "string", format: "uuid" }, "x-mgm-entity-kind": "lineItem" }),
    ]);
    // The route's whole body, `confirmation` included, which the catalog's input leaves out.
    const body = (op.requestBody as Obj).content as Record<string, Obj>;
    expect(Object.keys((body["application/json"].schema as Obj).properties as Obj)).toEqual(["note", "confirmation"]);
    expect(op.responses["400"]["x-mgm-codes"]).toEqual(["invalid_body"]);
    expect(op.responses["409"]["x-mgm-codes"]).toEqual(["billing_disabled", "zz_changed"]);
    expect(op.responses["503"]["x-mgm-codes"]).toEqual(["billing_gate_unavailable"]);
    expect(op.responses["401"]).toEqual({ $ref: "#/components/responses/SessionRequired" });
    // A JSON object lists integer-like keys first, whatever the order they were added in.
    expect(Object.keys(op.responses)).toEqual(["400", "401", "409", "503", "2XX", "default"]);
  });

  it("names no gate code on a route its actions are sent to while their plugin is off", () => {
    const doc = generate(action("payments.zz", { whilePluginOff: "enabled" }, "payments"));
    const op = operationOf(doc, "/api/billing-line-items/{lineItemId}/usage");
    expect(codesOf(op)).toEqual(["invalid_body"]);
    expect((doc["x-mgm-error-codes"] as Obj[]).map((c) => c.code)).not.toContain("payments_disabled");
    expect(op.tags).toEqual(["payments"]);
  });

  it("marks a route this release does not serve, with middleware's plain-text 404", () => {
    const doc = generate(action("billing.zz", { path: "/api/zz-unreleased/[lineItemId]" }));
    const op = operationOf(doc, "/api/zz-unreleased/{lineItemId}");
    expect(op["x-mgm-released"]).toBe(false);
    expect(Object.keys(op.responses["404"].content as Obj)).toEqual(["text/plain"]);
    expect(operationOf(doc, "/api/gui/catalog", "get")["x-mgm-released"]).toBe(false);
  });

  it("describes a segment of a plugin's own kind with the id it takes", () => {
    const doc = generate(action("billing.zz", { bind: { path: { lineItemId: "billing.zz-kind" } } }));
    const [param] = operationOf(doc, "/api/billing-line-items/{lineItemId}/usage").parameters!;
    expect(param.schema).toEqual({ type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" });
  });

  it("refuses actions that share a route but not an input, or bind one segment to two kinds", () => {
    const other = z.strictObject({ other: z.number() });
    expect(() => generate(action("billing.zz-a"), action("billing.zz-b", { input: other }))).toThrow("share a route but not an input");
    expect(() => generate(action("billing.zz-a"), action("billing.zz-b", { bind: { path: { lineItemId: "tenant" } } }))).toThrow(
      "do not all bind [lineItemId] to one kind",
    );
  });

  it("refuses an input it cannot describe inline", () => {
    type Node = { next?: Node };
    const node: z.ZodType<Node> = z.lazy(() => z.strictObject({ next: node.optional() }));
    expect(() => generate(action("billing.zz", { input: z.strictObject({ node }) }))).toThrow("refers to a part of itself");
  });

  it("finds the first difference between two documents", () => {
    expect(firstDifference({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe("/a/b/1");
    expect(firstDifference({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe("/ (key order)");
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull();
  });
});
