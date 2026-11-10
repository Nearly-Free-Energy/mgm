import "server-only";

/**
 * Prepares one contributed action for the signed-in person, before any form
 * or confirmation is shown: the action is found in the snapshot, its bound
 * entities are resolved to one organization the person can see
 * (./entities.ts), its plugin is checked with the plugin gate
 * (./gate-state.ts), and its own available() is asked. The answer is what
 * the kit needs to run the form, the host-owned confirmation step and the
 * write: the JSON Schema of the fields a person enters, a cleaned prefill,
 * the confirmation (from the action's prepare, strictly parsed) and the route
 * and method the write goes to.
 *
 * Preparing writes nothing and never calls the action's route. The write is
 * sent later to that route, which runs its own gate and checks.
 */
import { z } from "zod";
import { CORE_ENTITY_KINDS } from "@/lib/plugins/bundled";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { ActionRef, Ceremony, EntityKind, Json } from "../../contract";
import type { ActionDef, Loaded } from "../../surface";
import { fillPath, idFits } from "../shared/merge-actions";
import { requireIssued, surfaceRequest, type HostContext } from "./access";
import { resolveSegments, type Segment } from "./entities";
import { pluginGate } from "./gate-state";
import { checkAvailability, cleanPrefill } from "./merge";
import { actionSpecSchema, ceremonySchema, confirmSchema, idSchema, jsonSchema, provenanceSchema } from "./model-schema";
import { parseOrFail } from "./parse";
import { surfaceSnapshot } from "./snapshot";
import type { HostFailure, HostOutcome } from "./view";

/** The largest prepare request body, in bytes. */
export const MAX_PREPARE_BYTES = 16 * 1024;
const MAX_MESSAGE = 300;
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 500, 503]);
/** The same rule the kit's invoke applies to a prepared path: an API route with no ".." segment. */
const API_PATH = /^\/api\/[A-Za-z0-9/_.%-]+$/;
const isApiPath = (path: string) => API_PATH.test(path) && !path.split("/").includes("..");

const fail = (status: number, code: string, message: string): HostFailure => ({ ok: false, status, code, message });
const BAD_REQUEST = fail(400, "gui_bad_request", "The request is not valid.");
const TOO_LARGE = fail(413, "gui_body_too_large", "The request is too large.");
const NOT_FOUND = fail(404, "gui_not_found", "This action could not be found.");
const UNAVAILABLE = fail(503, "gui_unavailable", "This action could not be prepared right now.");
const OUTPUT_INVALID = fail(500, "gui_output_invalid", "This action could not be prepared.");
const PREPARE_FAILED = fail(500, "gui_prepare_failed", "This action could not be prepared.");
const HUMAN_ONLY = fail(403, "gui_human_only", "Only a person can start this action.");

/** The prepare request. Unknown keys are refused (decision 18 on #115). */
export const prepareBodySchema = z.strictObject({
  action: idSchema,
  /** The ActionRef's params: every bound field, each an id of its kind. */
  params: z.record(z.string().max(64), z.string().max(128)),
  /** Values to start the form with; parsed against the input and cleaned like a loader's prefill. */
  body: jsonSchema.optional(),
  /** The ActionRef's provenance, as the ref carries it: set when the action was proposed rather than started by the person. */
  provenance: provenanceSchema.optional(),
});

/** What prepare answers. Host-internal: a GUI sees only `spec`, through FormProps. */
export const preparedActionSchema = z.strictObject({
  type: z.literal("prepared"),
  spec: actionSpecSchema,
  /** The level the host runs: the action's own, and at least "confirm" for a proposal. */
  confirm: confirmSchema,
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().refine(isApiPath, "Expected an API route with no .. segment"),
  /** Body fields filled from the entity; the kit sends them over the form's values. */
  bound: z.record(z.string(), z.string()),
  ceremony: ceremonySchema.nullable(),
  prefill: jsonSchema.optional(),
});
export type PreparedAction = z.output<typeof preparedActionSchema>;

