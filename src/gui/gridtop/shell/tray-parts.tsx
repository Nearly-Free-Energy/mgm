/**
 * Pieces the title bar's menus share: the look of its buttons, and the
 * status items as links.
 */
import type { StatusItem } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { cx } from "../ui/cx";
import { SHEET_ROW } from "../ui/sheet";

export const TRAY_BUTTON =
  "gt:relative gt:inline-flex gt:h-9 gt:min-w-9 gt:shrink-0 gt:items-center gt:justify-center gt:gap-1.5 gt:rounded-md gt:px-2 " +
  "gt:text-dense gt:text-foreground gt:hover:bg-muted gt:pointer-coarse:h-11 gt:pointer-coarse:min-w-11 " +
  "gt:aria-expanded:bg-muted gt:focus-visible:outline-2 gt:focus-visible:outline-ring";

const STATE: Record<StatusItem["state"], { text: string; dot: string }> = {
  "needs-you": { text: "needs you", dot: "gt:bg-warning" },
  working: { text: "working", dot: "gt:bg-primary" },
  idle: { text: "idle", dot: "gt:bg-success" },
  off: { text: "off", dot: "gt:bg-subtle-foreground" },
};

/** Each status item as a link to what it opens, its state as a dot and in words. */
export function StatusLinks({ items, className }: { items: readonly StatusItem[]; className: string }) {
  const pathname = kit.usePathname();
  if (items.length === 0) return null;
  return (
    <ul aria-label="Status" className={className}>
      {items.map((item) => (
        <li key={item.id}>
          <kit.Link href={item.open} current={item.open.split(/[?#]/, 1)[0] === pathname} className={SHEET_ROW}>
            <span aria-hidden="true" className={cx("gt:size-2 gt:shrink-0 gt:rounded-pill", STATE[item.state].dot)} />
            <span className="gt:truncate">{item.label}</span>
            <span className="gt:sr-only">, {STATE[item.state].text}</span>
          </kit.Link>
        </li>
      ))}
    </ul>
  );
}
