"use client";

/**
 * Links and navigation for GUIs. Links never prefetch: a page's data loads
 * when someone opens it, not when its link scrolls into view.
 */
import NextLink from "next/link";
import { usePathname as useNextPathname, useSearchParams } from "next/navigation";
import { useState, type MouseEvent } from "react";
import { announceNavigationStart, isSameTabClick } from "@/components/ui/navigation-progress";
import type { LinkProps } from "../../contract";
import { isHref } from "../shared/href";
import { useKitRuntime } from "./kit-runtime";

export { navigate, refresh } from "./kit-runtime";

export function usePathname(): string {
  const next = useNextPathname();
  return useKitRuntime().pathname ?? next ?? "/";
}

/**
 * A same-origin page link. `current` sets aria-current="page"; between a
 * click and the page changing it carries aria-busy and data-pending. An href
 * that is not a page on this site renders as plain text.
 */
export function Link({ href, children, className, current }: LinkProps) {
  const pathname = usePathname();
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  // Cleared once the pathname moves on, so coming back later is not pending.
  if (pendingFrom !== null && pendingFrom !== pathname) setPendingFrom(null);
  const pending = pendingFrom === pathname && !current;

  if (!isHref(href)) return <span className={className}>{children}</span>;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (href.split(/[?#]/, 1)[0] === pathname || !isSameTabClick(event)) return;
    setPendingFrom(pathname);
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
  // What this hook last wrote, kept until the URL it read moves on.
  const [written, setWritten] = useState<{ base: string | null; value: string | null } | null>(null);
  const value = written && written.base === fromUrl ? written.value : fromUrl;
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
