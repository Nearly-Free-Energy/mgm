/**
 * Which place an app still needs picked, shared by the place picker
 * (./place-picker.tsx) and the command palette (../palette/grammar.ts). Pure,
 * so the palette's grammar stays testable without React.
 */
import type { CoreEntityKind, EntityRef, NavEntry, ViewState } from "@/lib/gui/contract";

export type Picked = Partial<Record<CoreEntityKind, EntityRef>>;
export interface PickStep {
  kind: CoreEntityKind;
  /** The places already settled for this entry: from scope, picked, or the only one of their kind. */
  chosen: Picked;
  places: EntityRef[];
}

/** OrgManifest.places gives `parent` only as a microgrid's community id; if it names other kinds, revisit. */
function fits(view: ViewState, place: EntityRef, chosen: Picked): boolean {
  const parent = (ref: EntityRef) => view.org.places.find((p) => p.kind === ref.kind && p.id === ref.id)?.parent;
  return Object.values(chosen).every((other) => {
    const mine = parent(place);
    const theirs = parent(other);
    return (other.kind !== "community" || mine === undefined || mine === other.id) && (place.kind !== "community" || theirs === undefined || theirs === place.id);
  });
}

/**
 * The next place this entry needs the person to pick, or null when it needs
 * none. A kind with only one place is taken without asking, as
 * ViewState.href takes it (fillNavHref in host/client/kit-provider.tsx), but
 * only when that place belongs with the others; it fills the organization
 * from the manifest, so that is never asked for. If either changes, revisit.
 * Link to view.href(entry, …) only once this returns null for the same
 * places: href alone would fill a lone place that does not belong.
 */
export function pickStep(view: ViewState, entry: NavEntry, picked: Picked = {}): PickStep | null {
  const chosen: Picked = {};
  for (const kind of entry.needs) {
    const known = view.scope[kind] ?? picked[kind];
    if (known) chosen[kind] = known;
  }
  for (const kind of entry.needs) {
    if (kind === "organization" || chosen[kind]) continue;
    const all = view.choices(kind);
    // The only place is taken only when it belongs with the places already
    // settled: ViewState.href would fill it regardless, and pair a community
    // with another community's microgrid.
    if (all.length === 1 && fits(view, all[0], chosen)) {
      chosen[kind] = all[0];
      continue;
    }
    return { kind, chosen, places: all.filter((place) => fits(view, place, chosen)) };
  }
  return null;
}
