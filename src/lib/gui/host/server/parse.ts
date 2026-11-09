import "server-only";

/**
 * The strict parse of what a view's loader returns, built from the view's
 * definition on top of the static shapes in ./model-schema.ts:
 *
 * - cell, total, column, field, tile and series keys must be declared by the
 *   view (`declares.keys`, or a declared prefix);
 * - `ext` is allowed only when the view declares one, under its own schema
 *   name, and its data is parsed with the view's strict zod schema;
 * - page hrefs must be released pages outside /api, and a LinkRef's href a
 *   page, a released download or an OutHref (./hrefs.ts);
 * - sizes are capped (MODEL_CAPS).
 *
 * A failure reports paths and issue codes, never values. Path segments that
 * are not names from the schemas or the view's declared keys, such as an
 * undeclared cell key, print as "*", and no zod message is reported, so a
 * value placed anywhere in a model cannot reach a log or a response.
 */
import { z } from "zod";
import type { LoadedModel, ViewDef } from "../../surface";
import { keysOf, type KindAndBody } from "./contribution-schema";
import { isLinkHref, isPageHref } from "./hrefs";
import { loadedModelSchemas } from "./model-schema";

export const MODEL_CAPS = {
  rows: 500,
  columns: 50,
  /** Characters in any one string. */
  text: 4_000,
  /** Points in one series. */
  points: 2_000,
  entries: 200,
} as const;

/** How many failing paths a failure reports. */
const MAX_REPORTED = 20;

type Path = PropertyKey[];
type Reason = "undeclared" | "href" | "too_large";

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; paths: string[] };

function refuse(ctx: z.RefinementCtx, path: Path, reason: Reason) {
  ctx.addIssue({ code: "custom", path, message: reason, params: { reason } });
}

// ── Names that may appear in a reported path ────────────────────────────────

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  options?: z.ZodType[];
  innerType?: z.ZodType;
  valueType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  left?: z.ZodType;
  right?: z.ZodType;
  getter?: () => z.ZodType;
};

const namesCache = new WeakMap<z.ZodType, ReadonlySet<string>>();

/**
 * Every object key a schema names, at any depth. A record's keys are data,
 * so they are not collected.
 */
export function schemaNames(schema: z.ZodType): ReadonlySet<string> {
  const cached = namesCache.get(schema);
  if (cached) return cached;
  const names = new Set<string>();
  const seen = new Set<z.ZodType>();
  const walk = (s: z.ZodType | null | undefined) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    const def = s._zod.def as unknown as Def;
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      names.add(key);
      walk(child);
    }
    if (def.type === "lazy") walk(def.getter!());
    for (const child of [def.element, def.rest, def.innerType, def.valueType, def.in, def.out, def.left, def.right]) walk(child);
    for (const child of [...(def.items ?? []), ...(def.options ?? [])]) walk(child);
  };
  walk(schema);
  namesCache.set(schema, names);
  return names;
}

function describe(issue: z.core.$ZodIssue, names: ReadonlySet<string>): string {
  const path = issue.path.map((p) => (typeof p === "number" || names.has(String(p)) ? String(p) : "*")).join(".");
  const reason = issue.code === "custom" ? (issue.params?.reason ?? "custom") : issue.code;
  return `${path || "(model)"} ${reason}`;
}

/**
 * Parses `value` with `schema`. On a failure it logs the label (a view or
 * action id) with the paths and codes, and returns them. `names` are the
 * path segments that may be printed; it defaults to the schema's own.
 */
export function parseOrFail<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  names: ReadonlySet<string> = schemaNames(schema),
): ParseOutcome<T> {
  let paths: string[];
  try {
    const result = schema.safeParse(value);
    if (result.success) return { ok: true, value: result.data };
    paths = [...new Set(result.error.issues.map((issue) => describe(issue, names)))];
  } catch {
    // An asynchronous refinement in an ext schema throws on a synchronous parse.
    paths = ["(model) unparseable"];
  }
  const more = paths.length > MAX_REPORTED ? [`and ${paths.length - MAX_REPORTED} more`] : [];
  paths = [...paths.slice(0, MAX_REPORTED), ...more];
  console.error(`[gui] ${label}: output refused at ${paths.join("; ")}`);
  return { ok: false, paths };
}

// ── Per-view schemas ────────────────────────────────────────────────────────

