import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { MGM_BUNDLED_PLUGINS, type BundledPlugin, type MgmPluginName } from "@/lib/plugins/bundled";
import type { Contribution } from "../../../surface";
import { BILLING_SURFACE } from "../../../__tests__/fixtures/billing-surface";
import {
  SurfaceContributionError,
  contributionSchema,
  parseContribution,
  strictProblems,
  type SurfaceCatalog,
} from "../contribution-schema";

/** The real catalog, with the fixture's page routes given to billing and a second non-core plugin. */
const SMS = {
  ...MGM_BUNDLED_PLUGINS[0],
  name: "sms-reminders" as MgmPluginName,
  alias: "sms",
  core: false,
  routes: ["/api/sms"],
} satisfies BundledPlugin;
const CATALOG: SurfaceCatalog = {
  plugins: [
    ...MGM_BUNDLED_PLUGINS.map((p) =>
      p.name === "billing" ? { ...p, routes: [...p.routes, "/microgrids/[id]/billing", "/microgrids/[id]/setup/rates"] } : p,
    ),
    SMS,
  ],
};
const REAL_CATALOG: SurfaceCatalog = { plugins: MGM_BUNDLED_PLUGINS };

/** A contribution under test is edited freely, so it is typed loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = Record<string, any>;

/** Copies plain objects and arrays; functions and zod schemas stay shared. */
function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map(copy) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) as T;
  return v;
}

function refusal(change: (c: Draft) => void, catalog = CATALOG, base: object = BILLING_SURFACE) {
  const c = copy(base) as Draft;
  change(c);
  try {
    parseContribution(c, catalog);
  } catch (error) {
    if (error instanceof SurfaceContributionError) return error;
    throw error;
  }
  throw new Error("the contribution was accepted");
}

const fn = async () => null;
const TEXT = { t: "text", text: "a" };
/** Turns views[0] and its example into a view of another kind with the given body. */
function asKind(c: Draft, kind: string, body: object) {
  c.views[0].kind = kind;
  Object.assign(c.views[0].examples[0], { kind, body });
}
const SMS_SURFACE = {
  plugin: "sms-reminders",
  entities: [{ kind: "sms.reminder", organizationOf: fn }],
  actions: [
    {
      id: "sms.send",
      title: "Send reminder",
      target: "sms.reminder",
      input: z.strictObject({ text: z.string() }),
      inputVersion: 1,
      method: "POST",
      path: "/api/sms/[reminderId]/send",
      bind: { path: { reminderId: "sms.reminder" } },
      risk: "external",
      humanOnly: true,
      confirm: "confirm",
      prepare: fn,
    },
  ],
  search: [{ prefix: "#", entity: "sms.reminder", find: fn }],
};

