import "server-only";

/**
 * The OpenAPI document of the described API (RFC #259 § 3, #282): the GUI
 * host's routes under /api/gui/ and the route of every action a plugin
 * contributes, generated from the surface snapshot, so it lists exactly the
 * actions the registry holds.
 *
 * - Each action route is one operation, however many actions are sent to it
 *   (OpenAPI takes one per method and path): its path parameters, each of
 *   the kind its actions bind; the body its route parses (describeBody in
 *   ./input-spec.ts); and under `x-mgm-actions`, each action as the action
 *   catalog describes it (describeAction in ./catalog.ts).
 * - Each host route is one operation, from HOST_ROUTES below. Its answer is
 *   described by the strict schema the host parses that answer with
 *   (./model-schema.ts), named after its type in ../../contract.ts.
 * - The host's routes refuse in the `{ error, code }` shape
 *   (HostFailureBody). An action's route refuses as ActionRefusal below
 *   says: the codes this document names come in `code`, but the route's own
 *   refusals are not all alike. Each operation names the codes its route is
 *   known to answer, from ./error-codes.ts; an action route's list is
 *   partial and says so. The document lists that module's codes whole under
 *   `x-mgm-error-codes`.
 *
 * Deterministic: paths, operations, actions, schemas and codes are sorted,
 * and nothing reads the clock, the environment or the database, so one
 * commit always generates the same document. `npm run api:openapi` writes
 * it to docs/api/openapi.json, and __tests__/openapi.test.ts fails while the
 * committed file differs from what the registry generates.
 */
import { z } from "zod";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { CORE_ENTITY_KINDS, MGM_BUNDLED_PLUGINS, type MgmPluginName } from "@/lib/plugins/bundled";
import { GUI_CONTRACT, type EntityKind, type Json } from "../../contract";
import { OWN_ID_RE, byCatalogOrder } from "../shared/merge-actions";
import { TENANT_UNIT_PARAM } from "../shared/tenant-units";
import { MAX_CATALOG_ENTITIES, describeAction } from "./catalog";
import { BODY_CODES, GATE_CODES, HOST_CODES, gateCode, listedCodes, type GateRefusal, type HostCode } from "./error-codes";
import { describeBody } from "./input-spec";
import * as model from "./model-schema";
import { MAX_PREPARE_BYTES, prepareBodySchema, preparedActionSchema } from "./prepare";
import { MAX_HITS, QUERY_LENGTH } from "./search";
import type { RegisteredAction, SurfaceSnapshot } from "./surface-registry";

type JsonObject = { [key: string]: Json };
export type OpenApiDocument = JsonObject;

/** The OpenAPI version the document is written in: 3.1, whose schemas are JSON Schema 2020-12, as zod writes them. */
export const OPENAPI_VERSION = "3.1.0";

/** What the document reads of the registry. */
export type DescribedSurface = Pick<SurfaceSnapshot, "actions" | "views">;

/**
 * The host's answers and request bodies, from the strict schema the host
 * parses each with, named after the type in ../../contract.ts it checks
 * (<Kind>Model for ModelOf<K>, Provenance for ActionRef's provenance;
 * PrepareRequest and PreparedAction are prepare.ts's). Each is described once
 * and referred to by name, so a shape that several answers share, or one
 * that holds itself (Json, ViewModel), is written once. A schema these use
 * through itself and that has no name here makes componentSchemas throw;
 * give it one.
 */
export const HOST_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ActionCatalog: model.actionCatalogSchema,
  ActionRef: model.actionRefSchema,
  ActionSpec: model.actionSpecSchema,
  AvailabilityCheck: model.availabilityCheckSchema,
  CatalogAvailability: model.catalogAvailabilitySchema,
  CatalogEntry: model.catalogEntrySchema,
  Ceremony: model.ceremonySchema,
  CollectionModel: model.modelSchemas.collection,
  Confirm: model.confirmSchema,
  EntityHit: model.entityHitSchema,
  EntityKind: model.entityKindSchema,
  EntityRef: model.entityRefSchema,
  FeedModel: model.modelSchemas.feed,
  FlowModel: model.modelSchemas.flow,
  HostFailureBody: model.hostFailureBodySchema,
  Href: model.hrefSchema,
  Icon: model.iconSchema,
  Id: model.idSchema,
  Inline: model.inlineSchema,
  Json: model.jsonSchema,
  LinkRef: model.linkRefSchema,
  Manifest: model.manifestSchema,
  MetricsModel: model.modelSchemas.metrics,
  PrepareRequest: prepareBodySchema,
  PreparedAction: preparedActionSchema,
  Provenance: model.provenanceSchema,
  RecordModel: model.modelSchemas.record,
  Repeat: model.repeatSchema,
  Rich: model.richSchema,
  Signal: model.signalSchema,
  Signals: model.signalsSchema,
  StatusItem: model.statusItemSchema,
  Trail: model.trailSchema,
  Value: model.valueSchema,
  ViewModel: model.viewModelSchema,
};

