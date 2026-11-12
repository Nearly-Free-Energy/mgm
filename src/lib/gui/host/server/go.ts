import "server-only";

/**
 * Where /go/<nav> sends the signed-in person: the page of a navigation entry
 * of their manifest, filled with the places it needs. A link that names the
 * entry by id keeps working when its page moves, since a page that becomes
 * a view keeps its nav id.
 *
 * The target is only ever an entry's href pattern from the manifest, filled
 * with the encoded ids of places the manifest lists for the person, so it
 * stays a released same-origin path. Like the manifest, this authorizes
 * nothing: the page it leads to checks access itself.
 */
import { cookies, headers } from "next/headers";
import { readGuiName } from "@/lib/config/gui";
import { isReleasedRoute } from "@/lib/mgm/released-routes";
import type { CoreEntityKind } from "@/lib/plugins/bundled";
import type { EntityRef, Href, Manifest, NavEntry } from "../../contract";
import { isSameOriginPath } from "../shared/href";
import { manifestHints } from "../shared/manifest-hints";
import { getManifest } from "./manifest";

export type GoLink = { label: string; href: Href };

export type GoTarget =
  | { kind: "not-found" }
  | { kind: "redirect"; href: Href }
  /** Several places fit: the person picks one. */
  | { kind: "choose"; title: string; needs: CoreEntityKind[]; choices: GoLink[] }
  /**
   * No place fits. `missing` is the first needed kind the manifest has no
   * place of, or null when it has places of every kind but none that open
   * the entry together. `listed` says whether `missing` is a kind the
   * manifest can list as places (communities, microgrids), so adding one is
   * the next step; `list` is the page that lists them, when the manifest
   * offers it.
   */
  | {
      kind: "none";
      title: string;
      needs: CoreEntityKind[];
      missing: CoreEntityKind | null;
      listed: boolean;
      list: GoLink | null;
    };

type Place = Manifest["org"]["places"][number];

/**
 * The pages that list each kind of place, as the manifest's nav writes them.
 * Community management serves both (bundled.ts); if either page moves, revisit.
 */
const PLACE_LISTS: Partial<Record<CoreEntityKind, string>> = { community: "/communities", microgrid: "/microgrids" };

/**
 * Whether `place` belongs with the places already chosen: a microgrid goes
 * only with its own community. The same rule as Gridtop's place picker
 * (pickStep in src/gui/gridtop/shell/place-picker.tsx). OrgManifest.places
 * gives `parent` only as a microgrid's community id; if it names other
 * kinds, revisit.
 */
function fits(places: readonly Place[], place: EntityRef, chosen: readonly EntityRef[]): boolean {
  const parent = (ref: EntityRef) => places.find((p) => p.kind === ref.kind && p.id === ref.id)?.parent;
  const mine = parent(place);
  return chosen.every((other) => {
    const theirs = parent(other);
    return (
      (other.kind !== "community" || mine === undefined || mine === other.id) &&
      (place.kind !== "community" || theirs === undefined || theirs === place.id)
    );
  });
}

/** Every set of places, one of each kind in `kinds`, that belong together. */
function combinations(places: readonly Place[], kinds: readonly CoreEntityKind[], chosen: EntityRef[] = []): EntityRef[][] {
  if (kinds.length === chosen.length) return [chosen];
  const kind = kinds[chosen.length];
  return places
    .filter((p) => p.kind === kind && fits(places, p, chosen))
    .flatMap((p) => combinations(places, kinds, [...chosen, p]));
}

/** The entry's pattern with each [kind] filled: the organization from the manifest, the rest from `picked`. */
function fill(manifest: Manifest, entry: NavEntry, picked: readonly EntityRef[]): Href | null {
  let missing = false;
  const filled = entry.href.replace(/\[([^\]/]+)\]/g, (_, kind: string) => {
    const id = kind === "organization" ? manifest.org.id : picked.find((p) => p.kind === kind)?.id;
    if (id === undefined) missing = true;
    return encodeURIComponent(id ?? "");
  });
  return !missing && isSameOriginPath(filled) && isReleasedRoute(filled) ? (filled as Href) : null;
}

/**
 * Where `navId` leads in `manifest`. Pure, so it is tested without a request.
 * `requested` is the request's `?org=`, as manifestHints reads it.
 */
export function goTarget(manifest: Manifest, navId: string, requested: string | null = null): GoTarget {
  const entry = manifest.org.nav.find((e) => e.id === navId);
  if (!entry) return { kind: "not-found" };
  const needs = entry.needs.filter((kind) => kind !== "organization");
  const choices = combinations(manifest.org.places, needs).flatMap((picked) => {
    const href = fill(manifest, entry, picked);
    return href ? [{ label: picked.map((p) => p.label).join(" › "), href }] : [];
  });
  if (needs.length === 0) {
    if (!choices[0]) return { kind: "not-found" };
    // A page with no organization in its path opens in the one the (gui)
    // layout picks: `?org=` before the cookie (manifest-hints.ts). Keep the
    // one `?org=` chose here, as view.ts does for attached views; if that
    // order changes, revisit.
    const keep = !entry.needs.includes("organization") && requested === manifest.org.id;
    const href = keep ? (`${choices[0].href}?org=${encodeURIComponent(manifest.org.id)}` as Href) : choices[0].href;
    return { kind: "redirect", href };
  }
  if (choices.length === 1) return { kind: "redirect", href: choices[0].href };
  if (choices.length > 1) return { kind: "choose", title: entry.title, needs, choices };
  const missing = needs.find((kind) => !manifest.org.places.some((p) => p.kind === kind)) ?? null;
  const listHref = missing === null ? undefined : PLACE_LISTS[missing];
  const listEntry = manifest.org.nav.find((e) => e.needs.length === 0 && e.href === listHref);
  return {
    kind: "none",
    title: entry.title,
    needs,
    missing,
    listed: listHref !== undefined,
    list: listEntry ? { label: listEntry.title, href: listEntry.href } : null,
  };
}

/**
 * Where `navId` leads for this request's signed-in person. It reads the
 * manifest the (gui) layout reads, with the same hints, so the two share one
 * read; getManifest reads the session with getUser() first. A person the
 * manifest refuses goes where the layout sends them.
 */
export async function resolveGoTarget(navId: string): Promise<GoTarget> {
  const [requestHeaders, requestCookies] = await Promise.all([headers(), cookies()]);
  const { path, requested, preferred } = manifestHints(requestHeaders, requestCookies);
  const outcome = await getManifest(readGuiName(), path, requested, preferred);
  if (!outcome.ok) return { kind: "redirect", href: (outcome.status === 401 ? "/login" : "/no-access") as Href };
  return goTarget(outcome.manifest, navId, requested);
}
