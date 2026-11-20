import "server-only";

/**
 * Serves one contributed view for the signed-in person: the href is matched
 * against the views' paths, its segments are resolved to one organization
 * the person can see (./entities.ts), the view's plugin is checked with the
 * plugin gate (./gate-state.ts), the loader runs on its own client of the
 * person's session (./access.ts), and what it returns is strictly parsed
 * (./parse.ts) before actions are resolved (./merge.ts) and host fields
 * are filled. A view declaring `takesSignals` is handed the organization's
 * signals (organizationSignals in ./signals.ts) before its loader runs, and
 * its model carries them for the shell's signals feed. A
 * tenant view (scope "tenant") is about one of the person's own units
 * instead, and is served by dispatchTenantView.
 *
 * A refusal carries a status, a code and fixed copy. Nothing a loader
 * returned or threw reaches it, except a loader's own refusal message.
 */
import { rolesIncludeStaff } from "@/lib/auth/access";
import { CORE_ENTITY_KINDS, type CoreEntityKind } from "@/lib/plugins/bundled";
import type { GateDecision } from "@/lib/runtime/gate";
import type { EntityKind, Href, ModelBase, Signals, ViewKind, ViewModel } from "../../contract";
import type { Loaded, LoadedModel, ViewDef } from "../../surface";
import { fillPath } from "../shared/merge-actions";
import { chooseTenantUnit, TENANT_UNIT_PARAM } from "../shared/tenant-units";
import { installationRequest, requireIssued, surfaceRequest, tenantRequest, type HostContext } from "./access";
import { resolveSegments, type Scope } from "./entities";
import { pluginGate, type PluginGate } from "./gate-state";
import { isPageHref, parseHref } from "./hrefs";
import { resolveActions } from "./merge";
import { viewModelSchema } from "./model-schema";
import { selectOrganization } from "./organization";
import { organizationSignals } from "./signals";
import { MODEL_CAPS, parseOrFail, strictParseModel } from "./parse";
import { surfaceSnapshot } from "./snapshot";
import type { RegisteredView, SurfaceSnapshot } from "./surface-registry";

export type HostFailure = { ok: false; status: number; code: string; message: string };
export type HostOutcome<T> = { ok: true; value: T } | HostFailure;

const fail = (status: number, code: string, message: string): HostFailure => ({ ok: false, status, code, message });
const NOT_FOUND = fail(404, "gui_not_found", "This page could not be found.");
const OUTPUT_INVALID = fail(500, "gui_output_invalid", "This view could not be shown.");
const VIEW_FAILED = fail(500, "gui_view_failed", "This view could not be loaded.");
/**
 * A tenant view asked for by a person with several units, naming none. The
 * page answers it with a choice of their units; the code is what tells it so.
 */
export const UNIT_REQUIRED = fail(400, "gui_unit_required", "Choose which of your units to show.");
/**
 * A tenant view whose plugin is off for the unit's organization. RFC mgm#197
 * § 3 shows such a tenant the page an unreleased path gets, not a setting
 * they cannot change, so the status is that page's 404 (src/middleware.ts)
 * and the code tells the page to draw it.
 */
export const NOT_RELEASED = fail(404, "gui_not_released", "This page is not part of the MGM release installed here.");

/** The notice on a model with generated figures, unless the gate's notice is shown. */
export const SYNTHETIC_NOTICE = {
  tone: "warning",
  text: "Synthetic data: these figures are generated for demonstration, not measured.",
} as const;

type Notice = NonNullable<ViewModel["notice"]>;

/**
 * The notice a view shows: the host's own (the gate's, else the one on
 * generated figures) and then the loader's, in one notice. Neither hides
 * the other, so the links a loader gives beside its notice (such as the
 * time zone nudge's Set timezone) always have their text on the page. The
 * host's notices are warnings; a loader's danger tone outranks them. The
 * text is cut to the model's string cap (MODEL_CAPS in ./parse.ts).
 */
export function shownNotice(host: Notice | undefined, own: Notice | undefined): { notice?: Notice } {
  if (!host) return own ? { notice: own } : {};
  if (!own) return { notice: { ...host } };
  const text = `${host.text} ${own.text}`;
  return {
    notice: {
      tone: own.tone === "danger" ? "danger" : host.tone,
      text: text.length > MODEL_CAPS.text ? `${text.slice(0, MODEL_CAPS.text - 1)}…` : text,
    },
  };
}
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

