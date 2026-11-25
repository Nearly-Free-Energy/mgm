import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { MGM_BUNDLED_PLUGINS, type BundledPlugin, type MgmPluginName } from "@/lib/plugins/bundled";
import type { Contribution } from "../../../surface";
import { BILLING_SURFACE } from "../../../__tests__/fixtures/billing-surface";
import { TENANT_APP_SURFACE } from "@/lib/tenant-app/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import { ASSISTANT_READS, type AssistantRead } from "../../../assistant-reads";
import {
  ASSISTANT_READING,
  SurfaceContributionError,
  contributionSchema,
  parseContribution,
  strictProblems,
  type SurfaceCatalog,
} from "../contribution-schema";

/** The real catalog, whose billing plugin owns the fixture's pages, plus a second non-core plugin. */
const SMS = {
  ...MGM_BUNDLED_PLUGINS[0],
  name: "sms-reminders" as MgmPluginName,
  alias: "sms",
  core: false,
  routes: ["/api/sms"],
  pages: [],
} satisfies BundledPlugin;
const CATALOG: SurfaceCatalog = { plugins: [...MGM_BUNDLED_PLUGINS, SMS] };

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

function refusal(
  change: (c: Draft) => void,
  catalog = CATALOG,
  base: object = BILLING_SURFACE,
  reads?: readonly AssistantRead[],
) {
  const c = copy(base) as Draft;
  change(c);
  try {
    parseContribution(c, catalog, reads);
  } catch (error) {
    if (error instanceof SurfaceContributionError) return error;
    throw error;
  }
  throw new Error("the contribution was accepted");
}

