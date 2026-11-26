import "server-only";

/**
 * Checks a capability's GUI contribution against the contract when it is
 * registered. A broken rule throws SurfaceContributionError, whose message
 * names the plugin and the path of each failing field.
 *
 * The parse reads only the contribution, the catalog it is given and the
 * list of views and watchers an assistant may read (../../assistant-reads.ts),
 * never the environment, the network or the database, so a test that builds
 * the same contribution refuses exactly what start-up would.
 *
 * Checked here: strict shapes at every depth; the plugin is in the catalog;
 * ids carry its alias and are unique within the contribution; confirmation
 * levels; path segments against params and bindings; referenced entity kinds;
 * route ownership; strict `ext` schemas; action inputs that JSON Schema can
 * describe, with no part that accepts any value (unconstrainedNodes in
 * ./input-spec.ts: so strict objects, and no z.json()), since the host
 * serves that schema (describeInput) and an empty one describes nothing,
 * each refusal naming the action's id;
 * examples against the model schemas and the declared keys, and a
 * watcher's examples against the signal schema; no
 * assistant reading of a view or watcher that is not on the list, of views
 * reached from configure or system navigation, of billing's, payments',
 * Pesapal's or the tenant app's views and watchers, of views whose path
 * names a tenant, a device or a billing or payment record, of views that
 * take signals, or of views that declare a key prefix; a marked view's
 * declaration against the one its list entry pins;
 * tenant views without segments, attachments or assistant reading, reached
 * only from tenant navigation; `attach.whilePluginOff` only on a tab or tile
 * of cost "db"; `takesSignals` only on an organization's view that is not
 * attached and does not poll; every action's `repeat`.
 *
 * Not checked here, because one contribution cannot show them: one
 * contribution per plugin, ids unique across plugins, an attach target in
 * another plugin, released routes and per-organization plugin state. Nor
 * which actions and views may declare `whilePluginOff`, which needs the
 * route exemptions and the capability's gating (gui-surface.test.ts). Nor
 * which plugins' actions may declare repeat "unsafe" (gui-surface.test.ts),
 * nor whether a "safe" one is (repeat.db.test.ts).
 */
import { z } from "zod";
import { CORE_ENTITY_KINDS, getRouteOwner, type CoreEntityKind, type MgmPluginName } from "@/lib/plugins/bundled";
import type { MgmCatalog } from "@/lib/runtime/services";
import { ASSISTANT_READS, type AssistantRead } from "../../assistant-reads";
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
  repeatSchema,
  routePattern,
  signalOutSchema,
} from "./model-schema";
import { unconstrainedNodes } from "./input-spec";

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

/** The keys a closed record key schema allows (closedKeys), as strings. */
function recordKeys(schema: z.ZodType): string[] {
  const def = schema._zod.def as unknown as Def & { entries?: Record<string, unknown>; values?: unknown[] };
  if (def.type === "enum") return Object.values(def.entries!).map(String);
  if (def.type === "literal") return def.values!.map(String);
  if (def.type === "union") return def.options!.flatMap(recordKeys);
  return [];
}

const STRUCTURES = new Set(["object", "array", "tuple", "union", "record"]);

/**
 * The schemas directly inside one an ext may use, each with the key it adds
 * to the path: an object's property and a tuple's position add one; a
 * wrapper's inner schema, an array's element, a tuple's rest, a union's
 * option and a record's value add none. Any other type has none, and
 * strictProblems refuses it. The walks below (strictProblems, extKeyPaths,
 * withholdMode) all descend through this, so they agree on what a schema
 * holds.
 */
