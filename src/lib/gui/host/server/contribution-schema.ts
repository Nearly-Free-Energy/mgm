import "server-only";

/**
 * Checks a capability's GUI contribution against the contract when it is
 * registered. A broken rule throws SurfaceContributionError, whose message
 * names the plugin and the path of each failing field.
 *
 * The parse reads only the contribution and the catalog it is given, never
 * the environment, the network or the database, so a test that builds the
 * same contribution refuses exactly what start-up would.
 *
 * Checked here: strict shapes at every depth; the plugin is in the catalog;
 * ids carry its alias and are unique within the contribution; confirmation
 * levels; path segments against params and bindings; referenced entity kinds;
 * route ownership; strict `ext` schemas; action inputs that JSON Schema can
 * describe; examples against the model schemas and the declared keys, and a
 * watcher's examples against the signal schema; no
 * assistant reading of views reached from configure or system navigation,
 * of billing's, payments' or Pesapal's views, of views whose path names a
 * tenant or a device, or of views that take signals;
 * tenant views without segments, attachments or assistant reading, reached
 * only from tenant navigation; `attach.whilePluginOff` only on a tab or tile
 * of cost "db"; `takesSignals` only on an organization's view that is not
 * attached and does not poll.
 *
 * Not checked here, because one contribution cannot show them: one
 * contribution per plugin, ids unique across plugins, an attach target in
 * another plugin, released routes and per-organization plugin state. Nor
 * which actions and views may declare `whilePluginOff`, which needs the
 * route exemptions and the capability's gating (gui-surface.test.ts).
 */
import { z } from "zod";
import { CORE_ENTITY_KINDS, getRouteOwner, type CoreEntityKind, type MgmPluginName } from "@/lib/plugins/bundled";
import type { MgmCatalog } from "@/lib/runtime/services";
import type { Contribution } from "../../surface";
import type { BodiesOf, ViewKind, ViewModel } from "../../contract";
import {
  confirmSchema,
  entityKindSchema,
  extSchemaName,
  iconSchema,
  idSchema,
  modelSchema,
  navGroupSchema,
  signalOutSchema,
} from "./model-schema";

/** What the parse reads from the catalog: the plugins, their aliases and routes. */
export type SurfaceCatalog = Pick<MgmCatalog, "plugins">;

export interface ParsedContribution {
  plugin: MgmPluginName;
  alias: string;
  contribution: Contribution;
}

type Issue = z.core.$ZodIssue;
type Ctx = z.RefinementCtx;
type Path = PropertyKey[];

export class SurfaceContributionError extends Error {
  readonly plugin: string;
  readonly issues: readonly Issue[];
  constructor(plugin: string, error: z.ZodError) {
    super(`GUI contribution from "${plugin}" refused:\n${z.prettifyError(error)}`);
    this.name = "SurfaceContributionError";
    this.plugin = plugin;
    this.issues = error.issues;
  }
}

function add(ctx: Ctx, path: Path, message: string) {
  ctx.addIssue({ code: "custom", path, message });
}

// ── Shapes ──────────────────────────────────────────────────────────────────

const fn = z.custom<(...args: never[]) => unknown>((v) => typeof v === "function", "Expected a function");
const zodType = z.custom<z.ZodType>((v) => v instanceof z.ZodType, "Expected a zod schema");
/** "/", or segments of lowercase words and [name] placeholders. */
const routePattern = z
  .string()
  .regex(/^\/$|^(?:\/(?:[a-z0-9_][a-z0-9_-]*|\[[A-Za-z][A-Za-z0-9_]*\]))+$/, "Expected a route such as /microgrids/[id]");
const kindMap = z.record(z.string(), entityKindSchema);

/** A route with its placeholder names dropped: /x/[id] and /x/[microgridId] are one route. */
function routeKey(route: string): string {
  return route.replace(/\[[^\]]+\]/g, "[]");
}

function segmentsOf(route: string): string[] {
  return [...route.matchAll(/\[([A-Za-z][A-Za-z0-9_]*)\]/g)].map((m) => m[1]);
}

/** A segment list must name each placeholder once, and match `keys` exactly. */
function checkSegments(ctx: Ctx, route: string, keys: string[], at: Path, what: string) {
  const segments = segmentsOf(route);
  if (new Set(segments).size !== segments.length) add(ctx, ["path"], "each path segment needs its own name");
  for (const s of segments) if (!keys.includes(s)) add(ctx, at, `${what} has no kind for the segment "${s}"`);
  for (const k of keys) if (!segments.includes(k)) add(ctx, [...at, k], `"${k}" is not a segment of the path`);
}

