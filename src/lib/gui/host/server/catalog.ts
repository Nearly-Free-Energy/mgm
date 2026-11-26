import "server-only";

/**
 * The action catalog (RFC #259 § 3): every contributed action the signed-in
 * person may see in one organization, with the JSON Schema of its input and
 * whether it is available, and why not. GET /api/gui/catalog serves it;
 * buildActionCatalog takes a HostContext, so an in-process consumer (#133
 * A1) calls the same code.
 *
 * Every registered action is listed, in catalog order and then by id, as
 * the view merge appends them: both sort with byCatalogOrder
 * (../shared/merge-actions.ts). One whose plugin is off is listed
 * unavailable, with the gate's own code and copy, never left out. Given
 * entities (`entity=<kind>:<id>`), only the actions offered on one of their
 * kinds are listed, and each is asked its own available() about its entity.
 *
 * Each check (AvailabilityCheck in ../../contract.ts) is answered:
 * - installed: the route, filled from the entities or as a pattern, is
 *   released (releaseFailure in ./availability.ts). Prepare (./prepare.ts)
 *   decides the same question with isReleasedRoute but answers it 404
 *   gui_not_found, so for one unreleased action the catalog says
 *   gui_not_released and prepare gui_not_found; if prepare comes to call
 *   releaseFailure, the two agree;
 * - enabled and healthy: the plugin gate, asked as a write, as the action's
 *   route asks it, through gateRefusal, as prepare answers them;
 * - state: the action's available(), within the view merge's budget
 *   (askAvailability in ./merge.ts); one that is late, throws or answers
 *   nothing usable fails healthy instead, as gui_availability_unchecked.
 * A check that is not decided is listed in `unchecked`, never as passed.
 *
 * Reads only, on clients of the caller's own session, and never runs an
 * action's prepare or calls its route.
 */
import { rolesIncludeStaff } from "@/lib/auth/access";
import { CORE_ENTITY_KINDS } from "@/lib/plugins/bundled";
import { UUID_RE } from "@/lib/plugins/state";
import {
  GUI_CONTRACT,
  type ActionCatalog,
  type AvailabilityCheck,
  type CatalogAvailability,
  type CatalogEntry,
  type EntityKind,
  type Id,
} from "../../contract";
import { byCatalogOrder, fillPath, idFits } from "../shared/merge-actions";
import { tenantUnitIds } from "../shared/tenant-units";
import { requireIssued, surfaceRequest, type HostContext } from "./access";
import { AGENT_REFUSED, assistantGate, isAgentCaller } from "./agent";
import { gateRefusal, releaseFailure } from "./availability";
import { resolveSegments } from "./entities";
import { pluginGate } from "./gate-state";
import { describeInput } from "./input-spec";
import { UNCHECKED_REASON, askAvailability, targetId } from "./merge";
import { actionCatalogSchema, entityKindSchema } from "./model-schema";
import { selectOrganization } from "./organization";
import { parseOrFail } from "./parse";
import { surfaceSnapshot } from "./snapshot";
import type { RegisteredAction } from "./surface-registry";
import type { HostFailure, HostOutcome } from "./view";

/** The most entities one catalog request may name, each of another kind. */
export const MAX_CATALOG_ENTITIES = 4;

export type CatalogQuery = {
  /** The organization to answer for, which the person must see; otherwise `preferred`, else their first. */
  org?: string | null;
  /** The organization the person last used (the org cookie): a hint only. */
  preferred?: string | null;
  /** The entities to ask about, each of another kind. Not together with `org`. */
  entities?: readonly { kind: EntityKind; id: string }[];
};

type Reason = CatalogAvailability["reasons"][number];

