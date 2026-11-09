import "server-only";

/**
 * Strict schemas for every shape the GUI contract sends to a browser: view
 * models and what they carry, action specs and results, the confirmation
 * step, signals, status items, search hits, the manifest, the shell's initial
 * view and a GUI's metadata.
 *
 * Every object is strict, so a key the contract does not name is refused at
 * any depth, and nothing is stripped. Each schema's output type equals its
 * type in ../../contract.ts; __tests__/model-schema.test.ts fails to compile
 * while the two differ, so a contract edit lands together with its schema.
 *
 * These schemas check shape alone. They do not check whether a key was
 * declared by its view, whether an href is a released page or a released
 * download, or how large a model is: those depend on the view and the route
 * list, so the code that serves a view has to check them as well.
 */
import { z } from "zod";
import { CORE_ENTITY_KINDS } from "@/lib/plugins/bundled";
import type { Json, ViewKind, ViewModel } from "../../contract";
import { CARET_RANGE_RE } from "../shared/contract-range";

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * "<alias>.<name>": the alias as bundled.test.ts requires a catalog alias to
 * be, then dot-separated lowercase words. If that alias rule changes, change
 * this one with it.
 */
const ID_RE = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

export const idSchema = z
  .templateLiteral([z.string(), ".", z.string()])
  .refine((s) => s.length <= 128 && ID_RE.test(s), "Expected an id such as billing.periods");

const HREF_BASE = "https://host.invalid";

/**
 * A same-origin path. Refused: anything not starting with one "/", a
 * backslash, a control character, an encoded "/" or "\", and any path the URL
 * parser would rewrite. That covers "." and ".." segments, encoded or not, and
 * characters a path must carry percent-encoded, such as a space or "é".
 */
function isSameOriginPath(href: string): boolean {
  if (href.length > 2048 || !href.startsWith("/") || href.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(href) || /%(?:2f|5c)/i.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href, HREF_BASE);
  } catch {
    return false;
  }
  const path = href.split(/[?#]/, 1)[0];
  return url.origin === HREF_BASE && url.pathname === path;
}

export const hrefSchema = z
  .templateLiteral(["/", z.string()])
  .refine(isSameOriginPath, "Expected a same-origin path");

/** Characters encodeURIComponent leaves, plus percent escapes. */
const ENCODED = "[A-Za-z0-9%\\-_.!~*'()]*";
const WHATSAPP_RE = new RegExp(`^https://wa\\.me/\\d{6,15}(?:\\?text=${ENCODED})?$`);
const TEL_RE = /^tel:\+\d{6,15}$/;
const SMS_RE = new RegExp(`^sms:\\+\\d{6,15}(?:\\?body=${ENCODED})?$`);

export const outHrefSchema = z.union([
  z.templateLiteral(["https://wa.me/", z.string()]).refine((s) => WHATSAPP_RE.test(s), "Expected a wa.me number"),
  z.templateLiteral(["tel:", z.string()]).refine((s) => TEL_RE.test(s), "Expected tel:+<digits>"),
  z.templateLiteral(["sms:", z.string()]).refine((s) => SMS_RE.test(s), "Expected sms:+<digits>"),
]);

export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]),
);

const isoDateTime = z.iso.datetime({ offset: true });
const toneSchema = z.enum(["neutral", "info", "success", "warning", "danger", "accent"]);
export const confirmSchema = z.enum(["none", "confirm", "typed", "ceremony"]);
export const navGroupSchema = z.enum(["operate", "money", "configure", "system"]);
export const iconSchema = z.enum([
  "today", "live", "sites", "communities", "households", "devices", "readings",
  "billing", "payments", "tariff", "data-source", "branding", "accounts", "plugins",
  "users", "profile", "organizations", "assistant", "message", "alert", "download",
  "share", "contact", "help",
]);
const coreEntityKindSchema = z.enum(CORE_ENTITY_KINDS);
/** A core kind, or a plugin's own kind written like an id ("sms-reminders.send"). */
export const entityKindSchema = z.union([coreEntityKindSchema, idSchema]);

export const entityRefSchema = z.strictObject({
  kind: entityKindSchema,
  id: z.string().min(1),
  label: z.string(),
  href: hrefSchema.optional(),
});
export const entityHitSchema = entityRefSchema.extend({ href: hrefSchema });
export const trailSchema = z.array(z.strictObject({ label: z.string(), href: hrefSchema }));