function extChildren(def: Def): { schema: z.ZodType; key?: PropertyKey }[] {
  if (WRAPPERS.has(def.type)) return [{ schema: def.innerType! }];
  switch (def.type) {
    case "object":
      return Object.entries(def.shape!).map(([key, schema]) => ({ schema, key }));
    case "array":
      return [{ schema: def.element! }];
    case "tuple":
      return [...def.items!.map((schema, key) => ({ schema, key })), ...(def.rest ? [{ schema: def.rest }] : [])];
    case "union":
      return def.options!.map((schema) => ({ schema }));
    case "record":
      return [{ schema: def.valueType! }];
    default:
      return [];
  }
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
    if (!WRAPPERS.has(def.type) && !STRUCTURES.has(def.type))
      return void problems.push({ path, message: `ext schemas may not use ${def.type}` });
    if (def.type === "object" && def.catchall?._zod.def.type !== "never")
      problems.push({ path, message: "ext objects must be strict (z.strictObject)" });
    // A string key lets a loader send any key it likes, so a record must
    // name its keys: an enum, a literal, or a union of those.
    if (def.type === "record" && !closedKeys(def.keyType!))
      problems.push({ path, message: "ext records must have enum or literal keys (z.record(z.enum([...]), ...))" });
    for (const child of extChildren(def)) walk(child.schema, child.key === undefined ? path : [...path, child.key]);
  };
  walk(schema, []);
  return problems;
}

/**
 * Every key path an ext schema names, dotted, sorted and once each: each
 * object property at any depth, each key of a record with closed keys
 * (closedKeys), and the paths under them. An array or a tuple adds nothing,
 * as its items sit at its own path, and a union's options add theirs at the
 * same place. A listed view's entry pins these (ViewDeclaration in
 * ../../assistant-reads.ts), so a field added to a listed view's ext at any
 * depth refuses its mark until the entry names it. The path is pinned, not
 * the type at it: a field that changes type keeps its path, and is a new
 * ext version, which the entry's schema id pins.
 */
export function extKeyPaths(schema: z.ZodType): string[] {
  const out = new Set<string>();
  // The schemas on the way here, so a schema that holds itself through a
  // getter ends the walk rather than looping.
  const inside = new Set<z.ZodType>();
  const walk = (s: z.ZodType, path: string[]) => {
    if (inside.has(s)) return;
    inside.add(s);
    const def = s._zod.def as unknown as Def;
    const keyed = (key: string, child: z.ZodType) => {
      out.add([...path, key].join("."));
      walk(child, [...path, key]);
    };
    if (def.type === "record" && closedKeys(def.keyType!)) {
      for (const key of recordKeys(def.keyType!)) keyed(key, def.valueType!);
    } else {
      for (const child of extChildren(def)) {
        if (typeof child.key === "string") keyed(child.key, child.schema);
        else walk(child.schema, path);
      }
    }
    inside.delete(s);
  };
  walk(schema, []);
  return [...out].sort();
}

/**
 * How an ext path is withheld from an assistant: "null" where the schema
 * takes null at every place it has the path (each union option, each
 * array's items), "omit" where it is optional at every one, and null
 * otherwise, which includes a path the schema does not have. The read
 * interface (./assistant-read.ts) sets the value to null or removes it
 * accordingly, then parses the ext again.
 */
export function withholdMode(schema: z.ZodType, path: string): "null" | "omit" | null {
  const found: z.ZodType[] = [];
  const at = (s: z.ZodType, keys: string[]): void => {
    if (keys.length === 0) return void found.push(s);
    const def = s._zod.def as unknown as Def;
    if (def.type === "object") {
      if (Object.hasOwn(def.shape!, keys[0])) at(def.shape![keys[0]], keys.slice(1));
    } else if (def.type === "record") {
      if (closedKeys(def.keyType!) && recordKeys(def.keyType!).includes(keys[0])) at(def.valueType!, keys.slice(1));
    } else {
      // As in extKeyPaths, a tuple's positions sit at the tuple's own path.
      for (const child of extChildren(def)) if (typeof child.key !== "string") at(child.schema, keys);
    }
  };
  at(schema, path.split("."));
  if (found.length === 0) return null;
  const flags = found.map((s) => {
    const seen = { nullable: false, optional: false };
    for (let def = s._zod.def as unknown as Def; ; def = def.innerType!._zod.def as unknown as Def) {
      if (def.type === "nullable") seen.nullable = true;
      else if (def.type === "optional") seen.optional = true;
      else if (def.type !== "readonly") break;
    }
    return seen;
  });
  if (flags.every((f) => f.nullable)) return "null";
  if (flags.every((f) => f.optional)) return "omit";
  return null;
}

