import "server-only";

/**
 * Serves one contributed view for the signed-in person: the href is matched
 * against the views' paths, its segments are resolved to one organization
 * the person can see (./entities.ts), the view's plugin is checked with the
 * plugin gate (./gate-state.ts), the loader runs on its own client of the
 * person's session (./access.ts), and what it returns is strictly parsed
 * (./parse.ts) before actions are resolved (./merge.ts) and host fields
 * are filled.
 *
 * A refusal carries a status, a code and fixed copy. Nothing a loader
 * returned or threw reaches it, except a loader's own refusal message.
 */
import { CORE_ENTITY_KINDS, type CoreEntityKind } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { EntityKind, Href, ModelBase, ViewKind, ViewModel } from "../../contract";
import type { Loaded, LoadedModel } from "../../surface";
import { fillPath } from "../shared/merge-actions";
import { installationRequest, requireIssued, surfaceRequest, type HostContext } from "./access";
import { resolveSegments, type Scope } from "./entities";
import { pluginGate, type PluginGate } from "./gate-state";
import { isPageHref, parseHref } from "./hrefs";
import { resolveActions } from "./merge";
import { viewModelSchema } from "./model-schema";
import { selectOrganization } from "./organization";
import { parseOrFail, strictParseModel } from "./parse";
import { surfaceSnapshot } from "./snapshot";
import type { RegisteredView, SurfaceSnapshot } from "./surface-registry";

export type HostFailure = { ok: false; status: number; code: string; message: string };
export type HostOutcome<T> = { ok: true; value: T } | HostFailure;

const fail = (status: number, code: string, message: string): HostFailure => ({ ok: false, status, code, message });
const NOT_FOUND = fail(404, "gui_not_found", "This page could not be found.");
const OUTPUT_INVALID = fail(500, "gui_output_invalid", "This view could not be shown.");
const VIEW_FAILED = fail(500, "gui_view_failed", "This view could not be loaded.");

/** The notice on a model with generated figures, unless the gate's notice is shown. */
export const SYNTHETIC_NOTICE = {
  tone: "warning",
  text: "Synthetic data: these figures are generated for demonstration, not measured.",
} as const;
/** The shortest refresh the host sends: vendor views call an outside system on every load. */
export const MIN_REFRESH_SECONDS = { db: 15, vendor: 60 } as const;
const LOADER_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 500, 503]);
const MAX_MESSAGE = 300;
const NOT_AVAILABLE = { type: "values", values: [{ t: "text", text: "Not available" }] } as const;

const isCore = (kind: EntityKind): kind is CoreEntityKind => (CORE_ENTITY_KINDS as readonly string[]).includes(kind);

/**
 * The view whose path fits `path`, with its segment values decoded. Where two
 * fit, a fixed segment beats a bracketed one at the first position they
 * differ, as matchCatalogPage (src/lib/plugins/bundled.ts) ranks pages.
 */
export function matchView(
  views: readonly RegisteredView[],
  path: string,
): { view: RegisteredView; values: Record<string, string> } | undefined {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  let best: { view: RegisteredView; values: Record<string, string>; rank: string } | undefined;
  for (const view of views) {
    const segments = view.def.path.split("/").filter(Boolean);
    if (segments.length !== parts.length) continue;
    const values: Record<string, string> = {};
    let rank = "";
    const fits = segments.every((segment, i) => {
      const name = /^\[(.+)\]$/.exec(segment)?.[1];
      rank += name ? "0" : "1";
      if (name) values[name] = parts[i];
      return name !== undefined || segment === parts[i];
    });
    if (fits && (!best || rank > best.rank)) best = { view, values, rank };
  }
  return best && { view: best.view, values: best.values };
}

/** The search parameters a view's loader reads: only the names in its `query`. */
function querySearch(names: readonly string[] | undefined, search: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const name of names ?? []) for (const value of search.getAll(name)) out.append(name, value);
  return out;
}

/** Whether any Value in `node` is marked synthetic. Values carry `t` and `text`. */
function hasSynthetic(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasSynthetic);
  if (node === null || typeof node !== "object") return false;
  const o = node as Record<string, unknown>;
  if (typeof o.t === "string" && typeof o.text === "string" && o.synthetic === true) return true;
  return Object.values(o).some(hasSynthetic);
}

function clampLive(def: RegisteredView["def"]): ModelBase<ViewKind, unknown, unknown>["live"] {
  if (!def.live) return undefined;
  const refreshSeconds = Math.max(def.live.refreshSeconds, MIN_REFRESH_SECONDS[def.cost]);
  return { refreshSeconds, staleAfterSeconds: Math.max(def.live.staleAfterSeconds, refreshSeconds) };
}

