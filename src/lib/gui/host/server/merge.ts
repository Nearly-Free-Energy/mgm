import "server-only";

/**
 * Resolves the actions in a loader's model into what a GUI receives: the
 * view's own ActionLinks become ActionRefs, other plugins' targeted actions
 * are appended (../shared/merge-actions.ts), and each action's `available()`
 * is asked within one shared time budget. It is asked only of an action
 * still enabled, which includes one declaring `whilePluginOff: "enabled"`
 * while its plugin is off.
 *
 * Takes the snapshot's actions as an argument and never names the registry,
 * so it stays unprivileged. Organization access, already settled when the
 * view's path was resolved, is the role check for both shipped roles: no
 * per-action role exists in contract v0. If a role with narrower rights
 * ships, revisit.
 */
import { z } from "zod";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { ActionRef, EntityKind, Id, Json, ViewKind } from "../../contract";
import type { ActionDef, ActionLink, LoadedModel, SurfaceRequest } from "../../surface";
import {
  actionRef,
  appendTargetedActions,
  idFits,
  mapActionSlots,
  type ActionSlots,
  type Dropped,
  type GateState,
  type MergeInput,
} from "../shared/merge-actions";
import { surfaceRequest, type HostContext } from "./access";
import type { Scope } from "./entities";
import type { PluginGate } from "./gate-state";
import type { RegisteredAction, RegisteredView } from "./surface-registry";

/** The time every available() call of one response shares. */
export const AVAILABILITY_BUDGET_MS = 1_000;
export const UNCHECKED_REASON = "Could not check right now";
const MAX_REASON = 300;

export type MergeContext = {
  view: RegisteredView;
  actions: ReadonlyMap<Id, RegisteredAction>;
  scope: Scope;
  ctx: HostContext;
} & (
  | { organizationId: string; gate: PluginGate }
  /**
   * An installation-wide view has no organization whose plugin state could
   * be read: every action then shows enabled, and available() is not asked.
   * The action's route still runs the gate when invoked, which
   * route-surface.test.ts requires of every write route; if that changes,
   * revisit.
   */
  | { organizationId: null; gate: null }
);

export type ResolvedModel<K extends ViewKind> = Omit<LoadedModel<K>, "body" | "actions"> &
  Extract<ActionSlots<ActionRef>, { kind: K }>;

const bindings = (def: Pick<ActionDef, "bind">): [string, EntityKind][] => [
  ...Object.entries(def.bind.path ?? {}),
  ...Object.entries(def.bind.body ?? {}),
];

/** A loader's params name exactly the action's bound fields, each an id of its kind. */
function paramsFit(def: ActionDef, params: Record<string, string>): boolean {
  const bound = bindings(def);
  if (Object.keys(params).length !== bound.length) return false;
  return bound.every(([name, kind]) => {
    const id = Object.hasOwn(params, name) ? params[name] : undefined;
    return id !== undefined && idFits(kind, id);
  });
}

type Node = Record<string, unknown>;
/**
 * Whether writeOnly appears anywhere in a JSON Schema node: under anyOf,
 * nested properties, items, or a $ref into the same document's $defs. A $ref
 * that cannot be followed counts as writeOnly.
 */
function mentionsWriteOnly(node: unknown, root: Node, seen: Set<string>): boolean {
  if (Array.isArray(node)) return node.some((n) => mentionsWriteOnly(n, root, seen));
  if (node === null || typeof node !== "object") return false;
  const o = node as Node;
  if (o.writeOnly === true) return true;
  if (typeof o.$ref === "string" && !seen.has(o.$ref)) {
    seen.add(o.$ref);
    const defs = (root.$defs ?? {}) as Node;
    const name = o.$ref.startsWith("#/$defs/") ? o.$ref.slice("#/$defs/".length) : undefined;
    const target = o.$ref === "#" ? root : name !== undefined && Object.hasOwn(defs, name) ? defs[name] : undefined;
    if (target === undefined || mentionsWriteOnly(target, root, seen)) return true;
  }
  return Object.entries(o).some(([k, v]) => k !== "$defs" && mentionsWriteOnly(v, root, seen));
}

/** The input's top-level keys with writeOnly anywhere inside, or null when the schema has no JSON Schema form. */
const writeOnlyCache = new WeakMap<z.ZodType, ReadonlySet<string> | null>();
function writeOnlyKeys(input: z.ZodType): ReadonlySet<string> | null {
  if (writeOnlyCache.has(input)) return writeOnlyCache.get(input)!;
  let keys: ReadonlySet<string> | null;
  try {
    const root = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as Node;
    const props = (root.properties ?? {}) as Node;
    keys = new Set(Object.keys(props).filter((k) => mentionsWriteOnly(props[k], root, new Set())));
  } catch {
    keys = null;
  }
  writeOnlyCache.set(input, keys);
  return keys;
}