// ── Assistant reading ───────────────────────────────────────────────────────

/*
 * `agent: "read"` is the only thing that lets an assistant read a view or a
 * watcher's signals (ViewDef and SignalDef in ../../surface.ts), and #133's
 * data boundary keeps from any assistant tenants' names and units, bills and
 * payment references, the identifiers of single devices, and every
 * watcher's signals together. So the mark is refused on a view or watcher
 * that is not on the code-owned list (ASSISTANT_READS, ADR-007 decision 8),
 * and, listed or not, besides on tenant views and on views reached from
 * configure or system navigation, on:
 *
 * - every view and watcher of a plugin below marked "refused": billing
 *   (billing-review is a service of the billing plugin, so whatever it shows
 *   is contributed as billing), payments and Pesapal carry bills, tenants
 *   and payment references; the tenant app is about a tenant's own unit;
 *   the operations plugin contributes nothing yet;
 * - a view whose path names a tenant, a device, a billing or payment
 *   record, or a tenant's access to its unit (community management's
 *   `community.tenant-access`, whose label and step name the person's
 *   address) (ASSISTANT_REFUSED_KINDS);
 * - a view that takes signals, which carries every watcher's answer;
 * - a view that declares a key prefix, whose keys the list's review cannot
 *   see.
 *
 * A marked view's declaration must also be the one its entry pins (ADR-007
 * decision 8): its declared keys, its ext's schema id and the key paths of
 * its ext schema (extKeyPaths), so a view that widens what it carries is
 * refused until its entry is edited and reviewed. The pin cannot see the
 * text a loader puts at a key or path, which is the entry's review and
 * CODEOWNERS' (ADR-007 decision 8); nor the links a model carries at run
 * time, which the entry allows by id and the read interface drops otherwise.
 *
 * ASSISTANT_READING is keyed by every plugin name, so a new or renamed
 * plugin does not type-check until someone decides whether its views and
 * watchers may be marked, and contribution-schema.test.ts fails while it and
 * the catalog differ. A name missing from it at run time is refused. "per
 * view" leaves the decision to each view's or watcher's entry on
 * ASSISTANT_READS and the rules on kinds and signals: those plugins' views
 * carry neither bills nor payments. If a plugin's views come to carry
 * them, revisit ASSISTANT_READING and those rules.
 *
 * The host's read interface (./assistant-read.ts) now refuses such
 * references per model too (./assistant-references.ts, which reads
 * ASSISTANT_REFUSED_KINDS and ASSISTANT_READING from here). These refusals
 * stay on purpose as the earlier stop: they refuse the mark when the
 * contribution registers, before any loader runs, where the per-model rule
 * can only refuse an answer after it was loaded. If the two ever disagree
 * on a kind or a plugin, change both.
 */
export const ASSISTANT_READING: Readonly<Record<MgmPluginName, "per view" | "refused">> = {
  "organization-directory": "per view",
  "community-management": "per view",
  metering: "per view",
  billing: "refused",
  payments: "refused",
  pesapal: "refused",
  "tenant-app": "refused",
  // No views or watchers yet. Refused until the pull request that builds
  // the investigation view decides it (ADR-007 decision 9), so a view
  // contributed before then cannot be marked by accident.
  operations: "refused",
};

