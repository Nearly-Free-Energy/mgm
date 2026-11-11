/**
 * An app that needs a place the page does not name, when the organization
 * has none or several of that kind: the entry opens a sheet listing the
 * places, and each one links to the app inside it. An app that needs two
 * places asks for them in turn, in the order of its pattern: a place whose
 * link still lacks the next one leads to that pick. With none, the sheet
 * says so and links to the list of that kind when the manifest offers it.
 */
import { useState, type ReactNode } from "react";
import type { CoreEntityKind, EntityRef, Href, NavEntry, ViewState } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { SHEET_ROW, Sheet } from "../ui/sheet";

/**
 * The pages that list each kind of place, as the manifest's nav writes them.
 * Community management serves both, and every plugin whose pages need a place
 * depends on it (bundled.ts); the link shows only while the manifest has the
 * entry. If either page moves, revisit.
 */
const PLACE_LISTS: Partial<Record<CoreEntityKind, Href>> = { microgrid: "/microgrids", community: "/communities" };

type Picked = Partial<Record<CoreEntityKind, EntityRef>>;
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

export function PlacePicker(props: { entry: NavEntry; kind: CoreEntityKind; className: string; children: ReactNode }) {
  const { entry, className, children } = props;
  const view = kit.useView();
  const [picked, setPicked] = useState<Picked>({});
  const step = pickStep(view, entry, picked);
  const kind = step?.kind ?? props.kind;
  const many = (k: CoreEntityKind) => (k === "community" ? "communities" : `${k}s`);
  // The community the places are listed in, when one is settled.
  const inCommunity = kind !== "community" ? step?.chosen.community : undefined;
  const listEntry = view.org.nav.find((e) => e.href === PLACE_LISTS[kind]);
  const list = listEntry && view.href(listEntry);
  return (
    <Sheet
      title={`${entry.title}: choose a ${kind}${inCommunity ? ` in ${inCommunity.label}` : ""}`}
      trigger={
        // Each opening starts again from the first pick.
        <button type="button" className={className} onClick={() => setPicked({})}>
          {children}
          <span className="gt:sr-only">, choose a {props.kind}</span>
        </button>
      }
    >
      {step && step.places.length > 0 ? (
        <ul className="gt:flex gt:flex-col gt:gap-1">
          {step.places.map((place) => {
            const pick = { ...step.chosen, [step.kind]: place };
            const next = pickStep(view, entry, pick);
            const href = next ? null : view.href(entry, pick);
            return (
              <li key={place.id}>
                {href ? (
                  <kit.Link href={href} className={SHEET_ROW}>
                    {place.label}
                  </kit.Link>
                ) : next ? (
                  <button type="button" className={SHEET_ROW} onClick={() => setPicked(pick)}>
                    {place.label}
                    <span className="gt:sr-only">, then choose a {next.kind}</span>
                  </button>
                ) : (
                  <span className={cx(SHEET_ROW, "gt:text-muted-foreground")}>{place.label}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="gt:flex gt:flex-col gt:gap-2 gt:px-1">
          <p className="gt:text-body gt:text-muted-foreground">
            No {many(kind)}
            {inCommunity ? ` in ${inCommunity.label}` : ""} yet.
          </p>
          {list && (
            <kit.Link href={list} className={SHEET_ROW}>
              {listEntry.title}
            </kit.Link>
          )}
        </div>
      )}
    </Sheet>
  );
}
