/**
 * One app in the dock. It opens the entry's page when the view can fill the
 * pattern: from the place in scope, or the only place of the kind it needs.
 * Otherwise it opens the place picker (./place-picker.tsx).
 */
import type { NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { hasIcon, Icon } from "../ui/icon";
import { PlacePicker } from "./place-picker";

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
  // ViewState.href fills the organization from the manifest (fillNavHref in
  // host/client/kit-provider.tsx), so it is never the place missing; if that changes, revisit.
  const kind = entry.needs.find((k) => !view.scope[k] && k !== "organization");
  if (!kind) {
    return (
      <span className={cx(style.item, "gt:text-muted-foreground")}>
        {icon}
        {label}
      </span>
    );
  }
  return (
    <PlacePicker entry={entry} kind={kind} className={cx(style.item, "gt:w-full")}>
      {icon}
      {label}
    </PlacePicker>
  );
}