/*
 * The walk below finds hrefs, data and records by property name. These sets
 * describe the shapes in ./model-schema.ts; parse.test.ts walks
 * loadedModelSchemas and fails if a new href, record or LinkRef position does
 * not fit them. If a model shape gains one under another name, add it here.
 */
/** Keys whose subtree is data rather than model: no href rule applies inside them. */
export const DATA_KEYS: ReadonlySet<string> = new Set(["ext", "prefill", "params"]);
/** The only string properties in a model that hold hrefs, once the shape parse has passed. */
export const HREF_KEYS: ReadonlySet<string> = new Set(["href", "link", "next"]);
/** Records whose keys are the view's declared keys, so they never change the href rule. */
export const RECORD_KEYS: ReadonlySet<string> = new Set(["cells", "totals"]);

type HrefRule = "page" | "link" | null;

/**
 * Href rules and the string cap, over a model that has passed the shape parse.
 * Under a record (`keysAreData`) a key is a declared key, not a property name,
 * so it never switches the rule.
 */
function walk(ctx: z.RefinementCtx, value: unknown, path: Path, hrefs: HrefRule, keysAreData = false) {
  if (typeof value === "string") {
    if (value.length > MODEL_CAPS.text) refuse(ctx, path, "too_large");
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => walk(ctx, item, [...path, i], hrefs));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const at = [...path, key];
      if (hrefs && HREF_KEYS.has(key) && typeof child === "string") {
        if (!(hrefs === "link" ? isLinkHref(child) : isPageHref(child))) refuse(ctx, at, "href");
        continue;
      }
      const rule = hrefs === null || keysAreData ? hrefs : DATA_KEYS.has(key) ? null : key === "links" ? "link" : hrefs;
      walk(ctx, child, at, rule, !keysAreData && RECORD_KEYS.has(key));
    }
  }
}

function checkSizes(ctx: z.RefinementCtx, m: KindAndBody) {
  const cap = (n: number, max: number, path: Path) => n > max && refuse(ctx, path, "too_large");
  if (m.kind === "collection") {
    cap(m.body.rows.length, MODEL_CAPS.rows, ["body", "rows"]);
    cap(m.body.columns.length, MODEL_CAPS.columns, ["body", "columns"]);
  } else if (m.kind === "metrics") {
    (m.body.series ?? []).forEach((s, i) => cap(s.points.length, MODEL_CAPS.points, ["body", "series", i, "points"]));
  } else if (m.kind === "feed") {
    cap(m.body.entries.length, MODEL_CAPS.entries, ["body", "entries"]);
  }
}

type Compiled = { schema: z.ZodType; names: ReadonlySet<string> };
const compiled = new WeakMap<ViewDef, Compiled>();

function compile(def: ViewDef): Compiled {
  const declared = (key: string) =>
    def.declares.keys.includes(key) || (def.declares.prefixes ?? []).some((prefix) => key.startsWith(prefix));
  const ext = def.ext ? z.strictObject({ schema: z.literal(def.ext.schema), data: def.ext.zod }) : z.never();
  const base = loadedModelSchemas[def.kind] as unknown as z.ZodObject;
  const schema = base.extend({ ext: ext.optional() }).superRefine((model, ctx) => {
    const m = { kind: def.kind, body: model.body } as KindAndBody;
    checkSizes(ctx, m);
    for (const [key, path] of keysOf(m)) if (!declared(key)) refuse(ctx, path, "undeclared");
    walk(ctx, model, [], "page");
  });
  // Declared prefixes are not names: a key matched by one prints as "*".
  const names = new Set([...schemaNames(schema), ...def.declares.keys]);
  return { schema, names };
}

function compiledFor(def: ViewDef): Compiled {
  let entry = compiled.get(def);
  if (!entry) compiled.set(def, (entry = compile(def)));
  return entry;
}

/** The strict schema for what this view's loader returns. Built once per definition. */
export function loadedModelSchemaFor(def: ViewDef): z.ZodType {
  return compiledFor(def).schema;
}

/** Parses a loader's model against its view. Nothing is stripped: any extra fails. */
export function strictParseModel<D extends ViewDef>(def: D, model: unknown): ParseOutcome<LoadedModel<D["kind"]>> {
  const { schema, names } = compiledFor(def);
  return parseOrFail(schema as z.ZodType<LoadedModel<D["kind"]>>, model, `view ${def.id}`, names);
}
