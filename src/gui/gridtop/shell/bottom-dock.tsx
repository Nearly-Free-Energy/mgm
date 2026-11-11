/**
 * The phone dock, below 600 px: three pinned apps and More. More opens every
 * group above the dock; the sheet that replaces this panel comes with
 * Gridtop's sheets. The panel follows More in the page's order, so Tab
 * moves from More into it; Escape closes it and puts focus back on More. It
 * is open for one pathname only, so it closes when the page changes and
 * stays closed on coming back, and following any link in the dock in the
 * same tab closes it.
 */
import { Ellipsis } from "lucide-react";
import { useId, useRef, useState, type MouseEvent } from "react";
import type { Id, NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { AppGroups, ROW_ITEM } from "./dock";
import { pinned } from "./groups";
import { NavItem, type NavItemStyle } from "./nav-item";

const TAB =
  "gt:flex gt:h-14 gt:w-full gt:flex-col gt:items-center gt:justify-center gt:gap-0.5 gt:px-1 gt:text-caption " +
  "gt:text-muted-foreground gt:hover:text-foreground gt:aria-[current=page]:text-primary gt:aria-expanded:text-primary " +
  "gt:data-pending:opacity-70 gt:focus-visible:outline-2 gt:focus-visible:outline-offset-[-2px] gt:focus-visible:outline-ring";

const PINNED_ITEM: NavItemStyle = { item: TAB, icon: "gt:size-5 gt:shrink-0", label: "gt:max-w-full gt:truncate" };

/** A plain left click, which follows a link in this tab; a modified one opens a new tab or window. */
const sameTab = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export function BottomDock({ nav, current }: { nav: readonly NavEntry[]; current: Id | null }) {
  const pathname = kit.usePathname();
  // Open for one pathname only, so a navigation closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  // Forgotten once the page changes, so coming back does not reopen it.
  if (openOn !== null && openOn !== pathname) setOpenOn(null);
  const open = openOn === pathname;
  const panel = useId();
  const more = useRef<HTMLButtonElement>(null);
  return (
    <nav
      aria-label="Apps"
      className="gt:relative gt:border-t gt:border-border gt:bg-card gt:pb-[env(safe-area-inset-bottom)] gt:medium:hidden"
      // A link to the page already shown changes no pathname, so following any
      // link in the dock, in the panel or a pinned tab, closes the panel too.
      onClick={(event) => sameTab(event) && (event.target as Element).closest("a[href]") && setOpenOn(null)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        setOpenOn(null);
        more.current?.focus();
      }}
    >
      <ul className="gt:grid gt:grid-cols-4">
        {pinned(nav).map((entry) => (
          <li key={entry.id} className="gt:min-w-0">
            <NavItem entry={entry} current={entry.id === current} style={PINNED_ITEM} />
          </li>
        ))}
        <li className="gt:col-start-4 gt:min-w-0">
          <button
            ref={more}
            type="button"
            className={TAB}
            aria-expanded={open}
            aria-controls={open ? panel : undefined}
            onClick={() => setOpenOn(open ? null : pathname)}
          >
            <Ellipsis aria-hidden="true" focusable="false" className="gt:size-5 gt:shrink-0" />
            <span>More</span>
          </button>
        </li>
      </ul>
      {open && (
        <div
          id={panel}
          className="gt:absolute gt:inset-x-0 gt:bottom-full gt:max-h-[70vh] gt:supports-[height:100dvh]:max-h-[70dvh] gt:overflow-y-auto gt:border-t gt:border-border gt:bg-card gt:p-3"
        >
          <AppGroups nav={nav} current={current} style={ROW_ITEM} titles />
        </div>
      )}
    </nav>
  );
}
