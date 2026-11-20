/**
 * The phone dock, below 600 px: three pinned apps and More, which opens
 * every group in a sheet. On a tenant's manifest (RFC mgm#197 § 4) it pins
 * the tenant's apps, then the account menu in the third column, and More
 * only when some app is not pinned; the tray hides its own account menu
 * below 600 px there (./tray.tsx), so one shows at any width. A person with
 * staff and tenant rows gets a staff manifest and the staff dock.
 */
import { Ellipsis } from "lucide-react";
import type { Id, NavEntry } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { Sheet } from "../ui/sheet";
import { AppGroups, ROW_ITEM } from "./dock";
import { isTenantManifest, PINNED, pinned, TENANT_PINNED } from "./groups";
import { NavItem, type NavItemStyle } from "./nav-item";
import { UserMenu } from "./user-menu";

/** One dock column's control; the account menu's dock trigger uses it too. */
export const TAB =
  "gt:flex gt:h-14 gt:w-full gt:flex-col gt:items-center gt:justify-center gt:gap-0.5 gt:px-1 gt:text-caption " +
  "gt:text-muted-foreground gt:hover:text-foreground gt:aria-[current=page]:text-primary gt:aria-expanded:text-primary " +
  "gt:data-pending:opacity-70 gt:focus-visible:outline-2 gt:focus-visible:outline-offset-[-2px] gt:focus-visible:outline-ring";

const PINNED_ITEM: NavItemStyle = { item: TAB, icon: "gt:size-5 gt:shrink-0", label: "gt:max-w-full gt:truncate" };

export function BottomDock({ nav, current }: { nav: readonly NavEntry[]; current: Id | null }) {
  const tenant = isTenantManifest(kit.useManifest());
  const pins = pinned(nav, tenant ? TENANT_PINNED : PINNED);
  // Everything offered stays reachable: More returns for a tenant once an app is not pinned.
  const more = !tenant || nav.some((entry) => !pins.includes(entry));
  return (
    <nav aria-label="Apps" className="gt:border-t gt:border-border gt:bg-card gt:pb-[env(safe-area-inset-bottom)] gt:medium:hidden">
      <ul className="gt:grid gt:grid-cols-4">
        {pins.map((entry) => (
          <li key={entry.id} className="gt:min-w-0">
            <NavItem entry={entry} current={entry.id === current} style={PINNED_ITEM} />
          </li>
        ))}
        {tenant && (
          <li className="gt:col-start-3 gt:min-w-0">
            <UserMenu place="dock" className={TAB} />
          </li>
        )}
        {more && (
          <li className="gt:col-start-4 gt:min-w-0">
            <Sheet
              title="All apps"
              trigger={
                <button type="button" className={TAB}>
                  <Ellipsis aria-hidden="true" focusable="false" className="gt:size-5 gt:shrink-0" />
                  <span>More</span>
                </button>
              }
            >
              <AppGroups nav={nav} current={current} style={ROW_ITEM} titles />
            </Sheet>
          </li>
        )}
      </ul>
    </nav>
  );
}