/**
 * The entity kinds whose records an assistant may never read: through a
 * view's path here, and as a reference in what a view or watcher emits
 * (./assistant-references.ts). Besides the core kinds, community
 * management's `community.tenant-access`, a tenant's access to its unit,
 * whose label and step name the person's address. It is spelled here
 * rather than imported, so the host imports nothing from a capability;
 * assistant-references.test.ts pins it to TENANT_ACCESS_KIND. A plugin
 * kind added later that names a tenant, a tenant's access, a bill or a
 * payment joins this list, as it joins the action catalog's (./catalog.ts).
 */
export const ASSISTANT_REFUSED_KINDS: ReadonlySet<string> = new Set<CoreEntityKind | "community.tenant-access">([
  "tenant",
  "device",
  "rateSchedule",
  "billingPeriod",
  "lineItem",
  "paymentAttempt",
  "community.tenant-access",
]);

const READS_LIST = "src/lib/gui/assistant-reads.ts";
const NOUN = { view: "views", watcher: "watchers" } as const;

type ViewEntry = Extract<AssistantRead, { kind: "view" }>;
type ViewShape = NonNullable<Shape["views"]>[number];

/** What `wanted` has that `got` lacks, and the reverse, as a phrase; "" when they hold the same. */
function difference(got: readonly string[], wanted: readonly string[]): string {
  const extra = [...new Set(got)].filter((k) => !wanted.includes(k)).sort();
  const missing = [...new Set(wanted)].filter((k) => !got.includes(k)).sort();
  return [extra.length ? `not in the entry: ${extra.join(", ")}` : "", missing.length ? `not in the view: ${missing.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ");
}

/**
 * The pin (ADR-007 decision 8): a marked view's declaration must be its
 * entry's, and the entry's links and withheld paths must make sense for it.
 * `v` is a marked view, listed as `entry`. Keys and paths compare as sets,
 * and an entry that names one twice is refused, so a copy cannot stand in
 * for one the view dropped.
 */
function pinProblems(v: ViewShape, entry: ViewEntry, alias: string): { path: Path; message: string }[] {
  const problems: { path: Path; message: string }[] = [];
  const differs = (path: Path, what: string) =>
    problems.push({ path, message: `"${v.id}"'s declaration differs from its entry in ${READS_LIST}: ${what}` });

  const keys = difference(v.declares.keys, entry.declares.keys);
  if (keys) differs(["declares", "keys"], `keys (${keys})`);
  if (new Set(entry.declares.keys).size !== entry.declares.keys.length) differs(["declares", "keys"], "the entry names a key twice");

  const pinned = entry.declares.ext;
  if ((v.ext?.schema ?? null) !== (pinned?.schema ?? null))
    differs(["ext", "schema"], `ext schema (the view's is ${v.ext?.schema ?? "none"}, the entry's ${pinned?.schema ?? "none"})`);
  else if (v.ext && pinned) {
    const paths = difference(extKeyPaths(v.ext.zod), pinned.paths);
    if (paths) differs(["ext", "zod"], `ext paths (${paths})`);
    if (new Set(pinned.paths).size !== pinned.paths.length) differs(["ext", "zod"], "the entry names an ext path twice");
  }

  for (const path of entry.withhold?.ext ?? []) {
    const at: Path = ["ext"];
    const withheld = (why: string) =>
      problems.push({ path: at, message: `"${v.id}"'s entry in ${READS_LIST} withholds "${path}", ${why}` });
    if (!pinned || !pinned.paths.includes(path)) withheld("which is not one of its pinned ext paths");
    else if (v.ext && withholdMode(v.ext.zod, path) === null)
      withheld("which the ext schema does not let be null everywhere it is, nor optional everywhere");
  }
  // An id of another plugin's would let this view hand on a link that the
  // entry's review could not tell apart from one of that plugin's own.
  for (const id of entry.links)
    if (!id.startsWith(`${alias}.`))
      problems.push({ path: ["agent"], message: `"${v.id}"'s entry in ${READS_LIST} lists the link "${id}", which must start with the alias "${alias}."` });
  return problems;
}

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
      // A prefix admits keys nobody listed, so a key added under it would
      // reach an assistant with no change under src/lib/gui (ADR-007
      // decision 8): a view an assistant reads names every key it declares.
      // A tenant view has its one refusal above. If tenant views may be
      // listed (decision 10), drop the scope exemption here: tenant.home
      // declares the `meter.` prefix and is refused until it names its keys.
      if (v.scope !== "tenant" && (v.declares.prefixes?.length ?? 0) > 0)
        add(ctx, ["agent"], "a view an assistant may read declares its keys by name, not by prefix");
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
    // Required, so every action says what a repeat does. Which plugins may
    // declare "unsafe" is checked in CI by gui-surface.test.ts (check 12),
    // and that a "safe" one is safe by
    // src/lib/gui/__tests__/repeat.db.test.ts, which sends it twice to its
    // route; contribute() reads neither. If either check moves or goes,
    // revisit this and the header, which say where they are.
    repeat: repeatSchema,
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
    let described: unknown;
    try {
      described = z.toJSONSchema(a.input, { io: "input" });
    } catch (error) {
      add(ctx, ["input"], `${a.id}: the input cannot be described as JSON Schema: ${(error as Error).message}`);
    }
    for (const at of described === undefined ? [] : unconstrainedNodes(described)) {
      add(ctx, ["input"], `${a.id}: the input accepts any value at ${at || "its root"}; describe what it takes`);
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
    // The plugin and list rules need the catalog and the list, so they are in checkContribution.
    agent: z.literal("read").optional(),
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

function checkContribution(c: Shape, catalog: SurfaceCatalog, reads: readonly AssistantRead[], ctx: Ctx) {
  const entry = catalog.plugins.find((p) => p.name === c.plugin);
  if (!entry) return add(ctx, ["plugin"], `"${c.plugin}" is not a plugin in the catalog`);
  const ownKinds = new Set<string>((c.entities ?? []).map((e) => e.kind));
  /** The plugin and list rules on a view or watcher that carries the mark. */
  const readable = (kind: AssistantRead["kind"], id: string, path: Path) => {
    if (ASSISTANT_READING[c.plugin as MgmPluginName] !== "per view")
      add(ctx, path, `a ${c.plugin} ${kind} cannot be read by an assistant`);
    if (!reads.some((r) => r.kind === kind && r.id === id))
      add(ctx, path, `"${id}" is not on the list of ${NOUN[kind]} an assistant may read (${READS_LIST})`);
  };

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
    // A tenant view gets its own refusal (viewSchema) and only that one. If
    // tenant views may be listed (ADR-007 decision 10), revisit.
    if (v.agent === "read" && v.scope !== "tenant") {
      readable("view", v.id, ["views", i, "agent"]);
      const listed = reads.find((r): r is ViewEntry => r.kind === "view" && r.id === v.id);
      for (const p of listed ? pinProblems(v, listed, entry.alias) : []) add(ctx, ["views", i, ...p.path], p.message);
    }
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
  (c.signals ?? []).forEach((s, i) => {
    if (s.agent === "read") readable("watcher", s.id, ["signals", i, "agent"]);
  });
}

/**
 * Throws SurfaceContributionError unless `c` is a contribution that keeps
 * every rule above. `reads` is the list of what an assistant may read; only
 * tests pass another.
 */
export function parseContribution(
  c: unknown,
  catalog: SurfaceCatalog,
  reads: readonly AssistantRead[] = ASSISTANT_READS,
): ParsedContribution {
  const result = contributionSchema.superRefine((v, ctx) => checkContribution(v, catalog, reads, ctx)).safeParse(c);
  const named = (c as { plugin?: unknown } | null)?.plugin;
  const plugin = typeof named === "string" ? named : "(no plugin)";
  if (!result.success) throw new SurfaceContributionError(plugin, result.error);
  const alias = catalog.plugins.find((p) => p.name === plugin)!.alias;
  return { plugin: plugin as MgmPluginName, alias, contribution: c as Contribution };
}