const navSchema = z
  .strictObject({
    id: idSchema,
    title: z.string().min(1),
    icon: iconSchema,
    group: navGroupSchema,
    order: z.number(),
    audience: z.enum(["staff", "super-admin", "tenant"]).optional(),
    view: idSchema.optional(),
    href: routePattern.optional(),
    needs: z.array(z.enum(CORE_ENTITY_KINDS)).optional(),
    legacy: z.literal(true).optional(),
  })
  .superRefine((n, ctx) => {
    if (n.view !== undefined) {
      if (n.href !== undefined || n.needs !== undefined || n.legacy !== undefined)
        add(ctx, ["view"], "a nav entry names a view or a legacy href, not both");
    } else if (n.href === undefined || n.needs === undefined || n.legacy !== true) {
      add(ctx, [], "a nav entry needs a view, or an href with needs and legacy: true");
    } else if (n.needs.length !== segmentsOf(n.href).length) {
      add(ctx, ["needs"], "needs must name one kind for each segment of the href");
    }
  });

// ── Strict ext schemas ──────────────────────────────────────────────────────

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  options?: z.ZodType[];
  innerType?: z.ZodType;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
};
const LEAVES = new Set(["string", "number", "boolean", "literal", "enum", "null", "date"]);
const WRAPPERS = new Set(["optional", "nullable", "default", "readonly"]);

/** Whether a record key schema allows only keys it names. */
function closedKeys(schema: z.ZodType): boolean {
  const def = schema._zod.def as unknown as Def;
  if (def.type === "enum" || def.type === "literal") return true;
  if (def.type === "union") return def.options!.every(closedKeys);
  return false;
}

/** Where a schema could accept keys or values nobody declared: loose objects, any, unknown, custom, lazy, transforms. */
export function strictProblems(schema: z.ZodType): { path: Path; message: string }[] {
  const problems: { path: Path; message: string }[] = [];
  const seen = new Set<z.ZodType>();
  const walk = (s: z.ZodType, path: Path) => {
    if (seen.has(s)) return;
    seen.add(s);
    const def = s._zod.def as unknown as Def;
    if (LEAVES.has(def.type)) return;
    if (WRAPPERS.has(def.type)) return walk(def.innerType!, path);
    switch (def.type) {
      case "object":
        if (def.catchall?._zod.def.type !== "never") problems.push({ path, message: "ext objects must be strict (z.strictObject)" });
        for (const [key, child] of Object.entries(def.shape!)) walk(child, [...path, key]);
        return;
      case "array":
        return walk(def.element!, path);
      case "tuple":
        def.items!.forEach((child, i) => walk(child, [...path, i]));
        if (def.rest) walk(def.rest, path);
        return;
      case "union":
        return def.options!.forEach((child) => walk(child, path));
      case "record":
        // A string key lets a loader send any key it likes, so a record must
        // name its keys: an enum, a literal, or a union of those.
        if (!closedKeys(def.keyType!))
          problems.push({ path, message: "ext records must have enum or literal keys (z.record(z.enum([...]), ...))" });
        return walk(def.valueType!, path);
      default:
        problems.push({ path, message: `ext schemas may not use ${def.type}` });
    }
  };
  walk(schema, []);
  return problems;
}

// ── Assistant reading ───────────────────────────────────────────────────────

/*
 * `agent: "read"` is the only thing that lets an assistant read a view
 * (ViewDef in ../../surface.ts), and #133's data boundary keeps from any
 * assistant tenants' names and units, bills and payment references, the
 * identifiers of single devices, and every watcher's signals together. So
 * the mark is refused, besides on tenant views and on views reached from
 * configure or system navigation, on:
 *
 * - every view of a plugin below marked "refused": billing (billing-review
 *   is a service of the billing plugin, so whatever it shows is contributed
 *   as billing), payments and Pesapal carry bills, tenants and payment
 *   references; the tenant app is about a tenant's own unit;
 * - a view whose path names a tenant or a device (ASSISTANT_REFUSED_KINDS);
 * - a view that takes signals, which carries every watcher's answer.
 *
 * The list is keyed by every plugin name, so a new or renamed plugin does
 * not type-check until someone decides whether its views may be marked, and
 * contribution-schema.test.ts fails while it and the catalog differ. A name
 * missing from it at run time is refused. "per view" leaves the decision to
 * each view and the rules on kinds and signals: those plugins' views carry
 * neither bills nor payments. If a plugin's views come to carry them, or the
 * host's read interface gains its own refusal per model (which would make
 * these refusals a second copy of it), revisit this list and those rules.
 */
