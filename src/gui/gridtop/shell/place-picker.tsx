/**
 * An app that needs a place the page does not name, when the organization
 * has none or several of that kind: the entry opens a sheet listing the
 * places, and each one links to the app inside it. An app that needs two
 * places asks for them in turn, in the order of its pattern: a place whose
 * link still lacks the next one leads to that pick. With none, the sheet
 * says so and links to the list of that kind when the manifest offers it.
 */
import { useState, type ReactNode } from "react";
import type { CoreEntityKind, Href, NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { SHEET_ROW, Sheet } from "../ui/sheet";
import { pickStep, type Picked } from "./pick-step";

/**
 * The pages that list each kind of place, as the manifest's nav writes them.
 * Community management serves both, and every plugin whose pages need a place
 * depends on it (bundled.ts); the link shows only while the manifest has the
 * entry. If either page moves, revisit.
 */
const PLACE_LISTS: Partial<Record<CoreEntityKind, Href>> = { microgrid: "/microgrids", community: "/communities" };

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