const isCore = (kind: EntityKind) => (CORE_ENTITY_KINDS as readonly string[]).includes(kind);

/**
 * The request body as JSON, read up to MAX_PREPARE_BYTES. A larger body is a
 * 413 and is not read further; a body that is not JSON is a 400.
 */
export async function readPrepareBody(request: Request): Promise<{ ok: true; value: unknown } | HostFailure> {
  if (Number(request.headers.get("content-length")) > MAX_PREPARE_BYTES) return TOO_LARGE;
  if (!request.body) return BAD_REQUEST;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PREPARE_BYTES) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) };
  } catch {
    return BAD_REQUEST;
  }
}

/**
 * The JSON Schema of the fields a person enters: the input's, with bound
 * fields and `confirmation` (sent by the host's confirmation step) removed.
 * writeOnly marks stay, so a form never prefills or shows a secret.
 */
function inputSpec(def: ActionDef, bound: readonly string[]): Json {
  // Through JSON, so only JSON is kept: zod adds a non-enumerable "~standard" property.
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(def.input, { io: "input" }))) as Record<string, unknown>;
  const hidden = new Set([...bound, "confirmation"]);
  if (schema.properties !== null && typeof schema.properties === "object") {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).filter(([k]) => !hidden.has(k)));
  }
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((k) => !hidden.has(k as string));
  return schema as Json;
}

/** The action's confirmation, from its own prepare, or a refusal. */
async function ceremonyOf(
  def: ActionDef,
  run: () => Promise<Loaded<Ceremony>>,
): Promise<{ ok: true; value: Ceremony | null } | HostFailure> {
  const needs = def.confirm === "typed" || def.confirm === "ceremony";
  // The contribution check refuses a typed or ceremony action without prepare.
  if (!def.prepare) return needs ? OUTPUT_INVALID : { ok: true, value: null };
  let out: Loaded<Ceremony>;
  try {
    out = await run();
  } catch {
    console.error(`[gui] action ${def.id}: prepare failed`);
    return PREPARE_FAILED;
  }
  if (out === null || typeof out !== "object") return OUTPUT_INVALID;
  if (out.ok === false) {
    if (!REFUSAL_STATUSES.has(out.status) || typeof out.message !== "string") return OUTPUT_INVALID;
    return fail(out.status, out.status === 404 ? "gui_not_found" : "gui_action_refused", out.message.slice(0, MAX_MESSAGE));
  }
  if (out.ok !== true) return OUTPUT_INVALID;
  const ceremony = parseOrFail(ceremonySchema, out.model, `action ${def.id} ceremony`);
  if (!ceremony.ok) return OUTPUT_INVALID;
  if (def.confirm === "typed" && ceremony.value.typed === undefined) {
    console.error(`[gui] action ${def.id}: a typed action's ceremony has no typed name`);
    return OUTPUT_INVALID;
  }
  return { ok: true, value: ceremony.value };
}

/**
 * Prepares the action `input` names, with its params, for `ctx`'s person.
 * Writes nothing and never calls the action's route.
 */
