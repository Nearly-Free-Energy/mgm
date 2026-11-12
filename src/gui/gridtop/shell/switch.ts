/**
 * What the context path shows: the trail's crumbs, each with the kind of
 * place it names, and for each place the others of its kind the person can
 * switch to. Every href comes from the manifest or ViewState.href, and a
 * switch never pairs a place with another that does not belong with it.
 */
import type { CoreEntityKind, EntityRef, Href, Id, Manifest, NavEntry, ViewState } from "@/lib/gui/contract";

export type PlaceKind = "organization" | "community" | "microgrid";
export interface Crumb {
  label: string;
  href: Href;
  /** The place the crumb names, or null for an app or a deeper page. */
  kind: PlaceKind | null;
}
export interface Choice {
  id: string;
  label: string;
  /** Null when there is no page to open for it. */
  href: Href | null;
  /** The place the page is in. */
  current: boolean;
  detail?: string;
}
export interface Switcher {
  kind: PlaceKind;
  title: string;
  groups: { title: string; choices: Choice[] }[];
}

type Place = ViewState["org"]["places"][number];

const PLURAL: Record<PlaceKind, string> = { organization: "organizations", community: "communities", microgrid: "microgrids" };
export const counted = (n: number, kind: PlaceKind) => `${n} ${n === 1 ? kind : PLURAL[kind]}`;

/**
 * The trail, each crumb marked with the place it names when its href is that
 * place's in the scope. With several organizations and no organization
 * crumb, the organization comes first, so its switcher is always there.
 */
export function crumbsOf(view: ViewState, manifest: Manifest): Crumb[] {
  const kindOf = (href: Href): PlaceKind | null => {
    if (href === manifest.org.href) return "organization";
    for (const kind of ["community", "microgrid"] as const) if (view.scope[kind]?.href === href) return kind;
    return null;
  };
  const crumbs: Crumb[] = view.trail.map((crumb) => ({ label: crumb.label, href: crumb.href, kind: kindOf(crumb.href) }));
  if (manifest.orgs.length > 1 && !crumbs.some((c) => c.kind === "organization")) {
    crumbs.unshift({ label: manifest.org.name, href: manifest.org.href, kind: "organization" });
  }
  return crumbs;
}

/**
 * The page a switch to `place` opens: the current app inside the new place
 * when the app needs a place of that kind, or the place's own page. The app
 * is filled from the new place alone, plus a microgrid's own community when
 * the app needs one too; any other place in scope may not belong with the
 * new one, so an app that needs one falls back to the place's page.
 */
export function switchHref(view: ViewState, app: NavEntry | null, place: Place): Href | null {
  const kind = place.kind as CoreEntityKind;
  if (app?.needs.includes(kind)) {
    const pick: Partial<Record<CoreEntityKind, EntityRef>> = { [kind]: place };
    let fits = true;
    for (const need of app.needs) {
      if (need === "organization" || pick[need]) continue;
      const parent =
        need === "community" && kind === "microgrid"
          ? view.org.places.find((p) => p.kind === "community" && p.id === place.parent)
          : undefined;
      if (!parent) fits = false;
      else pick.community = parent;
    }
    const kept = fits ? view.href(app, pick) : null;
    if (kept) return kept;
  }
  return place.href ?? null;
}

/** The switcher for a crumb's place, or null when there is nothing else to switch to. */
export function switcherFor(kind: PlaceKind, view: ViewState, manifest: Manifest, appId: Id | null): Switcher | null {
  const app = view.org.nav.find((entry) => entry.id === appId) ?? null;
  if (kind === "organization") {
    if (manifest.orgs.length < 2) return null;
    const choices = manifest.orgs.map((o) => ({ id: o.id, label: o.name, href: o.href, current: o.id === manifest.org.id }));
    return { kind, title: "Organizations", groups: [{ title: counted(choices.length, kind), choices }] };
  }
  const places = view.org.places.filter((p) => p.kind === kind);
  if (places.length < 2) return null;
  const here = view.scope[kind]?.id;
  const choice = (p: Place, detail?: string): Choice => ({
    id: p.id,
    label: p.label,
    href: switchHref(view, app, p),
    current: p.id === here,
    ...(detail ? { detail } : {}),
  });
  if (kind === "community") {
    const microgrids = (id: string) => view.org.places.filter((p) => p.kind === "microgrid" && p.parent === id).length;
    const choices = places.map((p) => choice(p, counted(microgrids(p.id), "microgrid")));
    return { kind, title: "Communities", groups: [{ title: counted(choices.length, kind), choices }] };
  }
  // Microgrids in the same community as this one come first.
  const community = view.org.places.find((p) => p.kind === "microgrid" && p.id === here)?.parent ?? view.scope.community?.id;
  const label = view.org.places.find((p) => p.kind === "community" && p.id === community)?.label;
  const siblings = places.filter((p) => community !== undefined && p.parent === community);
  const others = places.filter((p) => !siblings.includes(p));
  if (!label || siblings.length === 0 || others.length === 0) {
    const all = [...siblings, ...others].map((p) => choice(p));
    return { kind, title: "Microgrids", groups: [{ title: counted(all.length, kind), choices: all }] };
  }
  return {
    kind,
    title: "Microgrids",
    groups: [
      { title: `${counted(siblings.length, kind)} in ${label}`, choices: siblings.map((p) => choice(p)) },
      { title: `${counted(others.length, kind)} in other communities`, choices: others.map((p) => choice(p)) },
    ],
  };
}
