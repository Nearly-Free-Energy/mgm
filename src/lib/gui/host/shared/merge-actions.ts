/**
 * Targeted actions: the controls other plugins offer on the entities a view
 * shows, merged into the view's model. The merge is pure and lives here, so
 * tests of a GUI can run it; the I/O around it is in ../server/merge.ts.
 *
 * Pure and client-safe: nothing here reads the network, the database or the
 * clock. The plugin gate's answers and the released-route check come in as
 * arguments, and no input is changed: results are new objects.
 */
import { CORE_ENTITY_KINDS, MGM_BUNDLED_PLUGINS, type CoreEntityKind, type MgmPluginName } from "@/lib/plugins/bundled";
import type { ActionRef, BodiesOf, EntityRef, ViewKind } from "../../contract";
import type { ActionDef } from "../../surface";

/** A model's kind, body, own actions and entity, whatever its action shape. */
export type ActionSlots<A, V = unknown> = { [K in ViewKind]: { kind: K; body: BodiesOf<A, V>[K] } }[ViewKind] & {
  actions: A[];
  entity?: EntityRef;
};

/** What the merge reads of an action definition. */
export type MergeActionDef = Pick<
  ActionDef,
  "id" | "title" | "target" | "path" | "method" | "risk" | "confirm" | "bind"
>;
export type MergeAction = { plugin: MgmPluginName; def: MergeActionDef };
/**
 * A plugin's state for the organization. ../server/merge.ts stores the plugin
 * gate's GateDecision here, so the compiler keeps the two shapes compatible.
 */
export type GateState = { ok: true } | { ok: false; status: number; message: string };

export interface MergeInput {
  /** The plugin that contributed the view. */
  plugin: MgmPluginName;
  /** Every registered action. */
  actions: readonly MergeAction[];
  /** The entities the view's path resolved to. */
  scope: Partial<Record<CoreEntityKind, EntityRef>>;
  /** The gate's answer for each plugin; a plugin missing here counts as unreadable. */
  gate: ReadonlyMap<MgmPluginName, GateState>;
  /** Whether a filled route path is released (isReleasedRoute on the server). */
  isReleased(path: string): boolean;
}

export type DropReason = "unknown" | "params" | "unbound" | "unreleased" | "disabled" | "label" | "prefill";
/** An action left out of the model, or (for "prefill") left without its prefill. Ids only, never values. */
export type Dropped = { action: string; reason: DropReason };

const catalogIndex = (plugin: MgmPluginName) => {
  const i = MGM_BUNDLED_PLUGINS.findIndex((p) => p.name === plugin);
  return i < 0 ? MGM_BUNDLED_PLUGINS.length : i;
};
const displayName = (plugin: MgmPluginName) =>
  MGM_BUNDLED_PLUGINS.find((p) => p.name === plugin)?.displayName ?? plugin;

const CORE_KINDS: ReadonlySet<string> = new Set(CORE_ENTITY_KINDS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Whether `id` has the shape of an id of `kind`: a UUID for a core kind, a short token for a plugin's own. */
export function idFits(kind: string, id: string): boolean {
  return (CORE_KINDS.has(kind) ? UUID_RE : OWN_ID_RE).test(id);
}

/** A route pattern with each [name] segment filled from params, or null when one is missing. */
export function fillPath(pattern: string, params: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const path = pattern.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined || value === "") missing = true;
    return encodeURIComponent(value ?? "");
  });
  return missing ? null : path;
}

function danger(def: MergeActionDef): boolean {
  return def.confirm === "typed" || def.confirm === "ceremony" || def.risk === "destructive" || def.method === "DELETE";
}

/**
 * An ActionRef for one action with its params, or why it is left out. Checks,
 * in order: the filled path is released; the plugin is enabled. A disabled
 * plugin's action is left out when it is another plugin's, and shown disabled
 * with the gate's copy when it is the view's own.
 */
export function actionRef(
  a: MergeAction,
  params: Readonly<Record<string, string>>,
  input: MergeInput,
  label?: string,
): { ok: true; ref: ActionRef } | { ok: false; reason: DropReason } {
  const path = fillPath(a.def.path, params);
  if (path === null) return { ok: false, reason: "unbound" };
  if (!input.isReleased(path)) return { ok: false, reason: "unreleased" };
  const foreign = a.plugin !== input.plugin;
  const ref: ActionRef = { action: a.def.id, params: { ...params }, label: label ?? a.def.title, enabled: true };
  if (danger(a.def)) ref.tone = "danger";
  if (foreign) ref.from = displayName(a.plugin);
  const gate = input.gate.get(a.plugin);
  if (gate && !gate.ok && gate.status === 409) {
    if (foreign) return { ok: false, reason: "disabled" };
    ref.enabled = false;
    ref.reason = gate.message;
  } else if (!gate?.ok) {
    ref.enabled = false;
    ref.reason = `Could not verify whether ${displayName(a.plugin)} is enabled.`;
  }
  return { ok: true, ref };
}