export async function prepareAction(ctx: HostContext, input: unknown): Promise<HostOutcome<PreparedAction>> {
  requireIssued(ctx);
  const request = prepareBodySchema.safeParse(input);
  if (!request.success) return BAD_REQUEST;
  const { action } = request.data;
  const proposed = request.data.provenance !== undefined;

  const snapshot = await surfaceSnapshot();
  const registered = snapshot.actions.get(action);
  if (!registered) return NOT_FOUND;
  const { plugin, def } = registered;
  if (proposed && def.humanOnly) return HUMAN_ONLY;

  // Every bound field, and nothing else, each an id of its kind.
  const binds = [...Object.entries(def.bind.path ?? {}), ...Object.entries(def.bind.body ?? {})];
  const given = request.data.params;
  if (Object.keys(given).length !== binds.length) return BAD_REQUEST;
  const segments: Segment[] = [];
  for (const [name, kind] of binds) {
    const id = Object.hasOwn(given, name) ? given[name] : undefined;
    if (id === undefined || !idFits(kind, id)) return BAD_REQUEST;
    segments.push({ name, kind, id: isCore(kind) ? id.toLowerCase() : id });
  }
  const params = Object.fromEntries(segments.map((s) => [s.name, s.id]));
  const bound = Object.fromEntries(Object.keys(def.bind.body ?? {}).map((name) => [name, params[name]]));

  const path = fillPath(def.path, params);
  if (path === null || !isApiPath(path) || !isReleasedRoute(path)) return NOT_FOUND;

  // The starting values, cleaned as a loader's prefill is. Bound fields come
  // from params and `confirmation` from the confirmation step, so both are
  // dropped first; whatever else the input refuses is a 400.
  let prefill: Json | undefined;
  const body = request.data.body;
  if (body !== undefined) {
    const hidden = new Set([...binds.map(([name]) => name), "confirmation"]);
    const values =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? Object.fromEntries(Object.entries(body).filter(([k]) => !hidden.has(k)))
        : body;
    prefill = cleanPrefill(def, values);
    if (prefill === undefined) return BAD_REQUEST;
  }

  // The bound entities decide the organization. An action with none has no
  // organization to check its plugin and roles against, so it is not offered.
  const resolved = await resolveSegments(ctx, snapshot, segments);
  if (!resolved.ok) return resolved.status === 404 ? NOT_FOUND : UNAVAILABLE;
  const organizationId = resolved.organizationId;
  if (organizationId === null) return NOT_FOUND;

  // The gate asked as a write, as the action's route will ask it.
  const decision = await pluginGate(ctx, organizationId)(plugin).catch(() => null);
  if (decision === null) {
    return fail(503, `${plugin}_gate_unavailable`, "Could not check whether this part of MGM is enabled.");
  }
  if (!decision.ok) return fail(decision.status, decision.code, decision.message);

  const ref: ActionRef = { action, params, label: def.title, enabled: true };
  const [checked] = (
    await checkAvailability(
      { kind: "record", body: { sections: [] }, actions: [ref] },
      { actions: snapshot.actions, request: () => surfaceRequest(ctx, organizationId, {}, new URLSearchParams()) },
    )
  ).actions;
  if (!checked.enabled) return fail(409, "gui_action_unavailable", checked.reason ?? "This action is not available.");

  let spec: Json;
  try {
    spec = inputSpec(def, binds.map(([name]) => name));
  } catch {
    // The contribution check refuses an input with no JSON Schema form.
    console.error(`[gui] action ${def.id}: input has no JSON Schema form`);
    return OUTPUT_INVALID;
  }

  // The action's prepare gets the cleaned values: never a writeOnly field.
  const ceremony = await ceremonyOf(def, async () =>
    def.prepare!(await surfaceRequest(ctx, organizationId, params, new URLSearchParams()), {
      params: { ...params },
      body: structuredClone(prefill ?? {}),
    }),
  );
  if (!ceremony.ok) return ceremony;

  const out = {
    type: "prepared",
    spec: { type: "spec", id: def.id, title: def.title, confirm: def.confirm, inputVersion: def.inputVersion, input: spec },
    // The host owns every confirmation step (decision 5 on #115). A proposal
    // is not the person's own gesture, so this host gives it at least a
    // confirm step; a stronger level stays as it is.
    confirm: proposed && def.confirm === "none" ? "confirm" : def.confirm,
    method: def.method,
    path,
    bound,
    ceremony: ceremony.value,
    ...(prefill === undefined ? {} : { prefill }),
  };
  const parsed = parseOrFail(preparedActionSchema, out, `action ${def.id}`);
  return parsed.ok ? { ok: true, value: parsed.value } : OUTPUT_INVALID;
}
