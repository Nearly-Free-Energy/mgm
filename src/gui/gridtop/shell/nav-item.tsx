/**
 * One app in the dock. It opens the entry's page when the view can fill the
 * pattern: from the place in scope, or the only place of the kind it needs.
 * Otherwise it opens the list to choose a place from. The place picker that
 * replaces this list link comes with Gridtop's sheets.
 */
import type { CoreEntityKind, Href, NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { hasIcon, Icon } from "../ui/icon";

/**
 * The pages that list each kind of place. Community management serves both,
 * and every plugin whose pages need a place depends on it (bundled.ts), so
 * the list is on whenever such an entry is. If that dependency goes, revisit.
 */
const PLACE_LISTS: Partial<Record<CoreEntityKind, Href>> = { microgrid: "/microgrids", community: "/communities" };

export interface NavItemStyle {
  item: string;
  icon: string;
  /** Applied only when the entry has a known icon, so an unknown one keeps its label in view. */
  label: string;
}

export function NavItem({ entry, current, style }: { entry: NavEntry; current: boolean; style: NavItemStyle }) {
  const view = kit.useView();
  const label = <span className={cx("gt:min-w-0", hasIcon(entry.icon) && style.label)}>{entry.title}</span>;
  const icon = <Icon name={entry.icon} className={style.icon} />;

  const href = view.href(entry);
  if (href) {
    return (
      <kit.Link href={href} current={current} className={style.item}>
        {icon}
        {label}
      </kit.Link>
    );
  }
  const kind = entry.needs.find((k) => !view.scope[k]);
  const list = kind && PLACE_LISTS[kind];
  if (!list) {
    return (
      <span className={cx(style.item, "gt:text-muted-foreground")}>
        {icon}
        {label}
      </span>
    );
  }
  return (
    <kit.Link href={list} current={current} className={style.item}>
      {icon}
      {label}
      <span className="gt:sr-only">, choose a {kind}</span>
    </kit.Link>
  );
}