const fail = (status: number, code: string, message: string): HostFailure => ({ ok: false, status, code, message });
const BAD_REQUEST = fail(
  400,
  "gui_bad_request",
  "The catalog takes org, or up to four entity=<kind>:<id>, each of another kind, and nothing else.",
);
const NOT_FOUND = fail(404, "gui_not_found", "This could not be found.");
const UNAVAILABLE = fail(503, "gui_unavailable", "The actions could not be listed right now.");
const NO_ACCESS = fail(403, "gui_no_access", "Your account has no organization yet.");
const OUTPUT_INVALID = fail(500, "gui_output_invalid", "The actions could not be listed.");

/** Every check, in the order an entry lists the ones not decided. */
const CHECKS: readonly AvailabilityCheck[] = ["installed", "enabled", "configured", "healthy", "authorized", "state"];

const isCore = (kind: EntityKind) => (CORE_ENTITY_KINDS as readonly string[]).includes(kind);

/** The query with a core kind's id and the organization lowercased, or null when it breaks a rule. */
function checkedQuery(q: CatalogQuery): Required<CatalogQuery> | null {
  const org = q.org ?? null;
  const entities = q.entities ?? [];
  if (org !== null && !UUID_RE.test(org)) return null;
  if (org !== null && entities.length > 0) return null;
  if (entities.length > MAX_CATALOG_ENTITIES || new Set(entities.map((e) => e.kind)).size !== entities.length) return null;
  if (!entities.every((e) => entityKindSchema.safeParse(e.kind).success && idFits(e.kind, e.id))) return null;
  return {
    org: org?.toLowerCase() ?? null,
    preferred: q.preferred ?? null,
    entities: entities.map((e) => ({ kind: e.kind, id: isCore(e.kind) ? e.id.toLowerCase() : e.id })),
  };
}

/**
 * The catalog's query from a request's search parameters: `org` once, or
 * `entity=<kind>:<id>` up to MAX_CATALOG_ENTITIES times, each of another
 * kind. Any other key, a repeated `org`, or `org` with `entity` is a 400, so
 * a mistyped parameter fails rather than answering for something else.
 */
export function readCatalogQuery(search: URLSearchParams, preferred: string | null): HostOutcome<CatalogQuery> {
  const orgs = search.getAll("org");
  const entities: { kind: EntityKind; id: string }[] = [];
  for (const [key, value] of search) {
    if (key === "org") continue;
    if (key !== "entity") return BAD_REQUEST;
    const at = value.indexOf(":");
    const kind = entityKindSchema.safeParse(value.slice(0, at));
    if (at < 0 || !kind.success) return BAD_REQUEST;
    entities.push({ kind: kind.data, id: value.slice(at + 1) });
  }
  if (orgs.length > 1) return BAD_REQUEST;
  const query = checkedQuery({ org: orgs[0] ?? null, preferred, entities });
  return query ? { ok: true, value: query } : BAD_REQUEST;
}

/** The answer for a person who reaches no organization: no actions, with nothing read. */
const none = (): HostOutcome<ActionCatalog> => ({
  ok: true,
  value: { type: "catalog", contract: GUI_CONTRACT, org: null, entities: [], actions: [] },
});

type Draft = {
  registered: RegisteredAction;
  params?: Record<string, string>;
  reasons: Reason[];
  unchecked: Set<AvailabilityCheck>;
  /** The id available() is asked about, when every earlier check passed. */
  ask?: string;
};

/**
 * One action's checks before available(): the release and the gate.
 *
 * `configured` and `authorized` are never decided. No field of contract 0.x
 * says what an action needs set up; if one is added, decide configured from
 * it. Organization access, settled for the whole answer, is the only role
 * check the host can make: no per-action role exists in contract v0
 * (./merge.ts), and a route may check its own, as the payment-status route
 * refuses failed and refunded to anyone but a super admin. If actions come
 * to declare roles, decide authorized from them.
 */