/**
 * Schemas the document writes itself: the shapes of refusals no host schema
 * parses.
 *
 * ActionRefusal is what an action's route answers today, read as the GUI
 * kit reads it (failureOf in ../client/invoke.ts: `code` when there is one,
 * and `error`, else `message`). The codes the document names on an action
 * route come in `code`: parseJsonBody's and gateRoute's `{ error, code }`,
 * and the `{ code, message }` billing's composer and capability answer.
 * The routes' own refusals were written before the described API: some
 * carry `code`, many a `reason` instead, some only `error`. If the action
 * routes come to refuse in one shape, a route answers a named code in
 * another field, or failureOf reads another field, revisit it.
 */
const OWN_SCHEMAS: Readonly<Record<string, JsonObject>> = {
  ActionRefusal: {
    type: "object",
    description: [
      "How an action's route refuses. A code this document names for the route comes in `code`, which is stable. The route's own refusals were written before the described API and are not all alike: one may carry `code`, a `reason` instead, or only text. The text to show a person is `error`, or `message` where there is no `error`.",
      "Read it as MGM's GUI kit does: `code` when there is one, and `error`, else `message`. A route may add fields of its own, such as `field`, the body field a problem is in.",
    ].join("\n\n"),
    properties: {
      error: { type: "string" },
      message: { type: "string" },
      code: { type: "string", minLength: 1 },
      reason: { type: "string" },
      field: { type: "string" },
    },
    anyOf: [{ required: ["error"] }, { required: ["message"] }],
  },
  SessionRequired: {
    type: "object",
    description: "Middleware's answer to a request with no session, before any route runs. It carries no code.",
    properties: { error: { type: "string" } },
    required: ["error"],
  },
};

const schemaRef = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A plain JSON copy: zod adds a non-enumerable "~standard" property, and the result must hold nothing else. */
const plain = <T>(value: T): Json => JSON.parse(JSON.stringify(value)) as Json;

/** Whether `key` is a key anywhere in `node`. */
function hasKey(node: Json, key: string): boolean {
  if (Array.isArray(node)) return node.some((child) => hasKey(child, key));
  if (node === null || typeof node !== "object") return false;
  return Object.hasOwn(node, key) || Object.values(node).some((child) => hasKey(child, key));
}

