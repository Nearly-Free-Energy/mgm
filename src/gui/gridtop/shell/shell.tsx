"use client";

/**
 * Gridtop's frame: skip link, title bar, the apps, and the page. `main` is
 * what scrolls, at every size (decision 14 on #115), so a bar a page pins to
 * its bottom stays above the phone dock. Its padding is the old layout's,
 * except that it widens at 600 px rather than 768 px, and its zero minimum
 * width keeps wide legacy tables inside it. The frame pads itself by the
 * left and right safe-area insets, which the root viewport's
 * viewportFit "cover" leaves to the page (src/app/layout.tsx); the bottom
 * dock pads the bottom one.
 */
import type { ShellProps } from "@/lib/gui/contract";
import { kit } from "@/lib/gui/kit";
import { BottomDock } from "./bottom-dock";
import { Dock } from "./dock";
import { currentApp } from "./groups";
import { TitleBar } from "./title-bar";

export function GridtopShell({ children }: ShellProps) {
  const view = kit.useView();
  const pathname = kit.usePathname();
  const nav = view.org.nav;
  const current = currentApp(nav, (entry) => view.href(entry), pathname);
  return (
    <div className="gt:grid gt:h-screen gt:supports-[height:100dvh]:h-dvh gt:grid-rows-[auto_minmax(0,1fr)_auto] gt:bg-background gt:text-foreground gt:medium:grid-cols-[auto_minmax(0,1fr)] gt:medium:grid-rows-[auto_minmax(0,1fr)] gt:pl-[env(safe-area-inset-left)] gt:pr-[env(safe-area-inset-right)]">
      <a
        href="#main"
        className="gt:sr-only gt:focus:not-sr-only gt:focus:fixed gt:focus:top-2 gt:focus:left-2 gt:focus:z-50 gt:focus:rounded-md gt:focus:bg-card gt:focus:px-3 gt:focus:py-2 gt:focus:text-foreground gt:focus:outline-2 gt:focus:outline-ring"
      >
        Skip to content
      </a>
      <TitleBar />
      <Dock nav={nav} current={current} />
      <main id="main" tabIndex={-1} className="gt:min-w-0 gt:overflow-y-auto gt:p-4 gt:outline-none gt:medium:p-6">
        {children}
      </main>
      <BottomDock nav={nav} current={current} />
    </div>
  );
}