async function draftOf(
  registered: RegisteredAction,
  byKind: ReadonlyMap<EntityKind, string>,
  gate: ReturnType<typeof pluginGate>,
): Promise<Draft> {
  const { plugin, def } = registered;
  const binds = [...Object.entries(def.bind.path ?? {}), ...Object.entries(def.bind.body ?? {})];
  const complete = byKind.size > 0 && binds.every(([, kind]) => byKind.has(kind));
  const params = complete ? Object.fromEntries(binds.map(([name, kind]) => [name, byKind.get(kind)!])) : undefined;
  const reasons: Reason[] = [];
  const unchecked = new Set<AvailabilityCheck>(["configured", "authorized"]);

  // "0" for a segment not given: every released API pattern takes any id
  // there ([^/]+ in src/lib/mgm/released-routes.ts). If one comes to check
  // an id's shape, fill each segment with an id of its kind instead.
  const path = (params && fillPath(def.path, params)) ?? def.path.replace(/\[[^\]]+\]/g, "0");
  const unreleased = releaseFailure(path);
  if (unreleased) reasons.push({ check: unreleased.check, code: unreleased.code, message: unreleased.message });
  const refused = gateRefusal(await gate(plugin).catch(() => null), def, plugin);
  if (refused) {
    reasons.push({ check: refused.check, code: refused.code, message: refused.message });
    // A gate that could not be read did not say whether the plugin is on.
    if (refused.check === "healthy") unchecked.add("enabled");
  }

  const id = params && targetId(def, params);
  if (!def.available || id === undefined || reasons.length > 0) unchecked.add("state");
  return { registered, params, reasons, unchecked, ...(unchecked.has("state") ? {} : { ask: id }) };
}

/** The entry of one action, or null when its input cannot be described (a host bug: the contribution check refuses such an input). */
function entryOf({ registered: { plugin, def }, params, reasons, unchecked }: Draft): CatalogEntry | null {
  let input: CatalogEntry["input"];
  try {
    input = describeInput(def);
  } catch {
    console.error(`[gui] catalog: action ${def.id}: input has no JSON Schema form`);
    return null;
  }
  return {
    id: def.id,
    title: def.title,
    plugin,
    target: def.target,
    method: def.method,
    path: def.path,
    bind: { path: { ...(def.bind.path ?? {}) }, body: { ...(def.bind.body ?? {}) } },
    ...(params ? { params } : {}),
    input,
    inputVersion: def.inputVersion,
    risk: def.risk,
    confirm: def.confirm,
    humanOnly: def.humanOnly,
    targeted: def.targeted !== false,
    prepareAgainOn: [...(def.prepareAgainOn ?? [])],
    repeat: def.repeat,
    availability: {
      available: reasons.length === 0,
      reasons,
      unchecked: CHECKS.filter((check) => unchecked.has(check)),
    },
  };
}

/**
 * The actions `ctx`'s person may see, in the organization the query
 * selects, with each one's availability.
 *
 * Without entities, `org` must name an organization the person sees (a 404
 * otherwise); with none, the last used one, else their first, is chosen.
 * With entities, they decide the organization and must all be in one the
 * person sees (resolveSegments in ./entities.ts), or the answer is a 404
 * that does not tell whether a record exists.
 *
 * Every action is a staff route: the host offers a tenant view none
 * (dispatchTenantView in ./view.ts). So a person whose rows are all tenant
 * rows, or one who reaches no organization but holds a unit, as the
 * manifest gives them the tenant manifest (./manifest.ts), gets no actions,
 * with nothing read; the gate is never asked for them (pluginGate throws for
 * them). If an action is ever contributed for a tenant, list it here under
 * the unit's gate (unitPluginGate in ./gate-state.ts).
 *
 * The entities asked about are echoed by kind and id, never by label, and
 * each reason is the host's or the action's own copy.
 *
 * An agent client (RFC #259 § 2) gets the organization's catalog only: any
 * `entity=` is refused (403 `gui_agent_refused`) before anything is read,
 * so it is never told about a tenant, a bill, a payment, a tenant's access
 * or a person (`org.user`) by id, which #133's A0 data boundary keeps from
 * any model, whatever plugin kinds are added later. Without entities no
 * action's available() is asked (draftOf asks it only with every bound
 * field given), so none of their copy reaches it either. Once the
 * organization is resolved and checked, and before any action's gate or
 * available() is asked, the assistant plugin's gate is asked for the
 * organization (assistantGate in ./agent.ts). A person whose rows are all
 * tenant rows gets a 404 rather than an empty catalog: tenant agent clients
 * are #259 § 5's to design.
 *
 * The assistant read interface (./assistant-read.ts) does not serve the
 * catalog: it serves marked and listed views and watchers only, because
 * ADR-007 decision 6 admits only what those emit, and a reason here is an
 * action's own copy, which a refused plugin's available() writes. If it is
 * to serve the catalog, decision 6 is read for it first, and refused
 * plugins' reasons become codes.
 */
