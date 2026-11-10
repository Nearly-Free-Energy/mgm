/**
 * The interface manifest for one organization, built from what the server
 * has already read. Pure, so a test or the conformance kit can build one
 * without a request; ../server/manifest.ts does the reads.
 *
 * Everything here is display filtering. Hiding a nav entry or a place grants
 * and refuses nothing: middleware, the plugin gate, roles and row-level
 * security still decide every request.
 */
import { CORE_ENTITY_KINDS, MGM_BUNDLED_PLUGINS } from "@/lib/plugins/bundled";
import type { CoreEntityKind, MgmPluginName } from "@/lib/plugins/bundled";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import { microgridHref } from "@/lib/microgrid-links";
import { GUI_CONTRACT } from "../../contract";
import type { EntityKind, EntityRef, Href, Id, Manifest, NavEntry, NavGroup, OrgManifest, StatusItem } from "../../contract";
import type { NavDef } from "../../surface";
import { isSameOriginPath } from "./href";

/** Communities and microgrids each; the path's own place is kept beyond it. */
export const MAX_PLACES_PER_KIND = 100;
/** Organizations in the switcher; the current one is kept beyond it. */
export const MAX_ORGS = 100;

const GROUP_ORDER: Record<NavGroup, number> = { operate: 0, money: 1, configure: 2, system: 3 };

type Place = OrgManifest["places"][number];

export interface ManifestInput {
  /** Null until the release build stamps a version (decision 17). */
  release: string | null;
  locale: string;
  now: Date;
  gui: string;
  /** Only name and email are kept, whatever else the object carries. */
  user: { name: string | null; email?: string | null };
  superAdmin: boolean;
  org: { id: string; name: string };
  /** The organizations the person can see, in the order to show them. */
  orgs: readonly { id: string; name: string }[];
  /** The plugin gate's answer for this organization; a plugin not named counts as off. */
  gate: Partial<Record<MgmPluginName, boolean>>;
  nav: readonly { plugin: MgmPluginName; def: NavDef }[];
  views: readonly { plugin: MgmPluginName; def: { id: Id; path: string; params: Readonly<Record<string, EntityKind>> } }[];
  status: readonly { plugin: MgmPluginName; item: StatusItem }[];
  communities: readonly { id: string; name: string }[];
  microgrids: readonly { id: string; name: string; communityId: string | null; timezone: string | null }[];
  /** The community and microgrid the request's path names; `parent` is the microgrid's community id. */
  scope?: { community?: EntityRef; microgrid?: EntityRef & { parent?: string } };
}

/**
 * Plugins that are enabled for the organization and whose dependencies are
 * live too, all the way down, so a page is never offered under a plugin that
 * is off further down. Settings → Plugins (resolvePluginStatuses in
 * bundled.ts) checks direct dependencies only; if it starts checking them
 * all the way down, the two agree.
 */
export function livePlugins(gate: ManifestInput["gate"]): Set<MgmPluginName> {
  const plugins = new Map(MGM_BUNDLED_PLUGINS.map((p) => [p.name, p]));
  const memo = new Map<MgmPluginName, boolean>();
  const isLive = (name: MgmPluginName): boolean => {
    if (!memo.has(name)) {
      memo.set(name, false); // a dependency cycle counts as off
      memo.set(name, gate[name] === true && (plugins.get(name)?.dependencies ?? []).every(isLive));
    }
    return memo.get(name)!;
  };
  return new Set([...plugins.keys()].filter(isLive));
}

const isCore = (kind: EntityKind | undefined): kind is CoreEntityKind =>
  (CORE_ENTITY_KINDS as readonly (string | undefined)[]).includes(kind);

/**
 * A route with each [segment] renamed after its kind, so a GUI can fill it
 * from the entities in scope: "/microgrids/[id]/billing" with
 * { id: "microgrid" } becomes "/microgrids/[microgrid]/billing". Null when a
 * segment's kind is not a core kind, or two segments share a kind.
 */
export function kindNamedHref(
  path: string,
  kindOf: (name: string, index: number) => EntityKind | undefined,
): { href: Href; needs: CoreEntityKind[] } | null {
  const needs: CoreEntityKind[] = [];
  const segments = path.split("/").map((segment) => {
    const name = /^\[(.+)\]$/.exec(segment)?.[1];
    if (name === undefined) return segment;
    const kind = kindOf(name, needs.length);
    if (!isCore(kind) || needs.includes(kind)) return null;
    needs.push(kind);
    return `[${kind}]`;
  });
  if (segments.includes(null)) return null;
  const href = segments.join("/");
  return isPage(href) ? { href: href as Href, needs } : null;
}