async function decide(gate: PluginGate | null, plugin: RegisteredView["plugin"]): Promise<GateDecision> {
  if (!gate) return { ok: true, organizationId: null };
  return gate(plugin).catch(
    (): GateDecision => ({ ok: false, status: 503, code: `${plugin}_gate_unavailable`, message: "Could not check whether this part of MGM is enabled." }),
  );
}

type Place = {
  snapshot: SurfaceSnapshot;
  view: RegisteredView;
  params: Record<string, string>;
  search: URLSearchParams;
  scope: Scope;
  organizationId: string | null;
  gate: PluginGate | null;
};

/**
 * Views attached to this one's entity kind or to this view, other than
 * itself: each with its path filled from the same entities, released, and
 * its plugin enabled. A query parameter both views declare is passed on. A
 * view with no path segments gets `?org=`, so it opens in this organization.
 */
async function attachedViews(p: Place): Promise<ModelBase<ViewKind, unknown, unknown>["attached"]> {
  const { def } = p.view;
  const kind = def.entity === undefined ? undefined : def.params[def.entity];
  const kindIds = new Map<EntityKind, string>();
  for (const [name, k] of Object.entries(def.params)) kindIds.set(k, p.params[name]);
  for (const [k, ref] of Object.entries(p.scope)) if (ref) kindIds.set(k as CoreEntityKind, ref.id);

  const candidates = p.snapshot.views.filter(({ def: other }) => {
    const to = other.attach?.to;
    if (other.id === def.id || to === undefined) return false;
    return typeof to === "string" ? to === kind : to.view === def.id;
  });
  const shown = await Promise.all(
    candidates.map(async (other) => {
      const params: Record<string, string> = {};
      for (const [name, k] of Object.entries(other.def.params)) {
        const id = kindIds.get(k);
        if (id === undefined) return null;
        params[name] = id;
      }
      const path = fillPath(other.def.path, params);
      if (path === null) return null;
      const search = querySearch(other.def.query?.filter((name) => def.query?.includes(name)), p.search);
      search.delete("org");
      if (Object.keys(other.def.params).length === 0 && other.def.scope !== "installation" && p.organizationId !== null) {
        search.set("org", p.organizationId);
      }
      const query = search.toString();
      const href = query ? `${path}?${query}` : path;
      if (!isPageHref(href) || !(await decide(p.gate, other.plugin)).ok) return null;
      const title =
        p.snapshot.nav.find((n) => "view" in n.def && n.def.view === other.def.id)?.def.title ??
        other.def.examples[0]?.title ??
        other.def.id;
      return { order: other.def.attach!.order, entry: { view: other.def.id, title, href: href as Href, hint: other.def.attach!.hint } };
    }),
  );
  return shown
    .filter((s) => s !== null)
    .sort((a, b) => a.order - b.order || a.entry.view.localeCompare(b.entry.view))
    .map((s) => s.entry);
}

/**
 * A feed's body with each view embed loaded at depth 1, in the same
 * organization, or shown as "Not available". Other bodies are returned as given.
 */
async function embedViews<B>(ctx: HostContext, kind: ViewKind, body: B, org: string | null, depth: 0 | 1): Promise<B> {
  if (kind !== "feed") return body;
  type Entry = { embed?: { type: string; href?: string } };
  const feed = body as B & { entries: Entry[] };
  const entries = await Promise.all(
    feed.entries.map(async (entry) => {
      const embed = entry.embed;
      if (embed?.type !== "view" || embed.href === undefined) return entry;
      const out = depth === 0 ? await dispatchView(ctx, embed.href, { depth: 1, within: org }) : null;
      const loaded = out?.ok && out.value.org === org ? { type: "view", href: embed.href, model: out.value } : null;
      return { ...entry, embed: loaded ?? structuredClone(NOT_AVAILABLE) };
    }),
  );
  return { ...feed, entries };
}

/**
 * The view an href names, loaded for `ctx`'s person. `depth` 1 is a view
 * loaded inside another: it lists no attached views and embeds no views.
 * `within` is the enclosing view's organization: the view loads there or
 * not at all.
 */