export const ASSISTANT_READING: Readonly<Record<MgmPluginName, "per view" | "refused">> = {
  "organization-directory": "per view",
  "community-management": "per view",
  metering: "per view",
  billing: "refused",
  payments: "refused",
  pesapal: "refused",
  "tenant-app": "refused",
};

/** The entity kinds whose records an assistant may never read through a view's path. */
const ASSISTANT_REFUSED_KINDS: ReadonlySet<string> = new Set<CoreEntityKind>(["tenant", "device"]);

// ── Views ───────────────────────────────────────────────────────────────────

/** A model's kind and body, whatever its action shape: a GUI's model or a loader's. */
export type KindAndBody = { [K in ViewKind]: { kind: K; body: BodiesOf<unknown, unknown>[K] } }[ViewKind];

/** Every key a model names that its view must declare: columns, cells, totals, fields, tiles and series. */
export function keysOf(model: KindAndBody): [string, Path][] {
  const out: [string, Path][] = [];
  const each = (keys: string[], at: Path) => keys.forEach((k, i) => out.push([k, [...at, i]]));
  switch (model.kind) {
    case "collection": {
      const b = model.body;
      b.columns.forEach((c, i) => out.push([c.key, ["body", "columns", i, "key"]]));
      b.rows.forEach((r, i) => Object.keys(r.cells).forEach((k) => out.push([k, ["body", "rows", i, "cells", k]])));
      Object.keys(b.totals ?? {}).forEach((k) => out.push([k, ["body", "totals", k]]));
      break;
    }
    case "record":
      model.body.sections.forEach((s, i) =>
        s.fields.forEach((f, j) => out.push([f.key, ["body", "sections", i, "fields", j, "key"]])),
      );
      break;
    case "metrics":
      each(model.body.tiles.map((t) => t.key), ["body", "tiles"]);
      each((model.body.series ?? []).map((s) => s.key), ["body", "series"]);
      break;
  }
  return out;
}

const VIEW_KINDS = ["collection", "record", "metrics", "feed", "flow"] as const satisfies readonly ViewKind[];

