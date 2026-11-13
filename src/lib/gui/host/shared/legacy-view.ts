/**
 * The title, trail, scope and current app of a page served outside the GUI
 * contract (a catalog page in bundled.ts without `servedBy: "view"`),
 * derived from its path and the manifest the caller already holds
 * (decision 11 on #115). No page is wrapped.
 *
 * This authorizes nothing and looks nothing up. The path may come from an
 * x-mgm-path header on a render middleware did not see, so it is untrusted:
 * every label and href returned comes from the manifest, and an id in the
 * path only picks among the places the manifest already lists. An id the
 * manifest does not list sets `unplaced` and yields no label. Callers that
 * act on the path re-check membership on the server.
 */
import { MGM_BUNDLED_PLUGINS, matchCatalogPage, type BundledPlugin, type CoreEntityKind } from "@/lib/plugins/bundled";
import type { EntityRef, Href, Id, InitialView, NavEntry, OrgManifest, Trail } from "../../contract";

export interface LegacyView extends InitialView {
  view: null;
  /** The nav entry whose pattern is the longest prefix of the path, or null. */
  nav: Id | null;
  /** The path names an organization, community or microgrid the manifest does not hold. */
  unplaced: boolean;
}

type PlaceKind = "organization" | "community" | "microgrid";
const PLACE_KINDS: readonly CoreEntityKind[] = ["organization", "community", "microgrid"];

/** The catalog page's segments, with each bracketed one's kind and decoded value. */
type ParsedPath = { segments: string[]; kinds: (CoreEntityKind | null)[]; ids: (string | null)[] };

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePath(path: string, plugins: readonly BundledPlugin[]): ParsedPath | null {
  if (!path.startsWith("/")) return null;
  const match = matchCatalogPage(path, plugins);
  if (!match || match.page.servedBy === "view") return null;
  const parsed: ParsedPath = { segments: match.page.path.split("/").filter(Boolean), kinds: [], ids: [] };
  for (const segment of parsed.segments) {
    const name = /^\[(.+)\]$/.exec(segment)?.[1];
    const id = name === undefined ? null : decode(match.values[name]);
    if (name !== undefined && id === null) return null;
    parsed.kinds.push(name === undefined ? null : match.page.params[name]);
    parsed.ids.push(id);
  }
  return parsed;
}

/**
 * The deepest organization, community or microgrid a catalog page's path
 * names, decoded, or null. Only a hint: the caller resolves it for the
 * person before using it.
 */
export function entityFromPath(
  pathname: string,
  plugins: readonly BundledPlugin[] = MGM_BUNDLED_PLUGINS,
): { kind: PlaceKind; id: string } | null {
  const parsed = parsePath(pathname, plugins);
  if (!parsed) return null;
  for (let i = parsed.kinds.length - 1; i >= 0; i--) {
    const kind = parsed.kinds[i];
    if (kind && PLACE_KINDS.includes(kind)) return { kind: kind as PlaceKind, id: parsed.ids[i]! };
  }
  return null;
}

const refOf = ({ kind, id, label, href }: EntityRef): EntityRef => ({ kind, id, label, ...(href ? { href } : {}) });

/** Null when the path is not a catalog page served outside the contract. */
export function legacyView(
  pathWithQuery: string,
  manifest: { org: OrgManifest },
  plugins: readonly BundledPlugin[] = MGM_BUNDLED_PLUGINS,
): LegacyView | null {
  const parsed = parsePath(pathWithQuery, plugins);
  if (!parsed) return null;
  const { org } = manifest;
  const placeOf = (kind: CoreEntityKind, id: string | undefined) =>
    org.places.find((p) => p.kind === kind && p.id === id);

  const scope: LegacyView["scope"] = { organization: { kind: "organization", id: org.id, label: org.name, href: org.href } };
  let unplaced = false;
  parsed.kinds.forEach((kind, i) => {
    if (kind === "organization") {
      unplaced ||= parsed.ids[i] !== org.id;
    } else if (kind === "community" || kind === "microgrid") {
      const place = placeOf(kind, parsed.ids[i]!);
      if (place) scope[kind] = refOf(place);
      else unplaced = true;
    }
  });
  // A microgrid's page names only the microgrid; its community is the place's parent.
  if (scope.microgrid && !scope.community) {
    const community = placeOf("community", placeOf("microgrid", scope.microgrid.id)?.parent);
    if (community) scope.community = refOf(community);
  }

  const nav = currentApp(org.nav, parsed);
  // Filled only from ids the manifest holds, at the path's own positions.
  const filled = nav && fill(nav, parsed, scope);

  const trail: Trail = [{ label: org.name, href: org.href }];
  for (const kind of ["community", "microgrid"] as const) {
    const ref = scope[kind];
    if (ref?.href) trail.push({ label: ref.label, href: ref.href });
  }
  if (nav && filled && trail[trail.length - 1].href !== filled) trail.push({ label: nav.title, href: filled });

  return {
    view: null,
    title: nav?.title ?? trail[trail.length - 1].label,
    trail,
    tabs: [],
    scope,
    nav: nav?.id ?? null,
    unplaced,
  };
}

/**
 * What the shell shows for any path under the (gui) layout: legacyView's
 * answer, or, for a path that is no catalog page served outside the contract
 * (a not-found page, or a page a view serves before the host renders views),
 * the organization alone.
 */
export function resolveLegacyView(
  pathWithQuery: string,
  manifest: { org: OrgManifest },
  plugins: readonly BundledPlugin[] = MGM_BUNDLED_PLUGINS,
): InitialView & { unplaced: boolean } {
  const view = legacyView(pathWithQuery, manifest, plugins);
  if (view) return view;
  const { org } = manifest;
  return {
    view: null,
    title: org.name,
    trail: [{ label: org.name, href: org.href }],
    tabs: [],
    scope: { organization: { kind: "organization", id: org.id, label: org.name, href: org.href } },
    unplaced: false,
  };
}

/** The entry whose pattern is the longest segment prefix of the path; "/" matches only itself. */
function currentApp(nav: readonly NavEntry[], parsed: ParsedPath): NavEntry | null {
  let best: { entry: NavEntry; length: number } | null = null;
  for (const entry of nav) {
    const pattern = entry.href.split(/[?#]/, 1)[0].split("/").filter(Boolean);
    if (pattern.length > parsed.segments.length) continue;
    if (pattern.length === 0 && parsed.segments.length > 0) continue;
    const fits = pattern.every((segment, i) => {
      const kind = /^\[(.+)\]$/.exec(segment)?.[1];
      return kind === undefined ? parsed.kinds[i] === null && segment === parsed.segments[i] : parsed.kinds[i] === kind;
    });
    if (fits && (!best || pattern.length > best.length)) best = { entry, length: pattern.length };
  }
  return best?.entry ?? null;
}

function fill(entry: NavEntry, parsed: ParsedPath, scope: LegacyView["scope"]): Href | null {
  const pattern = entry.href.split("/");
  const out: string[] = [];
  for (const [i, segment] of pattern.entries()) {
    const kind = /^\[(.+)\]$/.exec(segment)?.[1] as CoreEntityKind | undefined;
    if (kind === undefined) {
      out.push(segment);
      continue;
    }
    const ref = scope[kind];
    // pattern[0] is "" before the leading slash, so segment i is the path's i - 1.
    if (!ref || ref.id !== parsed.ids[i - 1]) return null;
    out.push(encodeURIComponent(ref.id));
  }
  return out.join("/") as Href;
}