/** HOST_SCHEMAS as JSON Schema, referring to each other by name, sorted by name. */
export function componentSchemas(): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(HOST_SCHEMAS)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}`, io: "output" });
  const out: Record<string, Json> = {};
  for (const name of Object.keys(schemas).sort(byText)) {
    if (!Object.hasOwn(HOST_SCHEMAS, name)) {
      throw new Error(`OpenAPI: a host schema holds a part of itself with no name (${name}); name that part in HOST_SCHEMAS`);
    }
    const { $schema: _dialect, $id: _id, ...schema } = plain(schemas[name]) as JsonObject;
    void _dialect;
    void _id;
    out[name] = schema;
  }
  return out;
}

const CORE_KINDS: ReadonlySet<string> = new Set(CORE_ENTITY_KINDS);
const NON_CORE: ReadonlySet<MgmPluginName> = new Set(MGM_BUNDLED_PLUGINS.filter((p) => !p.core).map((p) => p.name));

/** The id of a record of `kind` in a path, as idFits (../shared/merge-actions.ts) accepts it. */
function idSchema(kind: EntityKind): JsonObject {
  return CORE_KINDS.has(kind) ? { type: "string", format: "uuid" } : { type: "string", pattern: OWN_ID_RE.source };
}

/** The [name] segments of a route pattern, in order. */
const segments = (pattern: string) => [...pattern.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
/** A route pattern as an OpenAPI path: /api/billing-periods/{periodId}. */
const templated = (pattern: string) => pattern.replace(/\[([^\]]+)\]/g, "{$1}");
/**
 * Whether the route is part of this release. "0" fills each segment, as the
 * catalog's `installed` check does: every released API pattern takes any id
 * there (src/lib/mgm/released-routes.ts). If one comes to check an id's
 * shape, fill each segment with an id of its kind.
 */
const released = (pattern: string) => isReleasedRoute(pattern.replace(/\[[^\]]+\]/g, "0"));
/** The method and the route's words, as one identifier: postBillingPeriodsPeriodIdClose. */
function operationId(method: string, pattern: string): string {
  const words = pattern
    .split("/")
    .filter((s) => s !== "" && s !== "api")
    .flatMap((s) => s.replace(/[[\]]/g, "").split(/[-_]/));
  return method.toLowerCase() + words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** The gate refusals the document's routes answer, which it lists with the other codes. */
type GateList = (readonly [MgmPluginName, GateRefusal])[];

/** One code an operation's route answers, with its statuses and meaning. */
type Coded = { code: string; status: readonly number[]; meaning: string };

const hostCode = (code: HostCode): Coded => ({ code, ...HOST_CODES[code] });
const gateCoded = (plugin: MgmPluginName, refusal: GateRefusal): Coded => ({
  code: gateCode(plugin, refusal),
  status: GATE_CODES[refusal].status,
  meaning: GATE_CODES[refusal].meaning,
});
const BODY_REFUSAL: Coded = { code: "invalid_body", ...BODY_CODES.invalid_body };

/** What a partial code list says of the codes it leaves out. */
const ROUTE_OWN = "And refusals of the route's own, which this document does not list yet.";

/**
 * One response per status, each naming its codes in `x-mgm-codes` and its
 * description. A `partial` list, an action route's, says so in its
 * description and with `x-mgm-codes-complete: false`.
 */
function refusalResponses(coded: readonly Coded[], schema: JsonObject, o: { partial: boolean }): Map<number, JsonObject> {
  const byStatus = new Map<number, Map<string, Coded>>();
  for (const c of coded) {
    for (const status of c.status) byStatus.set(status, (byStatus.get(status) ?? new Map()).set(c.code, c));
  }
  const out = new Map<number, JsonObject>();
  for (const [status, codes] of byStatus) {
    const sorted = [...codes.values()].sort((a, b) => byText(a.code, b.code));
    const listed = sorted.map((c) => `- \`${c.code}\`: ${c.meaning}`).join("\n");
    out.set(status, {
      description: o.partial ? `${listed}\n\n${ROUTE_OWN}` : listed,
      content: { "application/json": { schema } },
      "x-mgm-codes": sorted.map((c) => c.code),
      ...(o.partial ? { "x-mgm-codes-complete": false } : {}),
    });
  }
  return out;
}

// Middleware's own answers (src/middleware.ts): a 404 with a plain-text body
// for a path isReleasedRoute refuses, and a 401 `{ error }` for an /api
// request with no session, both before any route and with no code. If
// either comes to carry a code or another body, change these and
// SessionRequired with it.
const NOT_RELEASED =
  "This route is not part of this release: middleware answers every request to it 404, with a plain-text body and no code, before the route runs.";
const SESSION_REQUIRED = "Middleware answers a request with no session `{ error }`, with no code, before the route runs.";
/**
 * An action route's own 401: middleware checks only the token's signature
 * and expiry, so a session signed out elsewhere reaches the route, whose
 * Supabase Auth check refuses it (CLAUDE.md § "Session checks before
 * privilege"). The routes answer it in their own shapes, some with a code
 * (composeBilling's `billing_unauthenticated`), some without. If every
 * action route comes to answer it with one code, list that code instead.
 */
const ROUTE_SESSION_CHECK: JsonObject = {
  description:
    "The route's own, when Supabase Auth refuses a session middleware let through, such as one signed out on another device. Some routes answer it with a code, some with a `reason` or only text.",
  "x-mgm-codes": [],
  "x-mgm-codes-complete": false,
};

/** A response's `x-` fields, such as its codes, to carry over when it is merged with middleware's. */
const extensions = (response: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(response).filter(([key]) => key.startsWith("x-")));

/**
 * The responses of an operation: its answer, each refusal by status, then
 * `default`. A JSON object lists integer-like keys first, so an action's
 * "2XX" follows its refusals. 401 is middleware's answer, with the route's
 * own beside it when the route has one; a route not released also gets
 * middleware's plain-text 404.
 */