const viewSchema = z
  .strictObject({
    id: idSchema,
    kind: z.enum(VIEW_KINDS),
    path: routePattern,
    params: kindMap,
    entity: z.string().optional(),
    query: z.array(z.string().regex(/^[a-z][A-Za-z0-9_-]*$/, "Expected a search parameter name")).readonly().optional(),
    attach: z
      .strictObject({
        to: z.union([entityKindSchema, z.strictObject({ view: idSchema })]),
        order: z.number(),
        hint: z.enum(["section", "tab", "tile"]),
        whilePluginOff: z.literal("listed").optional(),
      })
      .optional(),
    cost: z.enum(["db", "vendor"]),
    agent: z.literal("read").optional(),
    takesSignals: z.literal(true).optional(),
    live: z
      .strictObject({ refreshSeconds: z.number().min(5), staleAfterSeconds: z.number() })
      .refine((l) => l.staleAfterSeconds >= l.refreshSeconds, {
        message: "staleAfterSeconds must be at least refreshSeconds",
        path: ["staleAfterSeconds"],
      })
      .optional(),
    declares: z.strictObject({
      keys: z.array(z.string().min(1)).readonly(),
      prefixes: z.array(z.string().min(1)).readonly().optional(),
    }),
    ext: z.strictObject({ schema: extSchemaName, zod: zodType }).optional(),
    examples: z.array(z.unknown()).min(1, "a view needs at least one example").readonly(),
    scope: z.enum(["organization", "installation", "tenant"]).optional(),
    load: fn,
  })
  .superRefine((v, ctx) => {
    checkSegments(ctx, v.path, Object.keys(v.params), ["params"], "params");
    if (v.entity !== undefined && !(v.entity in v.params)) add(ctx, ["entity"], "entity must name one of the params");
    // A tenant view is about the caller's own unit, which the host picks from
    // their tenant rows (RFC mgm#197 § 4): a path segment would go through
    // the staff resolver, and an attachment would list it on staff views.
    // It carries a tenant's name and unit, which #133's data boundary keeps
    // from any assistant.
    if (v.scope === "tenant") {
      if (Object.keys(v.params).length > 0) add(ctx, ["params"], "a tenant view's path has no segments: its unit is the caller's");
      if (v.attach !== undefined) add(ctx, ["attach"], "a tenant view is never attached to another view");
      if (v.agent !== undefined) add(ctx, ["agent"], "a tenant view cannot be read by an assistant");
    }
    // The host collects signals for one organization (organizationSignals in
    // ./signals.ts), so only a view about an organization can take them; and
    // since every watcher runs on each load, never one that polls or is
    // attached to another view, which would run them all again with it.
    if (v.takesSignals) {
      if (v.scope === "installation" || v.scope === "tenant")
        add(ctx, ["takesSignals"], "only an organization's view takes its signals");
      if (v.attach !== undefined) add(ctx, ["takesSignals"], "a view that takes signals is never attached to another view");
      if (v.live !== undefined) add(ctx, ["takesSignals"], "a view that takes signals does not poll");
    }
    // The plugin rule needs the catalog, so it is in checkContribution.
    if (v.agent === "read") {
      for (const k of new Set(Object.values(v.params)))
        if (ASSISTANT_REFUSED_KINDS.has(k)) add(ctx, ["agent"], `a view whose path names a ${k} cannot be read by an assistant`);
      if (v.takesSignals) add(ctx, ["agent"], "a view that takes signals cannot be read by an assistant");
    }
    // Which views may declare it is checked in CI (gui-surface.test.ts),
    // which can read the route exemptions and the capability's gating; here
    // only what the host itself would contradict.
    if (v.attach?.whilePluginOff !== undefined) {
      if (v.attach.hint === "section")
        add(ctx, ["attach", "whilePluginOff"], "a section is listed while its plugin is off already");
      if (v.cost === "vendor")
        add(ctx, ["attach", "whilePluginOff"], "a vendor view is refused while its plugin is off, so it cannot be listed then");
    }
    for (const p of v.ext ? strictProblems(v.ext.zod) : []) add(ctx, ["ext", "zod", ...p.path], p.message);
    const declared = (key: string) =>
      v.declares.keys.includes(key) || (v.declares.prefixes ?? []).some((prefix) => key.startsWith(prefix));
    v.examples.forEach((example, i) => {
      const at: Path = ["examples", i];
      const parsed = modelSchema(v.kind).safeParse(example);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) add(ctx, [...at, ...issue.path], issue.message);
        return;
      }
      const model = parsed.data as ViewModel;
      if (model.view !== v.id) add(ctx, [...at, "view"], `an example must name its view, ${v.id}`);
      if (model.ext) {
        if (!v.ext) add(ctx, [...at, "ext"], "the view declares no ext");
        else if (model.ext.schema !== v.ext.schema) add(ctx, [...at, "ext", "schema"], `expected ${v.ext.schema}`);
        else {
          try {
            const data = v.ext.zod.safeParse(model.ext.data);
            for (const issue of data.error?.issues ?? []) add(ctx, [...at, "ext", "data", ...issue.path], issue.message);
          } catch {
            add(ctx, [...at, "ext", "data"], "the ext schema cannot be checked synchronously");
          }
        }
      }
      for (const [key, path] of keysOf(model))
        if (!declared(key)) add(ctx, [...at, ...path], `"${key}" is not declared by the view`);
    });
  });

// ── Actions ─────────────────────────────────────────────────────────────────