/**
 * The input's own fields: the same field schemas and the same rule for
 * undeclared keys (strict, loose or stripped), without the object-level
 * refinements. A refinement reads a whole body, such as "start on or before
 * end", so it cannot judge starting values a person is still to edit, and
 * zod's .omit() and .partial() refuse an object that has one. The action's
 * route parses the submitted body with the whole input, refinements included.
 */
function fieldsOnly(input: z.ZodObject): z.ZodObject {
  if (!input.def.checks?.length) return input;
  const fields = z.object(input.shape);
  return input.def.catchall ? fields.catchall(input.def.catchall) : fields;
}

/**
 * A loader's prefill, checked field by field against the action's input
 * (its fields only, without object-level refinements: fieldsOnly above),
 * with bound fields and `confirmation` (host-managed) left out, and with
 * writeOnly fields removed. Undefined when it does not parse or its
 * writeOnly fields cannot be found.
 */
export function cleanPrefill(def: ActionDef, prefill: Json): Json | undefined {
  if (!(def.input instanceof z.ZodObject) || prefill === null || typeof prefill !== "object" || Array.isArray(prefill))
    return undefined;
  const shape = def.input.shape as Record<string, z.ZodType>;
  const omitted = new Set([...Object.keys(def.bind.body ?? {}), "confirmation"].filter((k) => Object.hasOwn(shape, k)));
  let parsed: Record<string, unknown> | undefined;
  try {
    const fields = fieldsOnly(def.input);
    type Mask = Parameters<typeof fields.omit>[0];
    const mask = Object.fromEntries([...omitted].map((k) => [k, true as const])) as Mask;
    const r = fields.omit(mask).partial().safeParse(prefill);
    if (r.success) parsed = r.data as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  const writeOnly = parsed ? writeOnlyKeys(def.input) : null;
  if (!parsed || !writeOnly) return undefined;
  // Built from the parsed value, not the loader's object: parsing strips keys
  // the input does not declare at every depth, so a nested undeclared key
  // never reaches the browser.
  return Object.fromEntries(
    Object.entries(parsed).filter(([k]) => Object.hasOwn(shape, k) && !omitted.has(k) && !writeOnly.has(k)),
  ) as Json;
}

/** The view's own ActionLinks as ActionRefs, then other plugins' targeted actions appended. */
export function resolveOwnAndTargeted(
  model: ActionSlots<ActionLink>,
  input: MergeInput,
  actions: ReadonlyMap<Id, RegisteredAction>,
): { model: ActionSlots<ActionRef>; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const own = mapActionSlots(model, (link: ActionLink): ActionRef | null => {
    const registered = actions.get(link.action);
    if (!registered || !paramsFit(registered.def, link.params)) {
      dropped.push({ action: link.action, reason: registered ? "params" : "unknown" });
      return null;
    }
    const made = actionRef(registered, link.params, input, link.label);
    if (!made.ok) {
      dropped.push({ action: link.action, reason: made.reason });
      return null;
    }
    const ref = made.ref;
    if (link.provenance) ref.provenance = { ...link.provenance };
    if (link.prefill !== undefined) {
      const prefill = cleanPrefill(registered.def, link.prefill);
      if (prefill === undefined) dropped.push({ action: link.action, reason: "prefill" });
      else ref.prefill = prefill;
    }
    return ref;
  });
  const merged = appendTargetedActions(own, input);
  return { model: merged.model, dropped: [...dropped, ...merged.dropped] };
}

/** The id `available()` is asked about: the bound field of the action's target kind. */
export function targetId(def: Pick<ActionDef, "bind" | "target">, params: Record<string, string>): string | undefined {
  const name = bindings(def).find(([, kind]) => kind === def.target)?.[0];
  return name === undefined ? undefined : params[name];
}

/**
 * What available() answered about one id: available, the reason it is not
 * (as given, cut to 300 characters), or not checked, because the call
 * missed the budget, threw, answered malformed, left the id out or gave a
 * blank reason. A tagged value, so no reason a contribution writes
 * can be read as "not checked".
 */
export type AvailabilityAnswer = { kind: "ok" } | { kind: "refused"; reason: string } | { kind: "unchecked" };

/**
 * Asks each action in `targets` its available() once, with every id listed
 * for it, each call on its own request and client from `request`. All calls
 * share one budget. An answer per action and id; nothing of an error is
 * kept, and a call that is not checked is logged by action id only.
 */
export async function askAvailability(
  actions: ReadonlyMap<Id, RegisteredAction>,
  targets: ReadonlyMap<Id, ReadonlySet<string>>,
  request: () => Promise<SurfaceRequest>,
  budgetMs = AVAILABILITY_BUDGET_MS,
): Promise<Map<Id, Map<string, AvailabilityAnswer>>> {
  const out = new Map<Id, Map<string, AvailabilityAnswer>>();
  if (targets.size === 0) return out;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  await Promise.all(
    [...targets].map(async ([action, ids]) => {
      const available = actions.get(action)?.def.available;
      if (!available) return;
      const call = (async () => available(await request(), [...ids]))().then(
        (answer) => (answer !== null && typeof answer === "object" ? answer : "malformed"),
        () => "threw" as const,
      );
      const answer: Record<string, unknown> | string = await Promise.race([call, expired]);
      if (typeof answer === "string") console.warn(`[gui] ${action}: availability not checked (${answer})`);
      const each = new Map<string, AvailabilityAnswer>();
      for (const id of ids) {
        const one = typeof answer === "string" || !Object.hasOwn(answer, id) ? undefined : answer[id];
        if (one === true) each.set(id, { kind: "ok" });
        else if (typeof one === "string" && one.trim()) each.set(id, { kind: "refused", reason: one.slice(0, MAX_REASON) });
        else each.set(id, { kind: "unchecked" });
      }
      out.set(action, each);
    }),
  );
  clearTimeout(timer);
  return out;
}

/**
 * Asks each action's available() once, with every target id the model
 * offers it on (askAvailability). An action not available is shown disabled
 * with its reason, and one not checked with UNCHECKED_REASON.
 */
export async function checkAvailability<M extends ActionSlots<ActionRef>>(
  model: M,
  o: {
    actions: ReadonlyMap<Id, RegisteredAction>;
    request: (() => Promise<SurfaceRequest>) | null;
    budgetMs?: number;
  },
): Promise<M> {
  const ids = new Map<Id, Set<string>>();
  mapActionSlots(model, (ref) => {
    const def = o.actions.get(ref.action)?.def;
    const id = def && targetId(def, ref.params);
    if (ref.enabled && def?.available && id !== undefined) {
      ids.set(ref.action, (ids.get(ref.action) ?? new Set()).add(id));
    }
    return ref;
  });

  const answers = o.request
    ? await askAvailability(o.actions, ids, o.request, o.budgetMs)
    : new Map<Id, Map<string, AvailabilityAnswer>>();

  return mapActionSlots(model, (ref) => {
    const def = o.actions.get(ref.action)?.def;
    if (!ref.enabled || !def?.available) return ref;
    const id = targetId(def, ref.params);
    const answer = id === undefined ? undefined : answers.get(ref.action)?.get(id);
    if (answer?.kind === "ok") return ref;
    return { ...ref, enabled: false, reason: answer?.kind === "refused" ? answer.reason : UNCHECKED_REASON };
  }) as M;
}

/** The plugins whose gate state the merge reads: the model's own actions' and those targeting its entities. */
function pluginsToRead(model: ActionSlots<ActionLink>, m: MergeContext): Set<MgmPluginName> {
  const plugins = new Set<MgmPluginName>();
  mapActionSlots(model, (link) => {
    const registered = m.actions.get(link.action);
    if (registered) plugins.add(registered.plugin);
    return link;
  });
  const kinds = new Set<EntityKind>(model.entity ? [model.entity.kind] : []);
  if (model.kind === "collection")
    for (const row of model.body.rows) for (const e of [row.entity, ...(row.related ?? [])]) if (e) kinds.add(e.kind);
  for (const { plugin, def } of m.actions.values())
    if (plugin !== m.view.plugin && kinds.has(def.target)) plugins.add(plugin);
  return plugins;
}

/**
 * A loader's model with every action resolved for the person: own links
 * checked and turned into ActionRefs, targeted actions appended, and
 * available() asked. What is left out is logged by action id and reason.
 */
export async function resolveActions<K extends ViewKind>(
  loaded: LoadedModel<K>,
  m: MergeContext,
): Promise<ResolvedModel<K>> {
  const model = { ...loaded, kind: m.view.def.kind } as unknown as ActionSlots<ActionLink>;
  const gate = new Map<MgmPluginName, GateState>();
  await Promise.all(
    [...pluginsToRead(model, m)].map(async (plugin) => {
      // A gate that throws counts as unreadable: the plugin stays out of the map.
      const state = m.gate === null ? ({ ok: true } as const) : await m.gate(plugin).catch(() => null);
      if (state) gate.set(plugin, state);
    }),
  );
  const input: MergeInput = {
    plugin: m.view.plugin,
    actions: [...m.actions.values()],
    scope: m.scope,
    gate,
    isReleased: isReleasedRoute,
  };
  const { model: merged, dropped } = resolveOwnAndTargeted(model, input, m.actions);
  for (const d of dropped) {
    const what = d.reason === "prefill" ? "prefill dropped" : `left out (${d.reason})`;
    console.warn(`[gui] view ${m.view.def.id}: action ${d.action} ${what}`);
  }
  const organizationId = m.organizationId;
  const checked = await checkAvailability(merged, {
    actions: m.actions,
    request: organizationId === null ? null : () => surfaceRequest(m.ctx, organizationId, {}, new URLSearchParams()),
  });
  return checked as unknown as ResolvedModel<K>;
}