function responses(
  answer: [string, JsonObject],
  refused: Map<number, JsonObject>,
  o: { released: boolean; routeSchema: JsonObject; fallback?: JsonObject },
): JsonObject {
  const byStatus = new Map(refused);
  const own401 = byStatus.get(401);
  byStatus.set(
    401,
    own401
      ? {
          description: `${SESSION_REQUIRED}\n\n${own401.description as string}`,
          content: { "application/json": { schema: { anyOf: [o.routeSchema, schemaRef("SessionRequired")] } } },
          ...extensions(own401),
        }
      : { $ref: "#/components/responses/SessionRequired" },
  );
  if (!o.released) {
    const own404 = byStatus.get(404);
    byStatus.set(404, {
      description: own404 ? `${NOT_RELEASED}\n\n${own404.description as string}` : NOT_RELEASED,
      content: { ...((own404?.content as JsonObject | undefined) ?? {}), "text/plain": { schema: { type: "string" } } },
      ...(own404 ? extensions(own404) : {}),
    });
  }
  return Object.fromEntries([
    answer,
    ...[...byStatus.entries()].sort(([a], [b]) => a - b).map(([status, r]) => [String(status), r] as const),
    ...(o.fallback ? [["default", o.fallback] as const] : []),
  ]);
}

// ── The host's routes ───────────────────────────────────────────────────────

type HostRoute = {
  method: "GET" | "POST";
  path: `/api/gui/${string}`;
  summary: string;
  description: string;
  /** Query parameters, each without `in`. */
  query?: readonly JsonObject[];
  /** The request body's schema in HOST_SCHEMAS. */
  body?: string;
  /** The answer's schema, and what it is. */
  answer: { schema: JsonObject; description: string };
  /** The host's codes the route refuses with. */
  codes: readonly HostCode[];
  /** The gate refusals the route passes on, by plugin. */
  gate?(surface: DescribedSurface): Iterable<readonly [MgmPluginName, GateRefusal]>;
};

const ORG_HINT =
  "The organization the person last used (a cookie MGM sets) is a hint when the request names none; like `org`, it only chooses among the organizations the person can see.";

/**
 * The GUI host's routes (src/app/api/gui/), with the parameters each reads
 * and the codes it refuses with. Written by hand: a route that comes to read
 * another parameter, or to refuse with another code, changes its entry here.
 * openapi.test.ts fails while a route file there has no entry or exports
 * another method, or a code here is not in ./error-codes.ts.
 */