const actionSchema = z
  .strictObject({
    id: idSchema,
    title: z.string().min(1),
    target: entityKindSchema,
    input: zodType,
    inputVersion: z.int().min(1),
    path: routePattern,
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    bind: z.strictObject({ path: kindMap.optional(), body: kindMap.optional() }),
    available: fn.optional(),
    targeted: z.literal(false).optional(),
    // Which actions may declare it (a PaymentExemption route) is checked in
    // CI by gui-surface.test.ts, which can read UNGATED_WRITES; contribute()
    // reads no test data.
    whilePluginOff: z.literal("enabled").optional(),
    // That each code is one the route answers is checked in CI by
    // gui-surface.test.ts, which reads the source; contribute() reads none.
    prepareAgainOn: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "Expected a lower-case code"))
      .min(1)
      .max(8)
      .readonly()
      .optional(),
    risk: z.enum(["write", "money", "external", "destructive"]),
    confirm: confirmSchema,
    humanOnly: z.boolean(),
    prepare: fn.optional(),
  })
  .superRefine((a, ctx) => {
    const prepared = a.confirm === "typed" || a.confirm === "ceremony";
    const guarded = a.method === "DELETE" ? "a DELETE action" : a.risk === "destructive" ? "a destructive action" : null;
    if (guarded && !prepared) add(ctx, ["confirm"], `${guarded} needs typed or ceremony confirmation`);
    const human = prepared ? `a ${a.confirm} action` : guarded;
    if (human && !a.humanOnly) add(ctx, ["humanOnly"], `${human} must be humanOnly`);
    const needsPrepare = prepared ? `a ${a.confirm} action` : a.risk === "external" ? "an external action" : null;
    if (needsPrepare && !a.prepare) add(ctx, ["prepare"], `${needsPrepare} needs prepare`);
    if (a.risk === "external" && a.confirm === "none") add(ctx, ["confirm"], "an external action needs at least confirm");
    if (a.prepareAgainOn) {
      if (!a.prepare) add(ctx, ["prepareAgainOn"], "an action that prepares again needs prepare");
      if (a.confirm === "none") add(ctx, ["prepareAgainOn"], "an action that prepares again needs a confirmation step");
      if (new Set(a.prepareAgainOn).size !== a.prepareAgainOn.length) add(ctx, ["prepareAgainOn"], "a code is listed twice");
    }
    checkSegments(ctx, a.path, Object.keys(a.bind.path ?? {}), ["bind", "path"], "bind.path");
    try {
      z.toJSONSchema(a.input, { io: "input" });
    } catch (error) {
      add(ctx, ["input"], `the input cannot be described as JSON Schema: ${(error as Error).message}`);
    }
  });

// ── Signals ─────────────────────────────────────────────────────────────────

/**
 * A watcher. Its examples are what its load() would return: each strictly a
 * SignalOut, with ids unique among them, as the host requires of a watcher's
 * answer (watch in ./signals.ts). Whether each href is a released page of
 * the plugin is checked in CI (gui-surface.test.ts), which reads the
 * released routes.
 */
const signalDefSchema = z
  .strictObject({
    id: idSchema,
    budgetMs: z.int().min(1).max(10_000).optional(),
    load: fn,
    examples: z.array(z.unknown()).min(1, "a watcher needs at least one example").readonly(),
    // Which watchers may declare it is checked in CI (gui-surface.test.ts),
    // which can read the capability's gating.
    whilePluginOff: z.literal("checked").optional(),
  })
  .superRefine((w, ctx) => {
    const seen = new Set<string>();
    w.examples.forEach((example, i) => {
      const parsed = signalOutSchema.safeParse(example);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) add(ctx, ["examples", i, ...issue.path], issue.message);
        return;
      }
      if (seen.has(parsed.data.id)) add(ctx, ["examples", i, "id"], `"${parsed.data.id}" is used twice`);
      seen.add(parsed.data.id);
    });
  });

// ── The contribution ────────────────────────────────────────────────────────

/** The shape alone; parseContribution adds the rules that need the catalog. */
export const contributionSchema = z.strictObject({
  plugin: z.string().min(1),
  nav: z.array(navSchema).optional(),
  views: z.array(viewSchema).optional(),
  actions: z.array(actionSchema).optional(),
  signals: z.array(signalDefSchema).optional(),
  status: z.array(z.strictObject({ id: idSchema, load: fn })).optional(),
  search: z.array(z.strictObject({ prefix: z.enum(["@", "#"]), entity: entityKindSchema, find: fn })).optional(),
  entities: z.array(z.strictObject({ kind: idSchema, organizationOf: fn })).optional(),
});
type Shape = z.output<typeof contributionSchema>;

const CORE_KINDS: ReadonlySet<string> = new Set(CORE_ENTITY_KINDS);