/**
 * What a loader returned, as its refusal or its strictly parsed model. A
 * malformed refusal or model is OUTPUT_INVALID, and a refusal's own message
 * is the only text of the loader's that reaches the person.
 */
function checkLoaded(def: ViewDef, loaded: unknown): HostOutcome<LoadedModel<ViewKind>> {
  if (loaded === null || typeof loaded !== "object") return OUTPUT_INVALID;
  const out = loaded as Loaded<LoadedModel<ViewKind>>;
  if (out.ok === false) {
    if (!LOADER_STATUSES.has(out.status) || typeof out.message !== "string") return OUTPUT_INVALID;
    const code = out.status === 404 ? "gui_not_found" : "gui_view_refused";
    return fail(out.status, code, out.message.slice(0, MAX_MESSAGE));
  }
  if (out.ok !== true) return OUTPUT_INVALID;
  const model = strictParseModel(def, out.model);
  return model.ok ? model : OUTPUT_INVALID;
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
 * its plugin enabled (a section, and a tab or tile declaring
 * `attach.whilePluginOff: "listed"`, is listed while its plugin is disabled,
 * so it loads with the gate's notice). A query parameter both views declare
 * is passed on. A view with no path segments gets `?org=`, so it opens in
 * this organization.
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
      if (!isPageHref(href)) return null;
      // A section of a disabled plugin is still listed, so the GUI loads it and
      // shows the gate's notice in its place (decision 18 on #115); a disabled
      // plugin's tabs and tiles are left out, unless one declares
      // whilePluginOff: "listed", which gui-surface.test.ts allows only for a
      // view whose loader works while its plugin is off. A gate that cannot be
      // read leaves every one out. If the gate's 409 stops meaning
      // "disabled", revisit.
      const decision = await decide(p.gate, other.plugin);
      const attach = other.def.attach!;
      const listedWhileOff = attach.hint === "section" || attach.whilePluginOff === "listed";
      if (!decision.ok && !(decision.status === 409 && listedWhileOff)) return null;
      const title =
        p.snapshot.nav.find((n) => "view" in n.def && n.def.view === other.def.id)?.def.title ??
        other.def.examples[0]?.title ??
        other.def.id;
      return { order: attach.order, entry: { view: other.def.id, title, href: href as Href, hint: attach.hint } };
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
 * A tenant view (RFC mgm#197 § 4) for `ctx`'s person: about one unit they
 * rent, chosen among their own tenant rows by the `unit` parameter, or their
 * only unit. A unit that is not theirs, and a person with no unit, get the
 * same 404 as a page that does not exist; a person with several units who
 * names none gets UNIT_REQUIRED, so the host can offer a choice.
 *
 * The host reads nothing of an organization for it: no segments resolve, no
 * organization is chosen and the host asks no gate, since a tenant reaches
 * neither organizations nor the gate's staff reads. The loader composes
 * through composeTenantApp, which authorizes the unit with the caller's own
 * session and refuses while the tenant app is off for the unit's organization
 * (a 409 the loader passes on, which this answers with NOT_RELEASED); if a
 * tenant view's loader ever reads without that composer, this function must
 * ask the gate. A tenant view's loader may read an organization's records on
 * the server, after composeTenantApp, to work out the unit's own figures,
 * only if it asks the gate of each plugin whose records it reads, and none
 * of those records may reach the model: the usage source
 * (@/lib/tenant-app/infrastructure/usage-source) reads the meters' edges and
 * the microgrid's OpenEMS connection this way, and asks the metering gate
 * itself. If a loader ever puts an organization's record into the model, or
 * reads one before composeTenantApp or without asking the gate of each
 * plugin whose records it reads, this function must check the model or ask
 * those gates. CLAUDE.md's tenant-view rule says the same; change the two
 * together. The model has no organization, trail, attached views or
 * actions: every action is a staff route, so none is offered, whether the
 * loader links it or another plugin targets the view's entity. It is never
 * loaded inside another view.
 */
async function dispatchTenantView(
  ctx: HostContext,
  view: RegisteredView,
  def: Extract<ViewDef, { scope: "tenant" }>,
  search: URLSearchParams,
  depth: 0 | 1,
): Promise<HostOutcome<ViewModel>> {
  if (depth !== 0) return NOT_FOUND;
  const unit = chooseTenantUnit(ctx.access.roles, search.getAll(TENANT_UNIT_PARAM));
  if (!unit.ok) return unit.reason === "choose" ? UNIT_REQUIRED : NOT_FOUND;

  let loaded: unknown;
  try {
    loaded = await def.load(await tenantRequest(ctx, unit.tenantId, querySearch(def.query, search)));
  } catch {
    console.error(`[gui] view ${def.id}: loader failed`);
    return VIEW_FAILED;
  }
  const model = checkLoaded(def, loaded);
  // A tenant view's 409 is composeTenantApp's: the plugin gate's refusal of
  // the tenant app for the unit's organization. If a tenant loader starts
  // answering 409 for anything else, give that its own status.
  if (!model.ok) return model.status === 409 ? NOT_RELEASED : model;

  try {
    const merged = await resolveActions(model.value, {
      view,
      actions: new Map(),
      scope: {},
      ctx,
      organizationId: null,
      gate: null,
    });
    const { links, notice: own, ...rest } = merged;
    const live = clampLive(def);
    const out = {
      ...rest,
      type: "view",
      view: def.id,
      kind: def.kind,
      org: null,
      trail: [],
      links: links ?? [],
      attached: [],
      // The notice on generated figures, then the loader's own.
      ...shownNotice(hasSynthetic(merged.body) ? SYNTHETIC_NOTICE : undefined, own),
      ...(live ? { live } : {}),
    };
    const checked = parseOrFail(viewModelSchema, out, `view ${def.id}`);
    return checked.ok ? { ok: true, value: checked.value as ViewModel } : OUTPUT_INVALID;
  } catch {
    console.error(`[gui] view ${def.id}: could not be completed`);
    return VIEW_FAILED;
  }
}

/**
 * The organization's signals for a view that declares `takesSignals`, or
 * null when they could not be collected; the loader shows that in place of
 * the signals.
 */
async function takenSignals(ctx: HostContext, organizationId: string): Promise<Signals | null> {
  try {
    const out = await organizationSignals(ctx, organizationId);
    return out.ok ? out.value : null;
  } catch {
    console.error("[gui] signals could not be collected for a view");
    return null;
  }
}

/**
 * The view an href names, loaded for `ctx`'s person. `depth` 1 is a view
 * loaded inside another: it lists no attached views and embeds no views.
 * `within` is the enclosing view's organization: the view loads there or
 * not at all. `preferred` is the organization the person last used (the
 * org cookie), which a page passes so that a view whose path names no
 * organization opens in the one the shell shows (getManifest reads the same
 * cookie as its hint); like `?org=`, it only chooses among the
 * organizations the person can see.
 */
export async function dispatchView(
  ctx: HostContext,
  href: string,
  o: { depth?: 0 | 1; within?: string | null; preferred?: string | null } = {},
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
  if (def.scope === "tenant") return dispatchTenantView(ctx, view, def, parsed.search, depth);
  // Every other view is staff's: about an organization, or the whole
  // installation. A person with only tenant rows (RFC mgm#197) gets the
  // answer a page that does not exist gets, before any read.
  if (!rolesIncludeStaff(ctx.access.roles)) return NOT_FOUND;

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
      organizationId = (await selectOrganization(ctx, { requested, preferred: o.preferred })).organizationId;
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
  // The registration check allows takesSignals only on an organization's view.
  const signals = def.takesSignals && organizationId !== null ? await takenSignals(ctx, organizationId) : undefined;
  let loaded: unknown;
  try {
    loaded =
      def.scope === "installation"
        ? await def.load(await installationRequest(ctx, params, search))
        : await def.load({
            ...(await surfaceRequest(ctx, organizationId!, params, search)),
            ...(signals === undefined ? {} : { signals }),
          });
  } catch {
    console.error(`[gui] view ${def.id}: loader failed`);
    return VIEW_FAILED;
  }
  const model = checkLoaded(def, loaded);
  if (!model.ok) return model;

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
    const { links, notice: own, ...rest } = merged;
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
      // The gate's notice, else the one on generated figures, then the loader's own.
      ...shownNotice(notice ?? (synthetic ? SYNTHETIC_NOTICE : undefined), own),
      ...(live ? { live } : {}),
      // The shell's signals feed takes these instead of fetching them again.
      ...(signals ? { signals } : {}),
    };
    const checked = parseOrFail(viewModelSchema, out, `view ${def.id}`);
    return checked.ok ? { ok: true, value: checked.value as ViewModel } : OUTPUT_INVALID;
  } catch {
    console.error(`[gui] view ${def.id}: could not be completed`);
    return VIEW_FAILED;
  }
}