export const HOST_ROUTES: readonly HostRoute[] = [
  {
    method: "GET",
    path: "/api/gui/catalog",
    summary: "The actions the person may see, and whether each can be sent now",
    description: [
      "Every action contributed to the organization, in catalog order and then by id, with its route, its input as JSON Schema and whether it is available, and why not. Reads only: it asks each action's own `available()`, but never prepares or sends one.",
      `Takes \`org\`, or up to ${MAX_CATALOG_ENTITIES} \`entity=<kind>:<id>\`, each of another kind, and nothing else. Entities decide the organization and limit the list to the actions offered on their kinds. A person who reaches no organization but rents a unit, or whose roles are all tenant roles, gets no actions.`,
      ORG_HINT,
    ].join("\n\n"),
    query: [
      { name: "org", required: false, description: "The organization to answer for. One the person cannot see is a 404.", schema: { type: "string", format: "uuid" } },
      {
        name: "entity",
        required: false,
        description: "A record to ask about, as `<kind>:<id>`. Not together with `org`.",
        style: "form",
        explode: true,
        schema: { type: "array", items: { type: "string", pattern: "^[^:]+:.+$" }, maxItems: MAX_CATALOG_ENTITIES },
      },
    ],
    answer: { schema: schemaRef("ActionCatalog"), description: "The actions, each with its availability." },
    codes: ["gui_bad_request", "gui_no_access", "gui_not_found", "gui_output_invalid", "gui_unauthenticated", "gui_unavailable"],
  },
  {
    method: "GET",
    path: "/api/gui/manifest",
    summary: "The person's manifest: places, navigation and the views it names",
    description: [
      "The manifest the signed-in layout renders, with the interface the installation serves. Takes `path` and `org`, each at most once, and nothing else.",
      `The organization asked for is \`org\`, else the \`?org=\` of \`path\`. ${ORG_HINT}`,
    ].join("\n\n"),
    query: [
      { name: "path", required: false, description: "A page on this site, with its own query: the manifest is built for it.", schema: { type: "string" } },
      { name: "org", required: false, description: "The organization to build the manifest for.", schema: { type: "string", format: "uuid" } },
    ],
    answer: { schema: schemaRef("Manifest"), description: "The manifest." },
    codes: ["gui_bad_request", "gui_manifest_failed", "gui_no_access", "gui_unauthenticated"],
  },
  {
    method: "POST",
    path: "/api/gui/prepare",
    summary: "An action's form and confirmation step",
    description: [
      "Prepares one action on its records for the signed-in person: the JSON Schema of the fields a person enters, a cleaned prefill, the confirmation step and the route and method the write goes to. Writes nothing: the write is sent to the action's own route, which checks the confirmation again.",
      `The body is read up to ${MAX_PREPARE_BYTES} bytes.`,
    ].join("\n\n"),
    body: "PrepareRequest",
    answer: { schema: schemaRef("PreparedAction"), description: "The prepared action." },
    codes: [
      "gui_action_refused",
      "gui_action_unavailable",
      "gui_bad_request",
      "gui_body_too_large",
      "gui_human_only",
      "gui_no_access",
      "gui_not_found",
      "gui_output_invalid",
      "gui_prepare_failed",
      "gui_unauthenticated",
      "gui_unavailable",
    ],
    // The gate is asked as a write, as the action's route asks it, for each
    // non-core plugin's action. An action declaring whilePluginOff passes its
    // 409 (gateRefusal in ./availability.ts). If prepare stops asking the
    // gate, or gateRefusal stops passing that 409, revisit these codes.
    *gate(surface) {
      for (const { plugin, def } of surface.actions.values()) {
        if (!NON_CORE.has(plugin)) continue;
        yield [plugin, "unavailable"] as const;
        if (def.whilePluginOff !== "enabled") yield [plugin, "disabled"] as const;
      }
    },
  },
  {
    method: "GET",
    path: "/api/gui/search",
    summary: "Records and places matching a search",
    description: `Hits from every contributed search of the prefix, in one of the person's organizations, at most ${MAX_HITS}. A search that is late or fails is left out.`,
    query: [
      {
        name: "q",
        required: true,
        description: `What to search for: ${QUERY_LENGTH.min} to ${QUERY_LENGTH.max} characters once trimmed, with no control characters.`,
        schema: { type: "string" },
      },
      { name: "prefix", required: true, description: "`@` for places and people, `#` for records.", schema: { type: "string", enum: ["@", "#"] } },
      { name: "org", required: false, description: "The organization to search; one the person cannot see is ignored, and their first is searched.", schema: { type: "string" } },
    ],
    answer: { schema: { type: "array", items: schemaRef("EntityHit"), maxItems: MAX_HITS }, description: "The hits, at most one per record." },
    codes: ["gui_bad_request", "gui_no_access", "gui_unauthenticated", "gui_unavailable"],
  },
  {
    method: "GET",
    path: "/api/gui/signals",
    summary: "What needs someone in one of the person's organizations",
    description:
      "What the contributed watchers report, each only while its plugin is enabled and within its own time budget. `checked` and `unchecked` say which watchers answered, so nothing reported can be told from nothing checked.",
    query: [
      { name: "org", required: false, description: "The organization to report on; one the person cannot see is ignored, and their first is used.", schema: { type: "string" } },
    ],
    answer: { schema: schemaRef("Signals"), description: "The signals." },
    codes: ["gui_no_access", "gui_output_invalid", "gui_unauthenticated", "gui_unavailable"],
  },
  {
    method: "GET",
    path: "/api/gui/view",
    summary: "One contributed view",
    description: [
      `The view a page's path names, as the page renders it, for the signed-in person. A tenant view takes \`${TENANT_UNIT_PARAM}=<tenant id>\` in that path's query when the person rents several units.`,
      ORG_HINT,
    ].join("\n\n"),
    query: [
      { name: "href", required: true, description: "The page's path on this site, with its own query.", schema: { type: "string" } },
    ],
    answer: { schema: schemaRef("ViewModel"), description: "The view's model." },
    codes: [
      "gui_bad_request",
      "gui_no_access",
      "gui_not_found",
      "gui_not_released",
      "gui_output_invalid",
      "gui_unauthenticated",
      "gui_unavailable",
      "gui_unit_required",
      "gui_view_failed",
      "gui_view_refused",
    ],
    // A view that calls an outside system is refused while its plugin is off
    // or its state cannot be read (dispatchView in ./view.ts); any other view
    // loads with a notice. A tenant view asks no gate, and an installation
    // view has no organization to ask it for. If dispatchView changes which
    // views the gate refuses, revisit these codes.
    *gate(surface) {
      for (const { plugin, def } of surface.views) {
        if (def.cost !== "vendor" || def.scope === "tenant" || def.scope === "installation" || !NON_CORE.has(plugin)) continue;
        yield [plugin, "disabled"] as const;
        yield [plugin, "unavailable"] as const;
      }
    },
  },
];

