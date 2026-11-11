/**
 * One app in the dock. It opens the entry's page when the view can fill the
 * pattern: from the place in scope, or the only place of the kind it needs.
 * Otherwise it opens the place picker (./place-picker.tsx), or shows muted
 * when no pick would fill it.
 */
import type { NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { hasIcon, Icon } from "../ui/icon";
import { pickStep, PlacePicker } from "./place-picker";

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

  // Ask first whether a place still has to be picked: href alone would fill
  // a lone place even where it does not belong (pickStep says when).
  const step = pickStep(view, entry);
  const href = step ? null : view.href(entry);
  if (href) {
    return (
      <kit.Link href={href} current={current} className={style.item}>
        {icon}
        {label}
      </kit.Link>
    );
  }
  if (!step) {
    return (
      <span className={cx(style.item, "gt:text-muted-foreground")}>
        {icon}
        {label}
      </span>
    );
  }
  return (
    <PlacePicker entry={entry} kind={step.kind} className={cx(style.item, "gt:w-full")}>
      {icon}
      {label}
    </PlacePicker>
  );
}
