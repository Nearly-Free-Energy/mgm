"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  announceNavigationStart,
  isSameTabClick,
} from "@/components/ui/navigation-progress";
import { microgridSetupHref } from "@/lib/microgrid-links";

// Microgrid tab nav (D2 / #53).
//
// Tab order (Operations | Billing | Setup) mirrors the operator workflow:
//   1. Operations — one day of the site: battery, power cuts, dark time.
//      First because a microgrid opens here (microgridHref in
//      src/lib/microgrid-links.ts); if microgridHref points elsewhere,
//      revisit the order.
//   2. Billing    — the monthly close job (primary working surface).
//   3. Setup      — configure-once (edges, households, rate schedule).
//
// Tabs are next/link <Link>s so a click is a client-side navigation: the
// dashboard layout and this microgrid header stay mounted, and
// [id]/loading.tsx shows while the new tab renders.
//
// Each tab links to the page a click lands on, not to a URL that redirects:
// Setup links to its first sub-tab rather than the /setup index. Operations
// keeps its own literal rather than microgridHref, so the tab named
// Operations stays on that page if where a microgrid opens changes.
//
// Active-tab match: every tab uses `startsWith` on its segment, so nested
// routes (and Operations' ?date= days) stay highlighted. The microgrid index
// highlights nothing; middleware redirects it to Operations.

const tabs = [
  { label: "Operations", segment: "operations", href: (id: string) => `/microgrids/${id}/operations` },
  { label: "Billing",    segment: "billing",    href: (id: string) => `/microgrids/${id}/billing` },
  { label: "Setup",      segment: "setup",      href: microgridSetupHref },
] as const;

export function TabNav({ microgridId }: { microgridId: string }) {
  const pathname = usePathname();
  const base = `/microgrids/${microgridId}`;

  return (
    <nav
      className="flex space-x-1 overflow-x-auto border-b border-border"
      role="tablist"
      aria-label="Microgrid sections"
    >
      {tabs.map((tab) => {
        const href = tab.href(microgridId);
        const isActive = pathname.startsWith(`${base}/${tab.segment}`);

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
            className={`inline-flex shrink-0 items-center whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
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