/** A same-origin path whose route is released. */
function isPage(href: string): boolean {
  return isSameOriginPath(href) && isReleasedRoute(href.split(/[?#]/, 1)[0]);
}

const pageHref = (href: string): { href?: Href } => (isPage(href) ? { href: href as Href } : {});

function navEntry(def: NavDef, views: Map<Id, ManifestInput["views"][number]["def"]>): NavEntry | null {
  const base = { id: def.id, title: def.title, icon: def.icon, group: def.group, order: def.order };
  if ("view" in def) {
    const view = views.get(def.view);
    const pattern = view && kindNamedHref(view.path, (name) => view.params[name]);
    return pattern ? { ...base, ...pattern } : null;
  }
  const pattern = kindNamedHref(def.href, (_name, index) => def.needs[index]);
  return pattern ? { ...base, ...pattern, legacy: true } : null;
}

/**
 * The organization's communities and microgrids when `listed`, capped, and
 * the path's own places in any case, so the shell can show where the person
 * is even past the cap.
 */
function placesOf(input: ManifestInput, listed: boolean): Place[] {
  const places: Place[] = !listed ? [] : [
    ...input.communities.slice(0, MAX_PLACES_PER_KIND).map((c): Place => ({
      kind: "community",
      id: c.id,
      label: c.name,
      ...pageHref(`/communities/${c.id}`),
    })),
    ...input.microgrids.slice(0, MAX_PLACES_PER_KIND).map((m): Place => ({
      kind: "microgrid",
      id: m.id,
      label: m.name,
      ...pageHref(microgridHref(m.id)),
      ...(m.communityId ? { parent: m.communityId } : {}),
    })),
  ];
  for (const kind of ["community", "microgrid"] as const) {
    const ref = input.scope?.[kind];
    if (!ref || places.some((p) => p.kind === kind && p.id === ref.id)) continue;
    const parent = kind === "microgrid" ? (input.scope?.microgrid?.parent ?? input.scope?.community?.id) : undefined;
    const href = ref.href ? { href: ref.href } : pageHref(kind === "community" ? `/communities/${ref.id}` : microgridHref(ref.id));
    places.push({ kind, id: ref.id, label: ref.label, ...href, ...(parent ? { parent } : {}) });
  }
  return places;
}

/** The time zone every microgrid shares, or null when they differ or none has one. */
function sharedTimezone(microgrids: ManifestInput["microgrids"]): string | null {
  const zones = new Set(microgrids.map((m) => m.timezone).filter((z): z is string => !!z));
  return zones.size === 1 ? [...zones][0] : null;
}

const organizationHref = (id: string) => `/organizations/${id}` as Href;

export function buildManifestModel(input: ManifestInput): Manifest {
  const live = livePlugins(input.gate);
  const views = new Map(input.views.map((v) => [v.def.id, v.def]));

  const nav = input.nav
    .filter(({ plugin, def }) => live.has(plugin) && (def.audience !== "super-admin" || input.superAdmin))
    .map(({ def }) => navEntry(def, views))
    .filter((entry): entry is NavEntry => entry !== null)
    .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.order - b.order || a.id.localeCompare(b.id));

  const status = input.status.filter(({ plugin, item }) => live.has(plugin) && isPage(item.open)).map((s) => s.item);

  const orgs = input.orgs.slice(0, MAX_ORGS);
  if (!orgs.some((o) => o.id === input.org.id)) orgs.push(input.org);

  return {
    type: "manifest",
    contract: GUI_CONTRACT,
    release: input.release,
    locale: input.locale,
    now: input.now.toISOString(),
    gui: input.gui,
    user: { name: input.user.name ?? null, email: input.user.email ?? "" },
    org: {
      id: input.org.id,
      name: input.org.name,
      href: organizationHref(input.org.id),
      timezone: sharedTimezone(input.microgrids),
      nav,
      status,
      // Communities and microgrids belong to community management in the catalog
      // (bundled.ts); if another plugin comes to own either kind, list each kind
      // under its own owner. The path's own places stay while it is off, since the
      // gate lets reads through and the page still renders.
      places: placesOf(input, live.has("community-management")),
    },
    orgs: orgs.map((o) => ({ id: o.id, name: o.name, href: organizationHref(o.id) })),
  };
}