describe("parseContribution", () => {
  it("accepts the billing fixture and returns it unchanged", () => {
    const parsed = parseContribution(BILLING_SURFACE, CATALOG);
    expect(parsed).toEqual({ plugin: "billing", alias: "billing", contribution: BILLING_SURFACE });
    expect(parsed.contribution).toBe(BILLING_SURFACE);
  });

  it("accepts an action input with a transform, as JSON Schema describes what it reads", () => {
    const c = copy(BILLING_SURFACE) as Draft;
    c.actions[0].input = z.strictObject({ n: z.string().transform(Number) });
    expect(() => parseContribution(c, CATALOG)).not.toThrow();
  });

  it("accepts placeholder names with underscores", () => {
    const c = copy(BILLING_SURFACE) as Draft;
    Object.assign(c.actions[2], { path: "/api/billing-periods/[period_id]/close", bind: { path: { period_id: "billingPeriod" } } });
    expect(() => parseContribution(c, CATALOG)).not.toThrow();
  });

  it("accepts a plugin's own entity kinds", () => {
    expect(parseContribution(SMS_SURFACE, CATALOG).alias).toBe("sms");
  });

  it("names the plugin and each failing path in its message", () => {
    const error = refusal((c) => delete c.actions[2].prepare);
    expect(error.plugin).toBe("billing");
    expect(error.message).toContain('GUI contribution from "billing" refused');
    expect(error.message).toContain("✖ a ceremony action needs prepare\n  → at actions[2].prepare");
  });

  it("names no plugin when there is none", () => {
    expect(() => parseContribution(null, CATALOG)).toThrow('GUI contribution from "(no plugin)" refused');
  });

  // [rule, change, path, message (exact; omitted where zod writes it), catalog]
  const cases: [string, (c: Draft) => void, PropertyKey[], string?, SurfaceCatalog?][] = [
    // Strict shapes
    ["unknown top-level key", (c) => (c.extra = 1), [], 'Unrecognized key: "extra"'],
    ["unknown nested key", (c) => (c.views[0].declares.extra = 1), ["views", 0, "declares"], 'Unrecognized key: "extra"'],
    ["unknown binding key", (c) => (c.actions[0].bind.query = {}), ["actions", 0, "bind"], 'Unrecognized key: "query"'],
    ["unknown view key", (c) => (c.views[0].agnet = "read"), ["views", 0], 'Unrecognized key: "agnet"'],
    ["unknown action key", (c) => (c.actions[0].humanonly = true), ["actions", 0], 'Unrecognized key: "humanonly"'],
    ["unknown nav key", (c) => (c.nav[0].audiance = "super-admin"), ["nav", 0], 'Unrecognized key: "audiance"'],
    ["unknown signal key", (c) => (c.signals[0].budget = 1), ["signals", 0], 'Unrecognized key: "budget"'],
    ["unknown attach key", (c) => (c.views[0].attach.x = 1), ["views", 0, "attach"], 'Unrecognized key: "x"'],
    ["unknown live key", (c) => (c.views[1].live.x = 1), ["views", 1, "live"], 'Unrecognized key: "x"'],
    ["risk outside the enum", (c) => (c.actions[0].risk = "fatal"), ["actions", 0, "risk"]],
    ["icon outside the enum", (c) => (c.nav[0].icon = "rocket"), ["nav", 0, "icon"]],
    ["view kind outside the enum", (c) => (c.views[0].kind = "grid"), ["views", 0, "kind"]],
    ["a loader that is not a function", (c) => (c.views[0].load = "load"), ["views", 0, "load"], "Expected a function"],
    ["an input that is not a zod schema", (c) => (c.actions[0].input = {}), ["actions", 0, "input"], "Expected a zod schema"],
    ["inputVersion 0", (c) => (c.actions[0].inputVersion = 0), ["actions", 0, "inputVersion"]],
    ["a fractional inputVersion", (c) => (c.actions[0].inputVersion = 1.5), ["actions", 0, "inputVersion"]],
    ["a path that is not a route pattern", (c) => (c.actions[0].path = "/api/billing/../devices"), ["actions", 0, "path"], "Expected a route such as /microgrids/[id]"],
    ["a ui.* query parameter", (c) => (c.views[0].query = ["ui.tab"]), ["views", 0, "query", 0], "Expected a search parameter name"],
    ["refreshSeconds under 5", (c) => (c.views[1].live.refreshSeconds = 4), ["views", 1, "live", "refreshSeconds"]],
    [
      "staleAfterSeconds under refreshSeconds",
      (c) => (c.views[1].live.staleAfterSeconds = 10),
      ["views", 1, "live", "staleAfterSeconds"],
      "staleAfterSeconds must be at least refreshSeconds",
    ],
    ["budgetMs over 10000", (c) => (c.signals[0].budgetMs = 20_000), ["signals", 0, "budgetMs"]],
    ["budgetMs 0", (c) => (c.signals[0].budgetMs = 0), ["signals", 0, "budgetMs"]],
    ["a nav entry with neither view nor href", (c) => delete c.nav[0].view, ["nav", 0], "a nav entry needs a view, or an href with needs and legacy: true"],
    ["a nav entry with both", (c) => (c.nav[0].href = "/microgrids/[id]/billing"), ["nav", 0, "view"], "a nav entry names a view or a legacy href, not both"],
    ["a view nav entry with needs", (c) => (c.nav[0].needs = ["microgrid"]), ["nav", 0, "view"], "a nav entry names a view or a legacy href, not both"],
    // Plugin and ids
    ["an unknown plugin", (c) => (c.plugin = "acme"), ["plugin"], '"acme" is not a plugin in the catalog'],
    ["an id without the alias", (c) => (c.actions[0].id = "metering.create-period"), ["actions", 0, "id"], '"metering.create-period" must start with the alias "billing."'],
    ["an id with the alias but no dot", (c) => (c.actions[0].id = "billingx.create-period"), ["actions", 0, "id"], '"billingx.create-period" must start with the alias "billing."'],
    ["a nav id without the alias", (c) => (c.nav[0].id = "metering.x"), ["nav", 0, "id"], '"metering.x" must start with the alias "billing."'],
    ["a view id without the alias", (c) => Object.assign(c.views[2], { id: "metering.x", examples: [{ ...c.views[2].examples[0], view: "metering.x" }] }), ["views", 2, "id"], '"metering.x" must start with the alias "billing."'],
    ["a signal id without the alias", (c) => (c.signals[0].id = "metering.x"), ["signals", 0, "id"], '"metering.x" must start with the alias "billing."'],
    ["a status id without the alias", (c) => (c.status = [{ id: "metering.x", load: fn }]), ["status", 0, "id"], '"metering.x" must start with the alias "billing."'],
    ["a malformed id", (c) => (c.signals[0].id = "billing.Period Due"), ["signals", 0, "id"]],
    ["a duplicate id", (c) => (c.actions[1].id = "billing.create-period"), ["actions", 1, "id"], '"billing.create-period" is used twice'],
    ["an ext schema without the alias", (c) => (c.views[1].ext.schema = "metering.review@1"), ["views", 1, "ext", "schema"], '"metering.review@1" must start with the alias "billing."'],
    ["an entity kind without the alias", (c) => (c.entities[0].kind = "billing.reminder"), ["entities", 0, "kind"], '"billing.reminder" must start with the alias "sms."'],
    // Confirmation levels
    ["a ceremony action without prepare", (c) => delete c.actions[2].prepare, ["actions", 2, "prepare"], "a ceremony action needs prepare"],
    ["a ceremony action an assistant may propose", (c) => (c.actions[2].humanOnly = false), ["actions", 2, "humanOnly"], "a ceremony action must be humanOnly"],
    ["a typed action without prepare", (c) => Object.assign(c.actions[0], { confirm: "typed", humanOnly: true }), ["actions", 0, "prepare"], "a typed action needs prepare"],
    ["a typed action an assistant may propose", (c) => Object.assign(c.actions[0], { confirm: "typed", humanOnly: false, prepare: fn }), ["actions", 0, "humanOnly"], "a typed action must be humanOnly"],
    ["a DELETE below typed", (c) => (c.actions[0].method = "DELETE"), ["actions", 0, "confirm"], "a DELETE action needs typed or ceremony confirmation"],
    ["a DELETE an assistant may propose", (c) => (c.actions[0].method = "DELETE"), ["actions", 0, "humanOnly"], "a DELETE action must be humanOnly"],
    ["a destructive action below typed", (c) => (c.actions[0].risk = "destructive"), ["actions", 0, "confirm"], "a destructive action needs typed or ceremony confirmation"],
    ["an external action without prepare", (c) => (c.actions[0].risk = "external"), ["actions", 0, "prepare"], "an external action needs prepare"],
    ["an external action without confirm", (c) => Object.assign(c.actions[0], { risk: "external", confirm: "none", prepare: fn }), ["actions", 0, "confirm"], "an external action needs at least confirm"],
    // Segments and kinds
    ["a segment without a param", (c) => (c.views[0].params = {}), ["views", 0, "params"], 'params has no kind for the segment "id"'],
    ["a param that is not a segment", (c) => (c.views[0].params.periodId = "billingPeriod"), ["views", 0, "params", "periodId"], '"periodId" is not a segment of the path'],
    ["an entity that is not a param", (c) => (c.views[0].entity = "periodId"), ["views", 0, "entity"], "entity must name one of the params"],
    ["a path segment named twice", (c) => (c.actions[2].path = "/api/billing/[periodId]/[periodId]"), ["actions", 2, "path"], "each path segment needs its own name"],
    ["a bound path key that is not a segment", (c) => (c.actions[2].bind.path.id = "microgrid"), ["actions", 2, "bind", "path", "id"], '"id" is not a segment of the path'],
    ["an action segment left unbound", (c) => (c.actions[2].bind = {}), ["actions", 2, "bind", "path"], 'bind.path has no kind for the segment "periodId"'],
    ["another plugin's kind as a target", (c) => (c.actions[0].target = "sms.reminder"), ["actions", 0, "target"], '"sms.reminder" is neither a core entity kind nor one billing declares in entities'],
    ["another plugin's kind in a param", (c) => (c.views[0].params.id = "sms.reminder"), ["views", 0, "params", "id"]],
    ["another plugin's kind in a body binding", (c) => (c.actions[0].bind.body.microgrid_id = "sms.reminder"), ["actions", 0, "bind", "body", "microgrid_id"]],
    ["another plugin's kind in a path binding", (c) => (c.actions[2].bind.path.periodId = "sms.reminder"), ["actions", 2, "bind", "path", "periodId"]],
    ["another plugin's kind in attach", (c) => (c.views[0].attach.to = "sms.reminder"), ["views", 0, "attach", "to"]],
    ["another plugin's kind in search", (c) => (c.search = [{ prefix: "@", entity: "sms.reminder", find: fn }]), ["search", 0, "entity"]],
    // Navigation
    ["a nav entry naming a missing view", (c) => (c.nav[0].view = "billing.nope"), ["nav", 0, "view"], '"billing.nope" is not a view in this contribution'],
    ["a legacy entry whose needs miss a segment", (c) => (c.nav[1].needs = []), ["nav", 1, "needs"], "needs must name one kind for each segment of the href"],
    ["assistant reading of a configure view", (c) => (c.nav[0].group = "configure"), ["views", 0, "agent"], "a view reached from configure navigation cannot be read by an assistant"],
    ["assistant reading of a system view", (c) => (c.nav[0].group = "system"), ["views", 0, "agent"], "a view reached from system navigation cannot be read by an assistant"],
    ["assistant reading of a view on a configure legacy href", (c) => (c.nav[1].href = "/microgrids/[id]/billing"), ["views", 0, "agent"], "a view reached from configure navigation cannot be read by an assistant"],
    // Ownership
    ["a view path another plugin owns", () => {}, ["views", 0, "path"], "the catalog gives /microgrids/[id]/billing to community-management", REAL_CATALOG],
    ["a legacy href another plugin owns", () => {}, ["nav", 1, "href"], "the catalog gives /microgrids/[id]/setup/rates to community-management", REAL_CATALOG],
    ["an action path another plugin owns", (c) => (c.actions[0].path = "/api/devices"), ["actions", 0, "path"], "the catalog gives /api/devices to metering"],
    ["a path nobody owns", (c) => (c.actions[0].path = "/api/nowhere"), ["actions", 0, "path"], "no plugin in the catalog owns /api/nowhere"],
    ["two views on one path", (c) => (c.views[2].path = c.views[1].path), ["views", 2, "path"], "another view already serves /microgrids/[id]/billing/[periodId]"],
    // Schemas
    ["a loose ext schema", (c) => (c.views[1].ext.zod = z.object({ tariffVersion: z.number() })), ["views", 1, "ext", "zod"], "ext objects must be strict (z.strictObject)"],
    ["an input JSON Schema cannot describe", (c) => (c.actions[0].input = z.strictObject({ at: z.date() })), ["actions", 0, "input"], "the input cannot be described as JSON Schema: Date cannot be represented in JSON Schema"],
    // Examples
    ["a view without examples", (c) => (c.views[0].examples = []), ["views", 0, "examples"], "a view needs at least one example"],
    ["an example of another view", (c) => (c.views[0].examples[0].view = "billing.period-review"), ["views", 0, "examples", 0, "view"], "an example must name its view, billing.periods"],
    ["an example of another kind", (c) => (c.views[0].examples[0].kind = "record"), ["views", 0, "examples", 0, "kind"]],
    ["an example the model schema refuses", (c) => (c.views[0].examples[0].body.rows[0].cells.total.v = 1.5), ["views", 0, "examples", 0, "body", "rows", 0, "cells", "total", "v"]],
    ["an undeclared column", (c) => (c.views[0].declares.keys = ["period", "status", "energy", "total"]), ["views", 0, "examples", 0, "body", "columns", 2, "key"], '"bills" is not declared by the view'],
    ["an undeclared cell", (c) => (c.views[0].declares.keys = ["period", "status", "energy", "total"]), ["views", 0, "examples", 0, "body", "rows", 0, "cells", "bills"], '"bills" is not declared by the view'],
    ["an undeclared prefix", (c) => (c.views[1].declares.prefixes = []), ["views", 1, "examples", 0, "body", "rows", 0, "cells", "tier.1"], '"tier.1" is not declared by the view'],
    ["an undeclared total", (c) => (c.views[1].declares.keys = ["household", "payment"]), ["views", 1, "examples", 0, "body", "totals", "total"], '"total" is not declared by the view'],
    ["an undeclared record field", (c) => asKind(c, "record", { sections: [{ fields: [{ key: "secret", label: "S", value: TEXT }] }] }), ["views", 0, "examples", 0, "body", "sections", 0, "fields", 0, "key"], '"secret" is not declared by the view'],
    ["an undeclared tile", (c) => asKind(c, "metrics", { tiles: [{ key: "secret", label: "S", value: TEXT }] }), ["views", 0, "examples", 0, "body", "tiles", 0], '"secret" is not declared by the view'],
    ["an undeclared series", (c) => asKind(c, "metrics", { tiles: [], series: [{ key: "secret", label: "S", unit: "kW", points: [] }] }), ["views", 0, "examples", 0, "body", "series", 0], '"secret" is not declared by the view'],
    ["example ext on a view without one", (c) => delete c.views[1].ext, ["views", 1, "examples", 0, "ext"], "the view declares no ext"],
    ["example ext of another version", (c) => (c.views[1].examples[0].ext.schema = "billing.period-review@2"), ["views", 1, "examples", 0, "ext", "schema"], "expected billing.period-review@1"],
    ["example ext data the ext schema refuses", (c) => (c.views[1].examples[0].ext.data.tariffVersion = "one"), ["views", 1, "examples", 0, "ext", "data", "tariffVersion"]],
    ["an ext schema with an async check", (c) => (c.views[1].ext.zod = c.views[1].ext.zod.refine(async () => true)), ["views", 1, "examples", 0, "ext", "data"], "the ext schema cannot be checked synchronously"],
  ];

  it.each(cases)("refuses %s", (_rule, change, path, message, catalog) => {
    const isSms = path[0] === "entities";
    const error = refusal(change, catalog ?? CATALOG, isSms ? SMS_SURFACE : BILLING_SURFACE);
    expect(error.issues).toContainEqual(expect.objectContaining(message === undefined ? { path } : { path, message }));
  });
});

