/**
 * An app that needs a place the page does not name, when the organization
 * has none or several of that kind: the entry opens a sheet listing the
 * places, and each one links to the app inside it. With none, the sheet
 * says so and links to the list of that kind when the manifest offers it.
 */
import type { ReactNode } from "react";
import type { CoreEntityKind, Href, NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { SHEET_ROW, Sheet } from "../ui/sheet";

/**
 * The pages that list each kind of place, as the manifest's nav writes them.
 * Community management serves both, and every plugin whose pages need a place
 * depends on it (bundled.ts); the link shows only while the manifest has the
 * entry. If either page moves, revisit.
 */
const PLACE_LISTS: Partial<Record<CoreEntityKind, Href>> = { microgrid: "/microgrids", community: "/communities" };

export function PlacePicker(props: { entry: NavEntry; kind: CoreEntityKind; className: string; children: ReactNode }) {
  const { entry, kind, className, children } = props;
  const view = kit.useView();
  const many = kind === "community" ? "communities" : `${kind}s`;
  const choices = view.choices(kind).flatMap((place) => {
    const href = view.href(entry, { [kind]: place });
    return href ? [{ place, href }] : [];
  });
  const listEntry = view.org.nav.find((e) => e.href === PLACE_LISTS[kind]);
  const list = listEntry && view.href(listEntry);
  return (
    <Sheet
      title={`${entry.title}: choose a ${kind}`}
      trigger={
        <button type="button" className={className}>
          {children}
          <span className="gt:sr-only">, choose a {kind}</span>
        </button>
      }
    >
      {choices.length > 0 ? (
        <ul className="gt:flex gt:flex-col gt:gap-1">
          {choices.map(({ place, href }) => (
            <li key={place.id}>
              <kit.Link href={href} className={SHEET_ROW}>
                {place.label}
              </kit.Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="gt:flex gt:flex-col gt:gap-2 gt:px-1">
          <p className="gt:text-body gt:text-muted-foreground">No {many} yet.</p>
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
