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
 * describe; examples against the model schemas and the declared keys; no
 * assistant reading of views reached from configure or system navigation.
 *
 * Not checked here, because one contribution cannot show them: one
 * contribution per plugin, ids unique across plugins, an attach target in
 * another plugin, released routes and per-organization plugin state.
 */
import { z } from "zod";
import { CORE_ENTITY_KINDS, getRouteOwner, type MgmPluginName } from "@/lib/plugins/bundled";
import type { MgmCatalog } from "@/lib/runtime/services";
import type { Contribution } from "../../surface";
import type { ViewKind, ViewModel } from "../../contract";
import {
  confirmSchema,
  entityKindSchema,
  extSchemaName,
  iconSchema,
  idSchema,
  modelSchema,
  navGroupSchema,
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
    audience: z.literal("super-admin").optional(),
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
        walk(def.keyType!, path);
        return walk(def.valueType!, path);
      default:
        problems.push({ path, message: `ext schemas may not use ${def.type}` });
    }
  };
  walk(schema, []);
  return problems;
}

// ── Views ───────────────────────────────────────────────────────────────────

/** Every key a model names that its view must declare: columns, cells, totals, fields, tiles and series. */
function keysOf(model: ViewModel): [string, Path][] {
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
      })
      .optional(),
    cost: z.enum(["db", "vendor"]),
    agent: z.literal("read").optional(),
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
    scope: z.enum(["organization", "installation"]).optional(),
    load: fn,
  })
  .superRefine((v, ctx) => {
    checkSegments(ctx, v.path, Object.keys(v.params), ["params"], "params");
    if (v.entity !== undefined && !(v.entity in v.params)) add(ctx, ["entity"], "entity must name one of the params");
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
    checkSegments(ctx, a.path, Object.keys(a.bind.path ?? {}), ["bind", "path"], "bind.path");
    try {
      z.toJSONSchema(a.input, { io: "input" });
    } catch (error) {
      add(ctx, ["input"], `the input cannot be described as JSON Schema: ${(error as Error).message}`);
    }
  });

// ── The contribution ────────────────────────────────────────────────────────

/** The shape alone; parseContribution adds the rules that need the catalog. */
export const contributionSchema = z.strictObject({
  plugin: z.string().min(1),
  nav: z.array(navSchema).optional(),
  views: z.array(viewSchema).optional(),
  actions: z.array(actionSchema).optional(),
  signals: z
    .array(z.strictObject({ id: idSchema, budgetMs: z.int().min(1).max(10_000).optional(), load: fn }))
    .optional(),
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
  const paths = new Set<string>();
  views.forEach((v, i) => {
    owned(v.path, ["views", i, "path"]);
    if (paths.has(v.path)) add(ctx, ["views", i, "path"], `another view already serves ${v.path}`);
    paths.add(v.path);
    for (const [key, k] of Object.entries(v.params)) kind(k, ["views", i, "params", key]);
    if (typeof v.attach?.to === "string") kind(v.attach.to, ["views", i, "attach", "to"]);
    if (v.ext && !v.ext.schema.startsWith(`${entry.alias}.`))
      add(ctx, ["views", i, "ext", "schema"], `"${v.ext.schema}" must start with the alias "${entry.alias}."`);
  });
  (c.nav ?? []).forEach((n, i) => {
    if (n.href !== undefined) owned(n.href, ["nav", i, "href"]);
    // A legacy href reaches the view on its path once the catalog marks that page servedBy: "view";
    // if views stop being served at their own paths, revisit.
    const j = views.findIndex((v) => (n.view === undefined ? v.path === n.href : v.id === n.view));
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
