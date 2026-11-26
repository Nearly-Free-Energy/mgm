"use client";

/**
 * Links and navigation for GUIs. Links never prefetch: a page's data loads
 * when someone opens it, not when its link scrolls into view.
 */
import NextLink from "next/link";
import { usePathname as useNextPathname, useSearchParams } from "next/navigation";
import { useState, type MouseEvent } from "react";
import { announceNavigationStart, isCurrentLocation, isSameTabClick, locationKey } from "@/components/ui/navigation-progress";
import type { LinkProps } from "../../contract-react";
import { isHref } from "../shared/href";
import { useKitRuntime } from "./kit-runtime";

export { navigate, refresh } from "./kit-runtime";

export function usePathname(): string {
  const next = useNextPathname();
  return useKitRuntime().pathname ?? next ?? "/";
}

/**
 * The shown page's path and query as one locationKey. The query is the
 * router's; outside the Next.js router (jsdom, the conformance kit) it is the
 * browser's address, read only after hydration (it is never rendered).
 */
function useLocation(): string {
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params ? params.toString() : typeof window === "undefined" ? "" : window.location.search;
  return locationKey(pathname, search);
}

/**
 * A same-origin page link. `current` sets aria-current="page"; between a
 * click and the page changing it carries aria-busy and data-pending, and the
 * click starts the global NavigationProgress bar. A link to another query on
 * the same path (the next day) is a navigation like any other; one to the
 * page already shown, or a click that opens a new tab, is not. An href that
 * is not a page on this site renders as plain text.
 */
export function Link({ href, children, className, current }: LinkProps) {
  const location = useLocation();
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  // Cleared once the path or query moves on, so coming back later is not pending.
  if (pendingFrom !== null && pendingFrom !== location) setPendingFrom(null);
  const pending = pendingFrom === location && !current;

  if (!isHref(href)) return <span className={className}>{children}</span>;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isCurrentLocation(href, location) || !isSameTabClick(event)) return;
    setPendingFrom(location);
    announceNavigationStart(href);
  };
  return (
    <NextLink
      href={href}
      prefetch={false}
      className={className}
      aria-current={current ? "page" : undefined}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      onClick={onClick}
    >
      {children}
    </NextLink>
  );
}

function fromLocation(name: string): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name);
}

/**
 * GUI-owned state kept in the query string, such as a selection. Written with
 * history.replaceState, so no server render runs. The host drops `ui.*`
 * parameters before a loader runs either way (withoutUiParams in
 * ../server/access.ts; if that filter moves, revisit).
 */
export function useUiParam(name: `ui.${string}`): [string | null, (value: string | null) => void] {
  if (!/^ui\.[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`useUiParam: "${name}" must be "ui." followed by letters, digits, "_", "." or "-"`);
  }
  const params = useSearchParams();
  const fromUrl = params ? params.get(name) : fromLocation(name);
  // What this hook last wrote, shown only between the write and the URL it
  // reads catching up: while that URL still says what it said before the
  // write, and the address bar still carries the write. Dropped as soon as
  // either moves on (the URL acknowledged the write, or a navigation replaced
  // it), so a later navigation can never bring back a value the URL lacks.
  const [written, setWritten] = useState<{ base: string | null; value: string | null } | null>(null);
  const pending = written !== null && written.base === fromUrl && fromLocation(name) === written.value;
  if (written && !pending) setWritten(null);
  const value = pending ? written.value : fromUrl;
  const set = (next: string | null) => {
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete(name);
    else url.searchParams.set(name, next);
    // Not window.history.state: Next.js passes a state carrying its own
    // marker straight through, so useSearchParams would miss the change and
    // the router's next commit would write the old URL back. With null it
    // copies its state over and syncs (Next.js 16 app-router; recheck on upgrade).
    window.history.replaceState(null, "", url);
    setWritten({ base: fromUrl, value: next });
  };
  return [value, set];
}