/**
 * Params for an action offered on `on`: its own kind from `on`, other kinds
 * from the scope. Each id must have its kind's shape, since loaders supply them.
 */
function bindParams(
  def: MergeActionDef,
  on: EntityRef,
  scope: MergeInput["scope"],
): { ok: true; params: Record<string, string> } | { ok: false; reason: DropReason } {
  const params: Record<string, string> = {};
  for (const [name, kind] of [...Object.entries(def.bind.path ?? {}), ...Object.entries(def.bind.body ?? {})]) {
    const id = kind === on.kind ? on.id : scope[kind as CoreEntityKind]?.id;
    if (id === undefined) return { ok: false, reason: "unbound" };
    if (!idFits(kind, id)) return { ok: false, reason: "params" };
    params[name] = id;
  }
  return { ok: true, params };
}

type Loose = Record<string, unknown>;
/** A copy of `o` with `key` set, or removed when `value` is undefined. */
function withKey<T>(o: T, key: string, value: unknown): T {
  const out: Loose = { ...(o as Loose) };
  if (value === undefined) delete out[key];
  else out[key] = value;
  return out as T;
}

/**
 * A copy of the model with `f` applied to the action in every slot: the
 * model's actions, each row's actions, the empty state's action, each flow
 * step's action, a feed's compose and stop actions, and action embeds. Where
 * `f` returns null the action is removed, and a compose or embed without its
 * action goes with it.
 */
export function mapActionSlots<A, B, V>(model: ActionSlots<A, V>, f: (a: A) => B | null): ActionSlots<B, V> {
  const list = (as: readonly A[]) => as.flatMap((a) => f(a) ?? []);
  const one = (a: A | undefined) => (a === undefined ? undefined : (f(a) ?? undefined));
  let body: unknown = model.body;
  switch (model.kind) {
    case "collection": {
      const b = model.body;
      body = {
        ...b,
        rows: b.rows.map((r) => ({ ...r, actions: list(r.actions) })),
        empty: withKey(b.empty, "action", one(b.empty.action)),
      };
      break;
    }
    case "flow":
      body = { ...model.body, steps: model.body.steps.map((s) => withKey(s, "action", one(s.action))) };
      break;
    case "feed": {
      const b = model.body;
      const compose = b.compose && withKey(b.compose, "action", one(b.compose.action));
      const entries = b.entries.map((e) => {
        if (e.embed?.type !== "action") return e;
        const ref = one(e.embed.ref);
        return withKey(e, "embed", ref === undefined ? undefined : { type: "action", ref });
      });
      body = withKey(withKey({ ...b, entries }, "compose", compose?.action ? compose : undefined), "stop", one(b.stop));
      break;
    }
  }
  return { ...model, body, actions: list(model.actions) } as unknown as ActionSlots<B, V>;
}

const byId = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const sameLabel = (label: string) => label.trim().toLowerCase();

/**
 * Appends the actions other plugins target at the view's entity (to the
 * model's actions) and at each row's entity or related entities (to that
 * row's actions). Their params come from that entity and the path scope; an
 * action whose bound kinds are not all there is left out. They follow the
 * view's own actions, in catalog order and then by id. An action already in
 * the list is not repeated, and one whose label matches an action already in
 * the list is left out. Other slots get no targeted actions.
 */
export function appendTargetedActions<V, M extends ActionSlots<ActionRef, V>>(
  model: M,
  input: MergeInput,
): { model: M; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const foreign = input.actions
    .filter((a) => a.plugin !== input.plugin)
    .sort((x, y) => catalogIndex(x.plugin) - catalogIndex(y.plugin) || byId(x.def.id, y.def.id));

  const targeted = (entities: readonly (EntityRef | undefined)[]) =>
    foreign.flatMap((a) => {
      const on = entities.find((e) => e?.kind === a.def.target);
      if (!on) return [];
      const bound = bindParams(a.def, on, input.scope);
      const made = bound.ok ? actionRef(a, bound.params, input) : bound;
      if (made.ok) return [made.ref];
      dropped.push({ action: a.def.id, reason: made.reason });
      return [];
    });

  const merge = (own: readonly ActionRef[], extra: readonly ActionRef[]) => {
    const ids = new Set(own.map((r) => r.action));
    const labels = new Set(own.map((r) => sameLabel(r.label)));
    const out = [...own];
    for (const ref of extra) {
      if (ids.has(ref.action)) continue;
      if (labels.has(sameLabel(ref.label))) {
        dropped.push({ action: ref.action, reason: "label" });
        continue;
      }
      ids.add(ref.action);
      labels.add(sameLabel(ref.label));
      out.push(ref);
    }
    return out;
  };

  const actions = merge(model.actions, model.entity ? targeted([model.entity]) : []);
  let body: unknown = model.body;
  if (model.kind === "collection") {
    const b = model.body as BodiesOf<ActionRef, V>["collection"];
    body = {
      ...b,
      rows: b.rows.map((r) => ({ ...r, actions: merge(r.actions, targeted([r.entity, ...(r.related ?? [])])) })),
    };
  }
  return { model: { ...model, actions, body } as M, dropped };
}