// ── Values ──────────────────────────────────────────────────────────────────

const valueMeta = {
  text: z.string(),
  derived: z.literal(true).optional(),
  at: isoDateTime.optional(),
  synthetic: z.literal(true).optional(),
};
const valueTypes = [
  "text", "empty", "number", "percent", "money", "energy", "power", "date", "datetime", "status", "ref",
] as const;

export const valueSchema = z.discriminatedUnion("t", [
  z.strictObject({ ...valueMeta, t: z.literal("text") }),
  z.strictObject({ ...valueMeta, t: z.literal("empty") }),
  z.strictObject({ ...valueMeta, t: z.literal("number"), v: z.number(), unit: z.string().optional() }),
  z.strictObject({ ...valueMeta, t: z.literal("percent"), v: z.number() }),
  // Integer minor units, as Fmt.money computes them.
  z.strictObject({ ...valueMeta, t: z.literal("money"), v: z.int(), currency: z.string().regex(/^[A-Z]{3}$/) }),
  z.strictObject({ ...valueMeta, t: z.literal("energy"), v: z.number(), unit: z.enum(["Wh", "kWh"]) }),
  z.strictObject({ ...valueMeta, t: z.literal("power"), v: z.number(), unit: z.enum(["W", "kW"]) }),
  z.strictObject({ ...valueMeta, t: z.literal("date"), v: z.iso.date() }),
  z.strictObject({ ...valueMeta, t: z.literal("datetime"), v: isoDateTime, tz: z.string().min(1) }),
  z.strictObject({ ...valueMeta, t: z.literal("status"), v: z.string(), tone: toneSchema }),
  z.strictObject({ ...valueMeta, t: z.literal("ref"), ref: entityRefSchema }),
]);

export const inlineSchema = z.union([
  z.string(),
  z.strictObject({ value: valueSchema }),
  z.strictObject({ link: hrefSchema, text: z.string() }),
  z.strictObject({ unverified: z.string() }),
]);
export const richSchema = z.array(
  z.union([z.strictObject({ p: z.array(inlineSchema) }), z.strictObject({ li: z.array(inlineSchema) })]),
);

// ── Links and actions ───────────────────────────────────────────────────────

export const linkRefSchema = z.strictObject({
  id: idSchema,
  label: z.string(),
  icon: iconSchema.optional(),
  href: z.union([hrefSchema, outHrefSchema]),
  download: z.strictObject({ mime: z.string().min(1), filename: z.string().min(1) }).optional(),
  share: z.strictObject({ title: z.string(), text: z.string() }).optional(),
});

export const actionRefSchema = z.strictObject({
  action: idSchema,
  params: z.record(z.string(), z.string()),
  label: z.string(),
  enabled: z.boolean(),
  reason: z.string().optional(),
  tone: z.literal("danger").optional(),
  from: z.string().optional(),
  prefill: jsonSchema.optional(),
  provenance: z
    .strictObject({
      by: z.enum(["assistant", "watcher"]),
      proposal: z.string().optional(),
      at: isoDateTime,
    })
    .optional(),
});

export const actionSpecSchema = z.strictObject({
  type: z.literal("spec"),
  id: idSchema,
  title: z.string(),
  confirm: confirmSchema,
  inputVersion: z.int().positive(),
  input: jsonSchema,
});

export const actionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("result"),
    ok: z.literal(true),
    message: z.string().optional(),
    href: hrefSchema.optional(),
    next: actionRefSchema.optional(),
    signals: z.literal(true).optional(),
  }),
  z.strictObject({
    type: z.literal("result"),
    ok: z.literal(false),
    // 0 when the person cancelled; otherwise the HTTP status.
    status: z.int().min(0).max(599),
    code: z.string().min(1),
    message: z.string(),
    field: z.string().optional(),
  }),
]);

// ── The five view kinds ─────────────────────────────────────────────────────

/** Feed embeds carry a whole view model, so the union refers back to itself. */
const embeddedViewModelSchema: z.ZodType<ViewModel> = z.lazy(() => viewModelSchema);

const composeSchema = z.strictObject({
  action: actionRefSchema,
  textField: z.string().min(1),
  contextField: z.string().min(1).optional(),
  placeholder: z.string(),
});