function hostOperation(route: HostRoute, surface: DescribedSurface, gated: GateList): [string, JsonObject] {
  const gates = [...(route.gate?.(surface) ?? [])];
  gated.push(...gates);
  const coded = [...route.codes.map(hostCode), ...gates.map(([plugin, refusal]) => gateCoded(plugin, refusal))];
  const isReleased = released(route.path);
  const operation: JsonObject = {
    operationId: operationId(route.method, route.path),
    tags: ["gui-host"],
    summary: route.summary,
    description: isReleased ? route.description : `${route.description}\n\n${NOT_RELEASED}`,
    ...(route.query ? { parameters: route.query.map((p) => ({ name: p.name, in: "query", ...p })) } : {}),
    ...(route.body ? { requestBody: { required: true, content: { "application/json": { schema: schemaRef(route.body) } } } } : {}),
    responses: responses(
      ["200", { description: route.answer.description, content: { "application/json": { schema: route.answer.schema } } }],
      refusalResponses(coded, schemaRef("HostFailureBody"), { partial: false }),
      { released: isReleased, routeSchema: schemaRef("HostFailureBody") },
    ),
    "x-mgm-released": isReleased,
  };
  return [route.method.toLowerCase(), operation];
}

// ── The actions' routes ─────────────────────────────────────────────────────

/**
 * The action routes, as `METHOD /path/[segment]`, that read an empty body
 * as `{}`, so a request to them may carry none. Every other action route
 * parses its body with parseJsonBody (gui-surface.test.ts, check 2), which
 * refuses an empty one, so its body is required. The billing period delete
 * reads nothing as a request for the name to type
 * (src/app/api/billing-periods/[periodId]/route.ts; its delete-route.test.ts
 * pins it). openapi.test.ts fails while this list and the action route
 * handlers that read an empty body disagree.
 */
export const EMPTY_BODY_ROUTES: ReadonlySet<string> = new Set(["DELETE /api/billing-periods/[periodId]"]);

/** The body of the actions sent to one route: the same for all of them, since the route parses one schema. */
function routeBody(actions: readonly RegisteredAction[]): JsonObject {
  const bodies = actions.map(({ def }) => {
    const { $schema: _dialect, ...body } = describeBody(def) as JsonObject;
    void _dialect;
    if (hasKey(body, "$ref") || hasKey(body, "$defs")) {
      throw new Error(`OpenAPI: action ${def.id}: its input refers to a part of itself, which the document cannot describe inline yet`);
    }
    return body;
  });
  const first = JSON.stringify(bodies[0]);
  if (bodies.some((b) => JSON.stringify(b) !== first)) {
    throw new Error(`OpenAPI: actions ${actions.map((a) => a.def.id).join(", ")} share a route but not an input`);
  }
  return bodies[0];
}

/** The path parameters of a route, each of the kind its actions bind it to. */
function pathParameters(pattern: string, actions: readonly RegisteredAction[]): JsonObject[] {
  return segments(pattern).map((name) => {
    const kinds = new Set(actions.map(({ def }) => def.bind.path?.[name]));
    const [kind] = kinds;
    if (kinds.size !== 1 || kind === undefined) {
      throw new Error(`OpenAPI: ${pattern}: the actions sent to it do not all bind [${name}] to one kind`);
    }
    return {
      name,
      in: "path",
      required: true,
      description: `The id of the ${kind} the action is sent for.`,
      schema: idSchema(kind),
      "x-mgm-entity-kind": kind,
    };
  });
}

/**
 * One action route's operation. A route of a plugin that is not core
 * refuses with the gate's codes unless its actions declare
 * `whilePluginOff: "enabled"`, which gui-surface.test.ts allows only on a
 * route that takes the action while the plugin is off and asks no gate.
 * Every action route parses its body with parseJsonBody (gui-surface.test.ts,
 * check 2), so every one answers invalid_body. If either check stops
 * holding, revisit the codes listed here; openapi.test.ts also holds the
 * gate's codes to UNGATED_WRITES.
 */
