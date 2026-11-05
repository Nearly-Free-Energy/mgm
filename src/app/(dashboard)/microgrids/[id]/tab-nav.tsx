"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  announceNavigationStart,
  isSameTabClick,
} from "@/components/ui/navigation-progress";
import { microgridHref, microgridSetupHref } from "@/lib/microgrid-links";

// Microgrid tab nav (D2 / #53).
//
// Tab order (Dashboard | Billing | Setup) mirrors the operator workflow:
//   1. Dashboard — landing / daily orientation.
//   2. Billing    — the monthly close job (primary working surface).
//   3. Setup      — configure-once (edges, households, rate schedule).
//
// Tabs are next/link <Link>s so a click is a client-side navigation: the
// dashboard layout and this microgrid header stay mounted, and
// [id]/loading.tsx shows while the new tab renders.
//
// Each tab links to the page a click lands on (src/lib/microgrid-links.ts),
// not to a URL that redirects:
//   - Dashboard links to the household list, where middleware sends the
//     microgrid index. It therefore never highlights while that redirect
//     exists; if the index renders again, link Dashboard back to `base`.
//   - Setup links to its first sub-tab rather than the /setup index.
//
// Active-tab match:
//   - Dashboard is the microgrid index (/microgrids/[id]) with no child segment.
//     A raw `startsWith` on the index href would also match /billing and /setup.
//     We detect "on the index" by requiring the URL to end at the microgrid id.
//   - Billing + Setup use `startsWith` so their nested routes stay highlighted.

const tabs = [
  { label: "Dashboard", segment: "",        href: microgridHref },
  { label: "Billing",   segment: "billing", href: (id: string) => `/microgrids/${id}/billing` },
  { label: "Setup",     segment: "setup",   href: microgridSetupHref },
] as const;

export function TabNav({ microgridId }: { microgridId: string }) {
  const pathname = usePathname();
  const base = `/microgrids/${microgridId}`;

  return (
    <nav
      className="flex space-x-1 border-b border-border"
      role="tablist"
      aria-label="Microgrid sections"
    >
      {tabs.map((tab) => {
        const href = tab.href(microgridId);
        const isActive = tab.segment
          ? pathname.startsWith(`${base}/${tab.segment}`)
          : pathname === base || pathname === `${base}/`;

        return (
          <Link
            key={tab.label}
            href={href}
            role="tab"
            aria-selected={isActive}
            onClick={(event) => {
              if (href !== pathname && isSameTabClick(event)) {
                announceNavigationStart(href);
              }
            }}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