export async function dispatchView(
  ctx: HostContext,
  href: string,
  o: { depth?: 0 | 1; within?: string | null } = {},
): Promise<HostOutcome<ViewModel>> {
  requireIssued(ctx);
  const depth = o.depth ?? 0;
  const parsed = parseHref(href);
  if (!parsed) return fail(400, "gui_bad_request", "The link is not valid.");
  if (!isPageHref(href)) return NOT_FOUND;
  const snapshot = await surfaceSnapshot();
  const match = matchView(snapshot.views, parsed.path);
  if (!match) return NOT_FOUND;
  const { view } = match;
  const def = view.def;

  const segments = Object.entries(def.params).map(([name, kind]) => {
    const id = match.values[name];
    return { name, kind, id: isCore(kind) ? id.toLowerCase() : id };
  });
  const params = Object.fromEntries(segments.map((s) => [s.name, s.id]));
  const resolved = await resolveSegments(ctx, snapshot, segments);
  if (!resolved.ok) return resolved.status === 404 ? NOT_FOUND : fail(503, "gui_unavailable", "This view could not be loaded right now.");

  let organizationId = resolved.organizationId;
  if (def.scope === "installation") organizationId = null;
  else if (organizationId === null) {
    try {
      const requested = o.within ?? parsed.search.get("org");
      organizationId = (await selectOrganization(ctx, { requested })).organizationId;
    } catch {
      return fail(503, "gui_unavailable", "This view could not be loaded right now.");
    }
    if (organizationId === null) return fail(403, "gui_no_access", "Your account has no organization yet.");
  }
  if (o.within !== undefined && organizationId !== o.within) return NOT_FOUND;

  const gate = organizationId === null ? null : pluginGate(ctx, organizationId);
  const decision = await decide(gate, view.plugin);
  // A vendor view calls an outside system, so a disabled plugin gets the gate's refusal and no load.
  if (!decision.ok && def.cost === "vendor") return fail(decision.status, decision.code, decision.message);
  const notice = decision.ok ? undefined : { tone: "warning" as const, text: decision.message };

  const search = querySearch(def.query, parsed.search);
  let loaded: Loaded<LoadedModel<ViewKind>>;
  try {
    loaded = (
      def.scope === "installation"
        ? await def.load(await installationRequest(ctx, params, search))
        : await def.load(await surfaceRequest(ctx, organizationId!, params, search))
    ) as Loaded<LoadedModel<ViewKind>>;
  } catch {
    console.error(`[gui] view ${def.id}: loader failed`);
    return VIEW_FAILED;
  }
  if (loaded === null || typeof loaded !== "object") return OUTPUT_INVALID;
  if (loaded.ok === false) {
    if (!LOADER_STATUSES.has(loaded.status) || typeof loaded.message !== "string") return OUTPUT_INVALID;
    const code = loaded.status === 404 ? "gui_not_found" : "gui_view_refused";
    return fail(loaded.status, code, loaded.message.slice(0, MAX_MESSAGE));
  }
  if (loaded.ok !== true) return OUTPUT_INVALID;
  const model = strictParseModel(def, loaded.model);
  if (!model.ok) return OUTPUT_INVALID;

  try {
    const entityKind = def.entity === undefined ? undefined : def.params[def.entity];
    const entity = model.value.entity ?? (entityKind && isCore(entityKind) ? resolved.scope[entityKind] : undefined);
    const merged = await resolveActions(
      { ...model.value, ...(entity ? { entity } : {}) },
      organizationId === null
        ? { view, actions: snapshot.actions, scope: resolved.scope, ctx, organizationId: null, gate: null }
        : { view, actions: snapshot.actions, scope: resolved.scope, ctx, organizationId, gate: gate! },
    );
    const synthetic = hasSynthetic(merged.body);
    const place: Place = { snapshot, view, params, search: parsed.search, scope: resolved.scope, organizationId, gate };
    const [attached, body] = await Promise.all([
      depth === 0 ? attachedViews(place) : [],
      embedViews(ctx, def.kind, merged.body, organizationId, depth),
    ]);
    const { links, ...rest } = merged;
    const live = clampLive(def);
    const out = {
      ...rest,
      body,
      type: "view",
      view: def.id,
      kind: def.kind,
      org: organizationId,
      trail: resolved.trail,
      links: links ?? [],
      attached,
      ...(notice ? { notice } : synthetic ? { notice: { ...SYNTHETIC_NOTICE } } : {}),
      ...(live ? { live } : {}),
    };
    const checked = parseOrFail(viewModelSchema, out, `view ${def.id}`);
    return checked.ok ? { ok: true, value: checked.value as ViewModel } : OUTPUT_INVALID;
  } catch {
    console.error(`[gui] view ${def.id}: could not be completed`);
    return VIEW_FAILED;
  }
}