export const bodySchemas = {
  collection: z.strictObject({
    columns: z.array(
      z.strictObject({
        key: z.string().min(1),
        label: z.string(),
        type: z.enum(valueTypes),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        copy: z.literal("bare").optional(),
      }),
    ),
    rows: z.array(
      z.strictObject({
        id: z.string().min(1),
        entity: entityRefSchema.optional(),
        related: z.array(entityRefSchema).optional(),
        href: hrefSchema.optional(),
        cells: z.record(z.string(), valueSchema),
        actions: z.array(actionRefSchema),
        links: z.array(linkRefSchema).optional(),
      }),
    ),
    totals: z.record(z.string(), valueSchema).optional(),
    filters: z
      .array(
        z.strictObject({
          label: z.string(),
          href: hrefSchema,
          count: z.int().nonnegative().optional(),
          current: z.boolean(),
        }),
      )
      .optional(),
    next: hrefSchema.optional(),
    empty: z.strictObject({ title: z.string(), text: z.string().optional(), action: actionRefSchema.optional() }),
  }),
  record: z.strictObject({
    sections: z.array(
      z.strictObject({
        title: z.string().optional(),
        fields: z.array(z.strictObject({ key: z.string().min(1), label: z.string(), value: valueSchema })),
      }),
    ),
  }),
  metrics: z.strictObject({
    tiles: z.array(
      z.strictObject({
        key: z.string().min(1),
        label: z.string(),
        value: valueSchema,
        status: valueSchema.optional(),
        hint: z.string().optional(),
      }),
    ),
    series: z
      .array(
        z.strictObject({
          key: z.string().min(1),
          label: z.string(),
          unit: z.string(),
          points: z.array(z.tuple([z.string(), z.number().nullable()])),
        }),
      )
      .optional(),
  }),
  feed: z.strictObject({
    entries: z.array(
      z.strictObject({
        id: z.string().min(1),
        at: isoDateTime,
        author: z.strictObject({ kind: z.enum(["person", "assistant", "system"]), name: z.string() }),
        text: richSchema,
        embed: z
          .discriminatedUnion("type", [
            z.strictObject({ type: z.literal("view"), href: hrefSchema, model: embeddedViewModelSchema }),
            z.strictObject({ type: z.literal("action"), ref: actionRefSchema }),
            z.strictObject({ type: z.literal("values"), values: z.array(valueSchema) }),
            z.strictObject({
              type: z.literal("steps"),
              steps: z.array(z.strictObject({ label: z.string(), ms: z.number().nonnegative(), ok: z.boolean() })),
            }),
          ])
          .optional(),
      }),
    ),
    compose: composeSchema.optional(),
    stop: actionRefSchema.optional(),
    busy: z.boolean().optional(),
  }),
  flow: z.strictObject({
    steps: z.array(
      z.strictObject({
        id: z.string().min(1),
        title: z.string(),
        state: z.enum(["done", "current", "todo", "blocked"]),
        detail: z.string().optional(),
        href: hrefSchema.optional(),
        action: actionRefSchema.optional(),
      }),
    ),
  }),
};

export const extSchemaName = z
  .templateLiteral([z.string(), ".", z.string(), "@", z.number()])
  .refine((s) => {
    const at = s.lastIndexOf("@");
    return ID_RE.test(s.slice(0, at)) && /^[1-9]\d*$/.test(s.slice(at + 1));
  }, "Expected <id>@<version>");

function modelOf<K extends ViewKind>(kind: K) {
  return z.strictObject({
    type: z.literal("view"),
    view: idSchema,
    kind: z.literal(kind),
    body: bodySchemas[kind],
    title: z.string(),
    subtitle: z.string().optional(),
    org: z.string().min(1).nullable(),
    entity: entityRefSchema.optional(),
    trail: trailSchema,
    actions: z.array(actionRefSchema),
    links: z.array(linkRefSchema),
    attached: z.array(
      z.strictObject({
        view: idSchema,
        title: z.string(),
        href: hrefSchema,
        hint: z.enum(["section", "tab", "tile"]),
      }),
    ),
    notice: z.strictObject({ tone: toneSchema, text: z.string() }).optional(),
    live: z
      .strictObject({ refreshSeconds: z.number().positive(), staleAfterSeconds: z.number().positive() })
      .optional(),
    ext: z.strictObject({ schema: extSchemaName, data: jsonSchema }).optional(),
  });
}

export const modelSchemas = {
  collection: modelOf("collection"),
  record: modelOf("record"),
  metrics: modelOf("metrics"),
  feed: modelOf("feed"),
  flow: modelOf("flow"),
};