describe("strictProblems", () => {
  it.each([
    ["z.object", z.object({ a: z.string() })],
    ["z.looseObject", z.looseObject({ a: z.string() })],
    ["catchall", z.strictObject({}).catchall(z.string())],
    ["any", z.strictObject({ a: z.any() })],
    ["unknown", z.strictObject({ a: z.unknown() })],
    ["an open record", z.record(z.string(), z.unknown())],
    ["lazy", z.lazy(() => z.string())],
    ["a transform", z.string().transform(Number)],
    ["custom", z.custom<string>(() => true)],
    ["a loose object in a union", z.union([z.string(), z.object({})])],
    ["any in a tuple", z.tuple([z.any()])],
    ["any as a tuple's rest", z.tuple([z.string()]).rest(z.any())],
    ["any under a wrapper", z.strictObject({ a: z.any().optional() })],
    ["a nested loose object", z.strictObject({ a: z.array(z.strictObject({ b: z.object({}) })) })],
  ])("refuses %s", (_name, schema) => {
    expect(strictProblems(schema)).not.toEqual([]);
  });

  it("gives the path inside the schema", () => {
    expect(strictProblems(z.strictObject({ a: z.strictObject({ b: z.any() }) }))).toEqual([
      { path: ["a", "b"], message: "ext schemas may not use any" },
    ]);
  });

  it("accepts strict data shapes", () => {
    const schema = z.strictObject({
      nested: z.strictObject({ n: z.number().int(), s: z.string().optional() }),
      list: z.array(z.strictObject({ ok: z.boolean() })).readonly(),
      pair: z.tuple([z.string(), z.number().nullable()]),
      either: z.discriminatedUnion("t", [z.strictObject({ t: z.literal("a") }), z.strictObject({ t: z.literal("b") })]),
      byKind: z.record(z.enum(["x", "y"]), z.number()),
      level: z.enum(["low", "high"]).default("low"),
      nothing: z.null(),
    });
    expect(strictProblems(schema)).toEqual([]);
  });
});

describe("contributionSchema", () => {
  it("accepts every Contribution the contract types allow", () => {
    expectTypeOf<Contribution>().toExtend<z.input<typeof contributionSchema>>();
  });
});