const fn = async () => null;
/** The id of the fixture watcher's one example. */
const PERIOD_ID = "00000000-0000-4000-8000-0000000000c1";
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
      repeat: "unsafe",
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

  it("accepts an action offered only on its own plugin's views", () => {
    const c = copy(BILLING_SURFACE) as Draft;
    c.actions[0].targeted = false;
    expect(parseContribution(c, CATALOG).contribution.actions?.[0].targeted).toBe(false);
  });

  it("accepts an action kept enabled while its plugin is off, and a tab or tile listed then", () => {
    // Which plugins may declare these is checked in CI (gui-surface.test.ts), not here.
    const c = copy(BILLING_SURFACE) as Draft;
    c.actions[0].whilePluginOff = "enabled";
    c.views[0].attach.whilePluginOff = "listed";
    const parsed = parseContribution(c, CATALOG).contribution;
    expect(parsed.actions?.[0].whilePluginOff).toBe("enabled");
    expect(parsed.views?.[0].attach?.whilePluginOff).toBe("listed");
    c.views[0].attach.hint = "tile";
    expect(() => parseContribution(c, CATALOG)).not.toThrow();
  });

  it("accepts an organization's view that takes its signals", () => {
    const c = copy(BILLING_SURFACE) as Draft;
    delete c.views[0].attach;
    c.views[0].takesSignals = true;
    expect(parseContribution(c, CATALOG).contribution.views?.[0].takesSignals).toBe(true);
  });

  it("accepts an action that prepares again on codes its route answers", () => {
    // That the route answers each code is checked in CI (gui-surface.test.ts), not here.
    const c = copy(BILLING_SURFACE) as Draft;
    c.actions[2].prepareAgainOn = ["billing_period_totals_changed"];
    expect(parseContribution(c, CATALOG).contribution.actions?.[2].prepareAgainOn).toEqual(["billing_period_totals_changed"]);
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
  const cases: [string, (c: Draft) => void, PropertyKey[], string?][] = [
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
    ["an action's whilePluginOff of another value", (c) => (c.actions[0].whilePluginOff = true), ["actions", 0, "whilePluginOff"]],
    ["an action's whilePluginOff in an attachment's word", (c) => (c.actions[0].whilePluginOff = "listed"), ["actions", 0, "whilePluginOff"]],
    ["an attachment's whilePluginOff in an action's word", (c) => (c.views[0].attach.whilePluginOff = "enabled"), ["views", 0, "attach", "whilePluginOff"]],
    [
      "a section listed while its plugin is off, which it is already",
      (c) => Object.assign(c.views[0].attach, { hint: "section", whilePluginOff: "listed" }),
      ["views", 0, "attach", "whilePluginOff"],
      "a section is listed while its plugin is off already",
    ],
    [
      "a vendor view listed while its plugin is off",
      (c) => Object.assign(c.views[0], { cost: "vendor", attach: { ...c.views[0].attach, whilePluginOff: "listed" } }),
      ["views", 0, "attach", "whilePluginOff"],
      "a vendor view is refused while its plugin is off, so it cannot be listed then",
    ],
    ["takesSignals of another value", (c) => (c.views[0].takesSignals = "yes"), ["views", 0, "takesSignals"]],
    [
      "an installation view that takes signals",
      (c) => {
        delete c.views[0].attach;
        Object.assign(c.views[0], { scope: "installation", takesSignals: true });
      },
      ["views", 0, "takesSignals"],
      "only an organization's view takes its signals",
    ],
    [
      "an attached view that takes signals",
      (c) => (c.views[0].takesSignals = true),
      ["views", 0, "takesSignals"],
      "a view that takes signals is never attached to another view",
    ],
    [
      "a polled view that takes signals",
      (c) => (c.views[1].takesSignals = true),
      ["views", 1, "takesSignals"],
      "a view that takes signals does not poll",
    ],
    ["risk outside the enum", (c) => (c.actions[0].risk = "fatal"), ["actions", 0, "risk"]],
    ["targeted set to true, which is the default spelled out", (c) => (c.actions[0].targeted = true), ["actions", 0, "targeted"]],
    ["an action that does not say what a repeat does", (c) => delete c.actions[0].repeat, ["actions", 0, "repeat"]],
    ["a repeat outside the enum", (c) => (c.actions[0].repeat = "twice"), ["actions", 0, "repeat"]],
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
    ["a watcher's whilePluginOff of another value", (c) => (c.signals[0].whilePluginOff = true), ["signals", 0, "whilePluginOff"]],
    ["a watcher's whilePluginOff in an attachment's word", (c) => (c.signals[0].whilePluginOff = "listed"), ["signals", 0, "whilePluginOff"]],
    ["a watcher without examples", (c) => (c.signals[0].examples = []), ["signals", 0, "examples"], "a watcher needs at least one example"],
    ["a watcher example with a source", (c) => (c.signals[0].examples[0].source = "billing.period-due"), ["signals", 0, "examples", 0], 'Unrecognized key: "source"'],
    ["a watcher example of an unknown kind", (c) => (c.signals[0].examples[0].kind = "nudge"), ["signals", 0, "examples", 0, "kind"]],
    ["a watcher example whose href is not a path", (c) => (c.signals[0].examples[0].href = "https://example.com"), ["signals", 0, "examples", 0, "href"]],
    [
      "a watcher's examples sharing an id",
      (c) => c.signals[0].examples.push({ ...c.signals[0].examples[0] }),
      ["signals", 0, "examples", 1, "id"],
      `"${PERIOD_ID}" is used twice`,
    ],
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
    // Preparing again
    ["prepareAgainOn without prepare", (c) => (c.actions[0].prepareAgainOn = ["billing_changed"]), ["actions", 0, "prepareAgainOn"], "an action that prepares again needs prepare"],
    ["prepareAgainOn at level none", (c) => Object.assign(c.actions[0], { confirm: "none", prepare: fn, prepareAgainOn: ["billing_changed"] }), ["actions", 0, "prepareAgainOn"], "an action that prepares again needs a confirmation step"],
    ["a prepareAgainOn code listed twice", (c) => (c.actions[2].prepareAgainOn = ["billing_changed", "billing_changed"]), ["actions", 2, "prepareAgainOn"], "a code is listed twice"],
    ["a prepareAgainOn code that is not lower-case", (c) => (c.actions[2].prepareAgainOn = ["Billing-Changed"]), ["actions", 2, "prepareAgainOn", 0], "Expected a lower-case code"],
    ["an empty prepareAgainOn", (c) => (c.actions[2].prepareAgainOn = []), ["actions", 2, "prepareAgainOn"]],
    ["more than eight prepareAgainOn codes", (c) => (c.actions[2].prepareAgainOn = Array.from({ length: 9 }, (_, i) => `billing_changed_${i}`)), ["actions", 2, "prepareAgainOn"]],
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
    // Ownership
    ["a view path another plugin owns", (c) => (c.views[0].path = "/microgrids/[id]/operations"), ["views", 0, "path"], "the catalog gives /microgrids/[id]/operations to metering"],
    ["a legacy href another plugin owns", (c) => (c.nav[1].href = "/microgrids/[id]/setup/tenants"), ["nav", 1, "href"], "the catalog gives /microgrids/[id]/setup/tenants to community-management"],
    ["an action path another plugin owns", (c) => (c.actions[0].path = "/api/devices"), ["actions", 0, "path"], "the catalog gives /api/devices to metering"],
    ["a path nobody owns", (c) => (c.actions[0].path = "/api/nowhere"), ["actions", 0, "path"], "no plugin in the catalog owns /api/nowhere"],
    ["two views on one path", (c) => (c.views[2].path = c.views[1].path), ["views", 2, "path"], "another view already serves /microgrids/[id]/billing/[periodId]"],
    [
      "two views on one path with renamed placeholders",
      (c) => {
        c.views[2].path = "/microgrids/[mg]/billing/[period]";
        c.views[2].params = { mg: "microgrid", period: "billingPeriod" };
        c.views[2].entity = "period";
      },
      ["views", 2, "path"],
      "another view already serves /microgrids/[id]/billing/[periodId]",
    ],
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
    ["an undeclared total", (c) => (c.views[1].declares.keys = ["tenant", "payment"]), ["views", 1, "examples", 0, "body", "totals", "total"], '"total" is not declared by the view'],
    ["an undeclared record field", (c) => asKind(c, "record", { sections: [{ fields: [{ key: "secret", label: "S", value: TEXT }] }] }), ["views", 0, "examples", 0, "body", "sections", 0, "fields", 0, "key"], '"secret" is not declared by the view'],
    ["an undeclared tile", (c) => asKind(c, "metrics", { tiles: [{ key: "secret", label: "S", value: TEXT }] }), ["views", 0, "examples", 0, "body", "tiles", 0], '"secret" is not declared by the view'],
    ["an undeclared series", (c) => asKind(c, "metrics", { tiles: [], series: [{ key: "secret", label: "S", unit: "kW", points: [] }] }), ["views", 0, "examples", 0, "body", "series", 0], '"secret" is not declared by the view'],
    ["example ext on a view without one", (c) => delete c.views[1].ext, ["views", 1, "examples", 0, "ext"], "the view declares no ext"],
    ["example ext of another version", (c) => (c.views[1].examples[0].ext.schema = "billing.period-review@2"), ["views", 1, "examples", 0, "ext", "schema"], "expected billing.period-review@1"],
    ["example ext data the ext schema refuses", (c) => (c.views[1].examples[0].ext.data.tariffVersion = "one"), ["views", 1, "examples", 0, "ext", "data", "tariffVersion"]],
    ["an ext schema with an async check", (c) => (c.views[1].ext.zod = c.views[1].ext.zod.refine(async () => true)), ["views", 1, "examples", 0, "ext", "data"], "the ext schema cannot be checked synchronously"],
  ];

  it.each(cases)("refuses %s", (_rule, change, path, message) => {
    const isSms = path[0] === "entities";
    const error = refusal(change, CATALOG, isSms ? SMS_SURFACE : BILLING_SURFACE);
    expect(error.issues).toContainEqual(expect.objectContaining(message === undefined ? { path } : { path, message }));
  });
});