/** The schema for one kind's model. */
export function modelSchema<K extends ViewKind>(kind: K): (typeof modelSchemas)[K] {
  return modelSchemas[kind];
}

export const viewModelSchema = z.discriminatedUnion("kind", [
  modelSchemas.collection,
  modelSchemas.record,
  modelSchemas.metrics,
  modelSchemas.feed,
  modelSchemas.flow,
]);

// ── The confirmation step ───────────────────────────────────────────────────

export const ceremonySchema = z.strictObject({
  type: z.literal("ceremony"),
  statement: z.string().min(1),
  facts: z.array(z.strictObject({ label: z.string(), value: valueSchema })),
  warnings: z.array(z.string()),
  acknowledgements: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1) })),
  typed: z.string().min(1).optional(),
  digest: z.string().min(1).optional(),
});

// ── What the shell receives ─────────────────────────────────────────────────

const signalBase = {
  id: z.string().min(1),
  source: idSchema,
  severity: z.enum(["info", "warn", "critical"]),
  title: z.string(),
  facts: z.array(valueSchema).optional(),
  entity: entityRefSchema.optional(),
  href: hrefSchema,
  at: isoDateTime,
  due: z.union([z.iso.date(), isoDateTime]).optional(),
};
/** Only a proposal carries an action; a your-move signal links to the step instead. */
export const signalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...signalBase, kind: z.literal("alarm") }),
  z.strictObject({ ...signalBase, kind: z.literal("your-move") }),
  z.strictObject({ ...signalBase, kind: z.literal("proposal"), action: actionRefSchema }),
  z.strictObject({ ...signalBase, kind: z.literal("question") }),
  z.strictObject({ ...signalBase, kind: z.literal("info") }),
]);
export const signalsSchema = z.strictObject({
  type: z.literal("signals"),
  org: z.string().min(1),
  count: z.int().nonnegative(),
  top: z.array(signalSchema),
  checked: z.array(idSchema),
  unchecked: z.array(idSchema),
});

export const statusItemSchema = z.strictObject({
  id: idSchema,
  label: z.string(),
  state: z.enum(["off", "idle", "working", "needs-you"]),
  open: hrefSchema,
  ask: composeSchema.optional(),
});

const navEntrySchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  icon: iconSchema,
  group: navGroupSchema,
  order: z.number(),
  href: hrefSchema,
  needs: z.array(coreEntityKindSchema),
  legacy: z.literal(true).optional(),
});
const orgManifestSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  href: hrefSchema,
  timezone: z.string().min(1).nullable(),
  nav: z.array(navEntrySchema),
  status: z.array(statusItemSchema),
  places: z.array(entityRefSchema.extend({ parent: z.string().min(1).optional() })),
});
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export const manifestSchema = z.strictObject({
  type: z.literal("manifest"),
  contract: z.string().regex(SEMVER_RE),
  release: z.string().min(1).nullable(),
  locale: z.string().min(1),
  now: isoDateTime,
  gui: z.string().min(1),
  // Name and email only, so a manifest carrying anything else about the person is refused.
  user: z.strictObject({ name: z.string().nullable(), email: z.string() }),
  org: orgManifestSchema,
  orgs: z.array(z.strictObject({ id: z.string().min(1), name: z.string(), href: hrefSchema })),
});

export const initialViewSchema = z.strictObject({
  view: idSchema.nullable(),
  title: z.string(),
  trail: trailSchema,
  tabs: z.array(z.strictObject({ title: z.string(), href: hrefSchema, current: z.boolean() })),
  scope: z.partialRecord(coreEntityKindSchema, entityRefSchema),
});

// ── A GUI's metadata ────────────────────────────────────────────────────────

export const guiMetaSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
  title: z.string().min(1),
  version: z.string().regex(SEMVER_RE),
  /** A caret range over MAJOR.MINOR or MAJOR.MINOR.PATCH: "^0.1", "^0.1.2", "^1.2". */
  contract: z.string().regex(CARET_RANGE_RE),
  styles: z
    .string()
    .regex(/^\.\/[\w./-]+\.css$/)
    .refine((s) => !s.split("/").includes(".."), "Expected a path inside the package"),
  dependencies: z
    .array(z.string().min(1))
    .refine((d) => new Set(d).size === d.length, "Each dependency is listed once")
    .readonly(),
});
