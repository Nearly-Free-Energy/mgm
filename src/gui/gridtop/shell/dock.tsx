/**
 * The apps, grouped Operate · Money · Configure · System. From 600 px a
 * 72 px rail with each label under its icon; from 1280 px a 64 px dock whose
 * labels show beside the icon on hover and focus. Below 600 px the bottom
 * dock takes over (./bottom-dock.tsx).
 */
import { useId } from "react";
import type { Id, NavEntry } from "@/lib/gui/contract";
import { cx } from "../ui/cx";
import { grouped } from "./groups";
import { NavItem, type NavItemStyle } from "./nav-item";

const FOCUS = "gt:focus-visible:outline-2 gt:focus-visible:outline-offset-2 gt:focus-visible:outline-ring";

export const RAIL_ITEM: NavItemStyle = {
  item: cx(
    "group gt:relative gt:flex gt:flex-col gt:items-center gt:gap-1 gt:rounded-md gt:px-1 gt:py-2 gt:text-center",
    "gt:text-caption gt:text-muted-foreground gt:hover:bg-muted gt:hover:text-foreground gt:pointer-coarse:min-h-11",
    "gt:aria-[current=page]:bg-accent gt:aria-[current=page]:text-accent-foreground gt:data-pending:opacity-70",
    FOCUS,
  ),
  icon: "gt:size-5 gt:shrink-0",
  // Beside the icon from 1280 px, shown on hover and focus. Transparent rather
  // than hidden, so it stays the link's accessible name.
  label: cx(
    "gt:expanded:pointer-events-none gt:expanded:absolute gt:expanded:top-1/2 gt:expanded:left-full gt:expanded:z-10",
    "gt:expanded:ml-2 gt:expanded:-translate-y-1/2 gt:expanded:rounded-md gt:expanded:bg-foreground gt:expanded:px-2",
    "gt:expanded:py-1 gt:expanded:whitespace-nowrap gt:expanded:text-background gt:expanded:opacity-0",
    "gt:expanded:group-hover:opacity-100 gt:expanded:group-focus-visible:opacity-100",
  ),
};

export const ROW_ITEM: NavItemStyle = {
  item: cx(
    "gt:flex gt:min-h-11 gt:items-center gt:gap-3 gt:rounded-md gt:px-3 gt:text-body gt:text-foreground",
    "gt:hover:bg-muted gt:aria-[current=page]:bg-accent gt:aria-[current=page]:text-accent-foreground",
    "gt:data-pending:opacity-70",
    FOCUS,
  ),
  icon: "gt:size-5 gt:shrink-0 gt:text-muted-foreground",
  label: "",
};

/** Every group as a list, its title shown or for screen readers only. */
export function AppGroups(props: { nav: readonly NavEntry[]; current: Id | null; style: NavItemStyle; titles: boolean }) {
  const { nav, current, style, titles } = props;
  const id = useId();
  return (
    <ul className="gt:flex gt:flex-col gt:gap-2">
      {grouped(nav).map((group) => (
        <li key={group.id} className="gt:border-t gt:border-border gt:pt-2 gt:first:border-t-0 gt:first:pt-0">
          <span
            id={`${id}-${group.id}`}
            className={titles ? "gt:block gt:px-3 gt:pb-1 gt:text-caption gt:text-muted-foreground" : "gt:sr-only"}
          >
            {group.title}
          </span>
          <ul aria-labelledby={`${id}-${group.id}`} className="gt:flex gt:flex-col gt:gap-1">
            {group.entries.map((entry) => (
              <li key={entry.id}>
                <NavItem entry={entry} current={entry.id === current} style={style} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function Dock({ nav, current }: { nav: readonly NavEntry[]; current: Id | null }) {
  return (
    <nav
      aria-label="Apps"
      className={cx(
        "gt:hidden gt:w-18 gt:overflow-y-auto gt:border-r gt:border-border gt:bg-card gt:p-1 gt:medium:block",
        // Overflow shown, so the labels beside the icons are not clipped.
        "gt:expanded:w-16 gt:expanded:overflow-visible gt:expanded:p-2",
      )}
    >
      <AppGroups nav={nav} current={current} style={RAIL_ITEM} titles={false} />
    </nav>
  );
}