describe("tenant views and the tenant audience", () => {
  it("accepts the tenant app's contribution, and an explicit staff audience", () => {
    expect(parseContribution(TENANT_APP_SURFACE, CATALOG).alias).toBe("tenant");
    const c = copy(BILLING_SURFACE) as Draft;
    c.nav[0].audience = "staff";
    expect(() => parseContribution(c, CATALOG)).not.toThrow();
  });

  const legacyMy = { id: "tenant.legacy", title: "Mine", icon: "tenants", group: "operate", order: 1, href: "/my", needs: [], legacy: true };
  // [rule, change, path, message (exact; omitted where zod writes it)]
  const cases: [string, (c: Draft) => void, PropertyKey[], string?][] = [
    [
      "a tenant view with a path segment",
      (c) => Object.assign(c.views[0], { path: "/my/[id]", params: { id: "tenant" } }),
      ["views", 0, "params"],
      "a tenant view's path has no segments: its unit is the caller's",
    ],
    [
      "an attached tenant view",
      (c) => (c.views[0].attach = { to: "tenant", order: 1, hint: "tab" }),
      ["views", 0, "attach"],
      "a tenant view is never attached to another view",
    ],
    ["a tenant view an assistant may read", (c) => (c.views[0].agent = "read"), ["views", 0, "agent"], "a tenant view cannot be read by an assistant"],
    [
      "a staff entry, by default, for a tenant view",
      (c) => delete c.nav[0].audience,
      ["nav", 0, "audience"],
      "a nav entry that leads to a tenant view is for the tenant audience",
    ],
    [
      "a super-admin entry for a tenant view",
      (c) => (c.nav[0].audience = "super-admin"),
      ["nav", 0, "audience"],
      "a nav entry that leads to a tenant view is for the tenant audience",
    ],
    [
      "a staff legacy entry on a tenant view's path",
      (c) => c.nav.push(legacyMy),
      // Appended after the tenant app's own entries.
      ["nav", TENANT_APP_SURFACE.nav!.length, "audience"],
      "a nav entry that leads to a tenant view is for the tenant audience",
    ],
    ["a tenant entry for a view that is not a tenant view", (c) => delete c.views[0].scope, ["nav", 0, "audience"], "a tenant nav entry names a tenant view"],
    ["a tenant entry on a legacy href", (c) => (c.nav[0] = { ...legacyMy, audience: "tenant" }), ["nav", 0, "audience"], "a tenant nav entry names a tenant view"],
    ["an audience outside the enum", (c) => (c.nav[0].audience = "tenants"), ["nav", 0, "audience"]],
  ];

  it.each(cases)("refuses %s", (_rule, change, path, message) => {
    const error = refusal(change, CATALOG, TENANT_APP_SURFACE);
    expect(error.issues).toContainEqual(expect.objectContaining(message === undefined ? { path } : { path, message }));
  });
});