function actionOperation(method: string, pattern: string, group: readonly RegisteredAction[], gated: GateList): [string, JsonObject] {
  const actions = [...group].sort(byCatalogOrder);
  const plugins = new Set(actions.map((a) => a.plugin));
  if (plugins.size !== 1) throw new Error(`OpenAPI: ${method} ${pattern} takes actions of several plugins`);
  const [plugin] = plugins;
  const gates = NON_CORE.has(plugin) && actions.every(({ def }) => def.whilePluginOff !== "enabled");
  if (gates) gated.push([plugin, "disabled"], [plugin, "unavailable"]);
  const again = [...new Set(actions.flatMap(({ def }) => def.prepareAgainOn ?? []))].sort(byText);
  const coded: Coded[] = [
    BODY_REFUSAL,
    ...(gates ? [gateCoded(plugin, "disabled"), gateCoded(plugin, "unavailable")] : []),
    ...again.map((code) => ({
      code,
      status: [409],
      meaning: "The route's own: what the person confirmed changed after prepare. Prepare the action again and confirm the new step; the route never takes the old one.",
    })),
  ];
  const isReleased = released(pattern);
  const titles = actions.map(({ def }) => def.title);
  const refused = refusalResponses(coded, schemaRef("ActionRefusal"), { partial: true });
  refused.set(401, ROUTE_SESSION_CHECK);
  const operation: JsonObject = {
    operationId: operationId(method, pattern),
    tags: [plugin],
    summary: titles.join("; "),
    description: [
      `The route of ${actions.length === 1 ? "one action" : `${actions.length} actions`}, listed under \`x-mgm-actions\` as the action catalog (GET /api/gui/catalog) describes each. Prepare an action first (POST /api/gui/prepare): it answers the confirmation step its route checks.`,
      "The answer to a write is the route's own and is not described here yet. Nor are the route's own refusals: each response names the codes this document knows the route answers, and says with `x-mgm-codes-complete: false` that there may be others (ActionRefusal).",
      ...(isReleased ? [] : [NOT_RELEASED]),
    ].join("\n\n"),
    ...(segments(pattern).length > 0 ? { parameters: pathParameters(pattern, actions) } : {}),
    requestBody: EMPTY_BODY_ROUTES.has(`${method} ${pattern}`)
      ? { required: false, description: "The route reads an empty body as `{}`.", content: { "application/json": { schema: routeBody(actions) } } }
      : { required: true, content: { "application/json": { schema: routeBody(actions) } } },
    responses: responses(
      ["2XX", { description: "The route did the write." }],
      refused,
      {
        released: isReleased,
        routeSchema: schemaRef("ActionRefusal"),
        fallback: {
          description: "Any other refusal: the route's own, at a status not described above.",
          content: { "application/json": { schema: schemaRef("ActionRefusal") } },
        },
      },
    ),
    "x-mgm-released": isReleased,
    "x-mgm-actions": actions.map((a) => plain(describeAction(a))),
  };
  return [method.toLowerCase(), operation];
}

// ── The document ────────────────────────────────────────────────────────────

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

/**
 * What the document says of the API's stability. GUI_CONTRACT is semver,
 * and through 0.x a minor version may change shapes (../../contract.ts), so
 * the API is experimental. Leaving 0.x throws here, so that someone decides
 * what the document promises from then on.
 *
 * GUI_CONTRACT versions the contract's shapes only. Actions, their routes
 * and their codes come and go with MGM releases while it stays, and an
 * action's input carries its own `inputVersion` (ActionDef in
 * ../../surface.ts), so the text says so rather than letting `info.version`
 * stand for the whole document. If `info.version` comes to be the release's
 * version, or GUI_CONTRACT to change with every action, revisit it.
 */
function stability(): { label: string; text: string } {
  if (!GUI_CONTRACT.startsWith("0.")) {
    throw new Error(`OpenAPI: GUI_CONTRACT is ${GUI_CONTRACT}; decide what the document says of the API's stability after 0.x`);
  }
  return {
    label: "experimental",
    text: [
      `**Experimental while GUI_CONTRACT is 0.x.** \`info.version\` is GUI_CONTRACT, ${GUI_CONTRACT} here. It versions the shapes the GUI contract defines: what the host's routes take and answer, and how the catalog describes an action. Until 1.0 a minor version may change any of those shapes, and a patch only adds optional fields, kinds or values.`,
      "It does not version what the document lists. Actions, their routes and the codes they answer are added and changed from one MGM release to the next while GUI_CONTRACT stays the same, and an action's body is its own: each action gives the version of its input as `inputVersion`, under `x-mgm-actions`. Read the document of the MGM release you call.",
    ].join("\n\n"),
  };
}