export async function buildActionCatalog(ctx: HostContext, input: CatalogQuery): Promise<HostOutcome<ActionCatalog>> {
  requireIssued(ctx);
  const query = checkedQuery(input);
  if (!query) return BAD_REQUEST;
  const { org, entities } = query;
  const agent = isAgentCaller(ctx);
  if (agent && entities.length > 0) return AGENT_REFUSED;
  if (!rolesIncludeStaff(ctx.access.roles)) return org !== null || entities.length > 0 || agent ? NOT_FOUND : none();

  const snapshot = await surfaceSnapshot();
  let organizationId: string | null;
  if (entities.length > 0) {
    const segments = entities.map((e) => ({ name: e.kind, kind: e.kind, id: e.id }));
    const resolved = await resolveSegments(ctx, snapshot, segments);
    if (!resolved.ok) return resolved.status === 404 ? NOT_FOUND : UNAVAILABLE;
    organizationId = resolved.organizationId;
    if (organizationId === null) return NOT_FOUND;
  } else {
    try {
      organizationId = (await selectOrganization(ctx, { requested: org, preferred: query.preferred })).organizationId;
    } catch {
      return UNAVAILABLE;
    }
    if (org !== null && organizationId !== org) return NOT_FOUND;
    if (organizationId === null) return tenantUnitIds(ctx.access.roles).length > 0 && !agent ? none() : NO_ACCESS;
  }
  const orgId = organizationId;
  if (agent) {
    const refused = await assistantGate(ctx, orgId);
    if (refused) return refused;
  }

  const byKind = new Map(entities.map((e) => [e.kind, e.id]));
  const gate = pluginGate(ctx, orgId);
  const listed = [...snapshot.actions.values()]
    .filter(({ def }) => byKind.size === 0 || byKind.has(def.target))
    .sort(byCatalogOrder);
  const drafts = await Promise.all(listed.map((registered) => draftOf(registered, byKind, gate)));

  const targets = new Map<Id, Set<string>>();
  for (const d of drafts) if (d.ask !== undefined) targets.set(d.registered.def.id, new Set([d.ask]));
  const answers = await askAvailability(snapshot.actions, targets, () =>
    surfaceRequest(ctx, orgId, {}, new URLSearchParams()),
  );
  for (const d of drafts) {
    if (d.ask === undefined) continue;
    const answer = answers.get(d.registered.def.id)?.get(d.ask);
    if (answer?.kind === "ok") continue;
    if (answer?.kind === "refused") {
      d.reasons.push({ check: "state", code: "gui_action_unavailable", message: answer.reason });
    } else {
      d.reasons.push({ check: "healthy", code: "gui_availability_unchecked", message: UNCHECKED_REASON });
      d.unchecked.add("state");
    }
  }

  const actions = drafts.map(entryOf);
  if (actions.includes(null)) return OUTPUT_INVALID;
  const out = { type: "catalog", contract: GUI_CONTRACT, org: orgId, entities, actions };
  const parsed = parseOrFail(actionCatalogSchema, out, "catalog");
  return parsed.ok ? { ok: true, value: parsed.value } : OUTPUT_INVALID;
}