describe("assistant reading", () => {
  /** METERING_SURFACE with the mark on its one view, metering.site-day. */
  const marked = (c: Draft) => (c.views[0].agent = "read");
  /** METERING_SURFACE with the mark on its one watcher, metering.connection. */
  const watched = (c: Draft) => (c.signals[0].agent = "read");
  const issue = (path: PropertyKey[], message: string) => expect.objectContaining({ path, message });
  const unlisted = (noun: string, id: string) =>
    `"${id}" is not on the list of ${noun} an assistant may read (src/lib/gui/assistant-reads.ts)`;
  /** Any refusal by the list. */
  const onList = expect.objectContaining({ message: expect.stringContaining("is not on the list") });
  const SITE_DAY: readonly AssistantRead[] = [{ kind: "view", id: "metering.site-day" }];
  const CONNECTION: readonly AssistantRead[] = [{ kind: "watcher", id: "metering.connection" }];

  it("lists nothing yet", () => {
    // ADR-007 decision 8: the list starts empty, and A1's pull requests add
    // its first entries, one each, with the mark. Each of them changes this.
    expect(ASSISTANT_READS).toEqual([]);
  });

  describe("views", () => {
    it("accepts the mark on a listed view about an organization's records that takes no signals", () => {
      const c = copy(METERING_SURFACE) as Draft;
      marked(c);
      expect(c.views[0].params).toEqual({ id: "microgrid" });
      expect(parseContribution(c, CATALOG, SITE_DAY).contribution.views?.[0].agent).toBe("read");
    });

    it("refuses the mark on a view that is not on the list", () => {
      const error = refusal(marked, CATALOG, METERING_SURFACE);
      expect(error.issues).toEqual([issue(["views", 0, "agent"], unlisted("views", "metering.site-day"))]);
    });

    it("refuses the mark on a view listed as a watcher", () => {
      const error = refusal(marked, CATALOG, METERING_SURFACE, [{ kind: "watcher", id: "metering.site-day" }]);
      expect(error.issues).toEqual([issue(["views", 0, "agent"], unlisted("views", "metering.site-day"))]);
    });

    it("refuses the mark on each of billing's views, even listed", () => {
      const listed = BILLING_SURFACE.views!.map((v) => ({ kind: "view" as const, id: v.id }));
      const error = refusal((c) => c.views.forEach((v: Draft) => (v.agent = "read")), CATALOG, BILLING_SURFACE, listed);
      for (const i of BILLING_SURFACE.views!.keys())
        expect(error.issues).toContainEqual(issue(["views", i, "agent"], "a billing view cannot be read by an assistant"));
      expect(error.issues).not.toContainEqual(onList);
    });

    it("refuses the mark on payments' views, even listed", () => {
      const error = refusal(marked, CATALOG, PAYMENTS_SURFACE, [{ kind: "view", id: PAYMENTS_SURFACE.views![0].id }]);
      expect(error.issues).toContainEqual(issue(["views", 0, "agent"], "a payments view cannot be read by an assistant"));
      expect(error.issues).not.toContainEqual(onList);
    });

    // Decided by the contributing plugin, whatever the view's id: the same view
    // contributed by each of these is refused, alongside the alias and
    // ownership issues it also raises there.
    it.each(["billing", "payments", "pesapal", "tenant-app", "sms-reminders"])(
      "refuses the mark on a listed view contributed by %s",
      (plugin) => {
        const error = refusal((c) => Object.assign(c, { plugin }) && marked(c), CATALOG, METERING_SURFACE, SITE_DAY);
        expect(error.issues).toContainEqual(issue(["views", 0, "agent"], `a ${plugin} view cannot be read by an assistant`));
      },
    );

    it.each(["tenant", "device", "rateSchedule", "billingPeriod", "lineItem", "paymentAttempt"])(
      "refuses the mark on a listed view whose path names a %s",
      (kind) => {
        const error = refusal(
          (c) => Object.assign(c.views[0], { params: { id: kind } }) && marked(c),
          CATALOG,
          METERING_SURFACE,
          SITE_DAY,
        );
        expect(error.issues).toEqual([issue(["views", 0, "agent"], `a view whose path names a ${kind} cannot be read by an assistant`)]);
      },
    );

    // A listed view of a plugin whose views may be listed, so the navigation
    // it is reached from is the only thing that refuses the mark. nav[2] is
    // metering's configure legacy entry, pointed here at site-day's own path.
    it.each([
      ["configure navigation", (c: Draft) => Object.assign(c.nav[0], { group: "configure" }), "configure"],
      ["system navigation", (c: Draft) => Object.assign(c.nav[0], { group: "system" }), "system"],
      ["a configure legacy href", (c: Draft) => Object.assign(c.nav[2], { href: "/microgrids/[id]/operations" }), "configure"],
      [
        "a configure legacy href with renamed placeholders",
        (c: Draft) => Object.assign(c.nav[2], { href: "/microgrids/[microgridId]/operations" }),
        "configure",
      ],
    ] as const)("refuses the mark on a listed view reached from %s", (_where, reach, group) => {
      const error = refusal(
        (c) => {
          reach(c);
          marked(c);
        },
        CATALOG,
        METERING_SURFACE,
        SITE_DAY,
      );
      expect(error.issues).toEqual([issue(["views", 0, "agent"], `a view reached from ${group} navigation cannot be read by an assistant`)]);
    });

    it("refuses the mark on a listed view that takes signals", () => {
      const error = refusal(
        (c) => {
          delete c.views[0].attach;
          Object.assign(c.views[0], { takesSignals: true });
          marked(c);
        },
        CATALOG,
        METERING_SURFACE,
        SITE_DAY,
      );
      expect(error.issues).toEqual([issue(["views", 0, "agent"], "a view that takes signals cannot be read by an assistant")]);
    });

    it("refuses the mark on a listed view that declares a key prefix", () => {
      const error = refusal(
        (c) => {
          c.views[0].declares.prefixes = ["reading."];
          marked(c);
        },
        CATALOG,
        METERING_SURFACE,
        SITE_DAY,
      );
      expect(error.issues).toEqual([
        issue(["views", 0, "agent"], "a view an assistant may read declares its keys by name, not by prefix"),
      ]);
    });

    it("accepts the mark on a listed view whose prefix list is empty", () => {
      const c = copy(METERING_SURFACE) as Draft;
      c.views[0].declares.prefixes = [];
      marked(c);
      expect(parseContribution(c, CATALOG, SITE_DAY).contribution.views?.[0].agent).toBe("read");
    });

    // ADR-007 decision 10 may let tenant views be listed (#259 § 5); the pull
    // request that does changes this.
    it.each([
      ["unlisted", undefined],
      ["listed", [{ kind: "view", id: TENANT_APP_SURFACE.views![0].id }] as const],
    ])("gives a marked tenant view, %s, one refusal", (_listed, reads) => {
      // tenant.home declares a key prefix, so this also pins that the prefix
      // refusal leaves a tenant view to its own.
      expect(TENANT_APP_SURFACE.views![0].declares.prefixes?.length).toBeGreaterThan(0);
      const error = refusal(marked, CATALOG, TENANT_APP_SURFACE, reads);
      expect(error.issues).toEqual([issue(["views", 0, "agent"], "a tenant view cannot be read by an assistant")]);
    });
  });

  describe("watchers", () => {
    it("accepts the mark on a listed watcher", () => {
      const c = copy(METERING_SURFACE) as Draft;
      watched(c);
      expect(parseContribution(c, CATALOG, CONNECTION).contribution.signals?.[0].agent).toBe("read");
    });

    it("refuses the mark on a watcher that is not on the list", () => {
      const error = refusal(watched, CATALOG, METERING_SURFACE);
      expect(error.issues).toEqual([issue(["signals", 0, "agent"], unlisted("watchers", "metering.connection"))]);
    });

    it("refuses the mark on a watcher listed as a view", () => {
      const error = refusal(watched, CATALOG, METERING_SURFACE, [{ kind: "view", id: "metering.connection" }]);
      expect(error.issues).toEqual([issue(["signals", 0, "agent"], unlisted("watchers", "metering.connection"))]);
    });

    it.each([
      ["billing", BILLING_SURFACE],
      ["payments", PAYMENTS_SURFACE],
    ] as const)("refuses the mark on every %s watcher, even listed", (plugin, base) => {
      const listed = base.signals!.map((s) => ({ kind: "watcher" as const, id: s.id }));
      const error = refusal((c) => c.signals.forEach((s: Draft) => (s.agent = "read")), CATALOG, base, listed);
      expect(error.issues).toEqual(
        base.signals!.map((_, i) => issue(["signals", i, "agent"], `a ${plugin} watcher cannot be read by an assistant`)),
      );
    });

    it("refuses a mark other than read", () => {
      const error = refusal((c) => (c.signals[0].agent = "write"), CATALOG, METERING_SURFACE, CONNECTION);
      expect(error.issues).toContainEqual(expect.objectContaining({ path: ["signals", 0, "agent"] }));
    });
  });

  it("has a decision for every plugin in the catalog, and none for a plugin outside it", () => {
    // A new plugin needs a decision before its views can be marked or refused
    // on purpose; one missing here is refused at registration.
    expect(Object.keys(ASSISTANT_READING).sort()).toEqual(MGM_BUNDLED_PLUGINS.map((p) => p.name).sort());
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
    ["a record with string keys", z.record(z.string(), z.string())],
    ["a record keyed by a union with a string", z.record(z.union([z.literal("a"), z.string()]), z.number())],
    ["an open record inside a strict object", z.strictObject({ meta: z.record(z.string(), z.string()) })],
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
      byLiteral: z.record(z.literal("only"), z.string()),
      byLiterals: z.record(z.union([z.literal("a"), z.literal("b")]), z.boolean()),
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