/** The OpenAPI document of `surface`'s actions and the host's routes. */
export function openApiDocument(surface: DescribedSurface): OpenApiDocument {
  const stable = stability();
  const gated: GateList = [];
  const paths = new Map<string, Map<string, JsonObject>>();
  const add = (path: string, [method, operation]: [string, JsonObject]) => {
    const methods = paths.get(path) ?? new Map<string, JsonObject>();
    if (methods.has(method)) throw new Error(`OpenAPI: ${method.toUpperCase()} ${path} is described twice`);
    paths.set(path, methods.set(method, operation));
  };

  for (const route of HOST_ROUTES) add(route.path, hostOperation(route, surface, gated));
  const routes = new Map<string, RegisteredAction[]>();
  for (const action of surface.actions.values()) {
    const key = `${action.def.method} ${action.def.path}`;
    routes.set(key, [...(routes.get(key) ?? []), action]);
  }
  for (const group of routes.values()) {
    const { method, path } = group[0].def;
    add(templated(path), actionOperation(method, path, group, gated));
  }

  const operationIds = [...paths.values()].flatMap((methods) => [...methods.values()].map((o) => o.operationId as string));
  const repeated = operationIds.filter((id, i) => operationIds.indexOf(id) !== i);
  if (repeated.length > 0) throw new Error(`OpenAPI: operation ids repeat: ${repeated.join(", ")}`);

  const pluginTags = [...new Set([...routes.values()].map((group) => group[0].plugin))].sort(byText).map((name) => ({
    name,
    description: `The routes of the actions ${MGM_BUNDLED_PLUGINS.find((p) => p.name === name)?.displayName ?? name} contributes.`,
  }));

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "MGM described API",
      version: GUI_CONTRACT,
      summary: "The GUI host's routes, and the route of every action MGM's plugins describe.",
      description: [
        stable.text,
        "MGM's API is the routes it already has: the GUI host's routes under /api/gui/, which describe MGM and read it, and the route of each action a plugin contributes, the only way to write. Each operation needs a signed-in person, and acts with what that person may do in a browser.",
        "The GUI host's routes refuse with `{ error, code }` (HostFailureBody): read `code`, which is stable, and show `error`. An action's route answers the codes this document names for it in `code` too, but its own refusals were written before the described API and are not all alike (ActionRefusal says how to read them). Each operation names the codes its route is known to answer, in each response's `x-mgm-codes`, and `x-mgm-error-codes` lists them all with what each means. On an action's route that list is partial, and each response says so with `x-mgm-codes-complete: false`. Middleware answers two requests itself, before any route, and with no code: a request with no session (401, `{ error }`), and one to a path this release does not serve (404, plain text; such an operation says `x-mgm-released: false`).",
        "An action's route is listed with its actions under `x-mgm-actions`, as GET /api/gui/catalog describes them; the catalog also says which the person may send now. An action is prepared with POST /api/gui/prepare, then sent to its own route.",
        "Generated from MGM's action registry by `npm run api:openapi`; do not edit it by hand.",
      ].join("\n\n"),
      license: { name: "EPL-2.0", identifier: "EPL-2.0" },
      "x-mgm-stability": stable.label,
    },
    tags: [
      { name: "gui-host", description: "The GUI host's routes: they describe MGM to a client and read it, and write nothing." },
      ...pluginTags,
    ],
    paths: Object.fromEntries(
      [...paths.entries()]
        .sort(([a], [b]) => byText(a, b))
        .map(([path, methods]) => [
          path,
          Object.fromEntries([...methods.entries()].sort(([a], [b]) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b))),
        ]),
    ),
    components: {
      schemas: Object.fromEntries(
        Object.entries({ ...componentSchemas(), ...OWN_SCHEMAS }).sort(([a], [b]) => byText(a, b)),
      ),
      responses: {
        SessionRequired: {
          description: SESSION_REQUIRED,
          content: { "application/json": { schema: schemaRef("SessionRequired") } },
        },
      },
    },
    "x-mgm-error-codes": listedCodes(gated).map((c) => plain(c)),
  };
}

/** The document as the committed file holds it: two-space JSON and a final newline. */
export function renderOpenApi(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
