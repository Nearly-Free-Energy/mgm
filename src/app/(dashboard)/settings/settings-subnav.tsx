"use client";

/**
 * settings-subnav.tsx — Settings sub-navigation (UX5 / #79).
 *
 * Mirrors `src/app/(dashboard)/microgrids/[id]/setup/setup-subnav.tsx`:
 *   - Pill-style tablist sitting on a bg-muted container; active tab
 *     raises onto bg-card with shadow-elev-1.
 *   - role="tablist", per-tab role="tab", aria-selected, aria-controls.
 *   - ArrowLeft / ArrowRight cycle; Home / End jump to ends.
 *   - Longest-prefix active-tab match — future nested routes under
 *     /settings/<tab>/... keep the parent tab highlighted.
 *
 * Three tabs ship: Profile (self), Users (admin-side) and Plugins
 * (org-side). Profile and Users are visible for both MVP roles
 * (super_admin + org_manager can both invite); plugin toggles are further
 * gated per organization by the plugin service. Future `microgrid_manager`
 * may need per-role visibility — not now.
 *
 * Every tab must link to a released page: the API tokens page exists under
 * /settings/api-tokens but is not in src/lib/mgm/released-routes.ts, so
 * middleware answers it with a 404 and a tab for it would lead nowhere. Add
 * the tab back when that route is released (settings-subnav.test.tsx checks
 * every tab against isReleasedRoute).
 *
 * Tabs are next/link <Link>s, so clicks and arrow keys are client-side
 * navigations: the dashboard layout and this sub-nav stay mounted while
 * settings/loading.tsx stands in for the new tab.
 *
 * Copy-paste-adapted per ticket Dev Notes ("don't extract a shared
 * <TabNav> until a third caller appears — YAGNI").
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, type KeyboardEvent } from "react";
import {
  announceNavigationStart,
  isSameTabClick,
} from "@/components/ui/navigation-progress";

type SubTab = { label: string; segment: string };

const TABS: SubTab[] = [
  { label: "Profile", segment: "profile" },
  { label: "Users", segment: "users" },
  { label: "Plugins", segment: "plugins" },
];

export function SettingsSubNav() {
  const pathname = usePathname();
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const base = "/settings";

  const activeIndex = (() => {
    const hits = TABS.map((t, i) =>
      pathname.startsWith(`${base}/${t.segment}`) ? i : -1
    ).filter((i) => i >= 0);
    if (hits.length === 0) return 0;
    return hits.reduce((best, i) =>
      TABS[i].segment.length > TABS[best].segment.length ? i : best
    );
  })();

  function onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, current: number) {
    const last = TABS.length - 1;
    let next = current;
    switch (e.key) {
      case "ArrowRight":
        next = current === last ? 0 : current + 1;
        break;
      case "ArrowLeft":
        next = current === 0 ? last : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    const el = tabRefs.current[next];
    el?.focus();
    const href = `${base}/${TABS[next].segment}`;
    if (href !== pathname) announceNavigationStart(href);
    router.push(href);
  }

  return (
    <nav
      role="tablist"
      aria-label="Settings sections"
      className="inline-flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1"
    >
      {TABS.map((tab, i) => {
        const isActive = i === activeIndex;
        const href = `${base}/${tab.segment}`;
        return (
          <Link
            key={tab.segment}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            href={href}
            role="tab"
            aria-selected={isActive}
            aria-controls="settings-panel"
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={(event) => {
              if (href !== pathname && isSameTabClick(event)) {
                announceNavigationStart(href);
              }
            }}
            className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActive
                ? "bg-card text-foreground font-semibold shadow-elev-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