function checkContribution(c: Shape, catalog: SurfaceCatalog, ctx: Ctx) {
  const entry = catalog.plugins.find((p) => p.name === c.plugin);
  if (!entry) return add(ctx, ["plugin"], `"${c.plugin}" is not a plugin in the catalog`);
  const ownKinds = new Set<string>((c.entities ?? []).map((e) => e.kind));

  const ids = (list: string[] = [], at: string, field = "id") => {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (!id.startsWith(`${entry.alias}.`)) add(ctx, [at, i, field], `"${id}" must start with the alias "${entry.alias}."`);
      if (seen.has(id)) add(ctx, [at, i, field], `"${id}" is used twice`);
      seen.add(id);
    });
  };
  const kind = (k: string, path: Path) => {
    if (!CORE_KINDS.has(k) && !ownKinds.has(k))
      add(ctx, path, `"${k}" is neither a core entity kind nor one ${c.plugin} declares in entities`);
  };
  const owned = (route: string, path: Path) => {
    const owner = getRouteOwner(route, catalog.plugins);
    if (owner?.name !== c.plugin)
      add(ctx, path, owner ? `the catalog gives ${route} to ${owner.name}` : `no plugin in the catalog owns ${route}`);
  };

  ids(c.nav?.map((n) => n.id), "nav");
  ids(c.views?.map((v) => v.id), "views");
  ids(c.actions?.map((a) => a.id), "actions");
  ids(c.signals?.map((s) => s.id), "signals");
  ids(c.status?.map((s) => s.id), "status");
  ids(c.entities?.map((e) => e.kind), "entities", "kind");

  const views = c.views ?? [];
  const paths = new Map<string, string>();
  views.forEach((v, i) => {
    owned(v.path, ["views", i, "path"]);
    const same = paths.get(routeKey(v.path));
    if (same !== undefined) add(ctx, ["views", i, "path"], `another view already serves ${same}`);
    else paths.set(routeKey(v.path), v.path);
    for (const [key, k] of Object.entries(v.params)) kind(k, ["views", i, "params", key]);
    if (typeof v.attach?.to === "string") kind(v.attach.to, ["views", i, "attach", "to"]);
    if (v.agent === "read" && ASSISTANT_READING[c.plugin as MgmPluginName] !== "per view")
      add(ctx, ["views", i, "agent"], `a ${c.plugin} view cannot be read by an assistant`);
    if (v.ext && !v.ext.schema.startsWith(`${entry.alias}.`))
      add(ctx, ["views", i, "ext", "schema"], `"${v.ext.schema}" must start with the alias "${entry.alias}."`);
  });
  (c.nav ?? []).forEach((n, i) => {
    if (n.href !== undefined) owned(n.href, ["nav", i, "href"]);
    // A legacy href reaches the view on its path once the catalog marks that page servedBy: "view";
    // if views stop being served at their own paths, revisit.
    const j = views.findIndex((v) =>
      n.view === undefined ? n.href !== undefined && routeKey(v.path) === routeKey(n.href) : v.id === n.view,
    );
    // Tenant entries and tenant views go together, so no staff entry leads to
    // a unit's page and no tenant entry to a staff page.
    const tenantView = j >= 0 && views[j].scope === "tenant";
    if (n.audience === "tenant" && (n.view === undefined || !tenantView))
      add(ctx, ["nav", i, "audience"], "a tenant nav entry names a tenant view");
    else if (n.audience !== "tenant" && tenantView)
      add(ctx, ["nav", i, "audience"], "a nav entry that leads to a tenant view is for the tenant audience");
    if (j < 0) {
      if (n.view !== undefined) add(ctx, ["nav", i, "view"], `"${n.view}" is not a view in this contribution`);
      return;
    }
    if ((n.group === "configure" || n.group === "system") && views[j].agent === "read")
      add(ctx, ["views", j, "agent"], `a view reached from ${n.group} navigation cannot be read by an assistant`);
  });
  (c.actions ?? []).forEach((a, i) => {
    owned(a.path, ["actions", i, "path"]);
    kind(a.target, ["actions", i, "target"]);
    for (const side of ["path", "body"] as const)
      for (const [key, k] of Object.entries(a.bind[side] ?? {})) kind(k, ["actions", i, "bind", side, key]);
  });
  (c.search ?? []).forEach((s, i) => kind(s.entity, ["search", i, "entity"]));
}

/** Throws SurfaceContributionError unless `c` is a contribution that keeps every rule above. */
export function parseContribution(c: unknown, catalog: SurfaceCatalog): ParsedContribution {
  const result = contributionSchema.superRefine((v, ctx) => checkContribution(v, catalog, ctx)).safeParse(c);
  const named = (c as { plugin?: unknown } | null)?.plugin;
  const plugin = typeof named === "string" ? named : "(no plugin)";
  if (!result.success) throw new SurfaceContributionError(plugin, result.error);
  const alias = catalog.plugins.find((p) => p.name === plugin)!.alias;
  return { plugin: plugin as MgmPluginName, alias, contribution: c as Contribution };
}
