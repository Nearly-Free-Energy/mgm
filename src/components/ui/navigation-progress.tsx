"use client";

// NavigationProgress — global top loading bar for route transitions.
//
// Contract:
//   • Any client-side navigation link dispatches `announceNavigationStart(href)`
//     (window CustomEvent `mgm:navigation-start`) on click. This component shows
//     an indeterminate top bar immediately, so the click reads as recorded.
//   • The bar hides shortly after the committed URL — `usePathname()` plus
//     `useSearchParams()` — moves away from the one the navigation started
//     on, so a navigation that changes only the query (`?date=`) settles too.
//     A 4s safety timeout hides it if the URL never changes (failed nav).
//   • Back and forward start it as well, unless the history entry differs
//     only in its hash (the page stays where it is).
//   • Work that changes no URL can hold the bar: `announceNavigationHold()`
//     shows it and keeps it up through URL changes, until
//     `announceNavigationSettled()` hides it after the same short delay, or
//     the 4s safety timeout does. HostKitProvider holds it while it rebuilds
//     the manifest for an organization switch (`?org=`), which lands after
//     the URL has already changed.
//   • Token classes only (`bg-primary`); animation is `motion-safe` so
//     `prefers-reduced-motion` users get a static bar, not motion.
//   • `role="status"` + sr-only "Loading…" text announces the transition to
//     screen readers without moving focus.
//
// Invalidation: if App Router ever re-introduces router events, prefer them
// over this custom event — the event name is exported for that migration.

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";

export const MGM_NAVIGATION_START_EVENT = "mgm:navigation-start";
export const MGM_NAVIGATION_HOLD_EVENT = "mgm:navigation-hold";
export const MGM_NAVIGATION_SETTLED_EVENT = "mgm:navigation-settled";

export function announceNavigationStart(href: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string>(MGM_NAVIGATION_START_EVENT, { detail: href }),
  );
}

/** Shows the bar until announceNavigationSettled(), whatever the URL does meanwhile. */
export function announceNavigationHold() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MGM_NAVIGATION_HOLD_EVENT));
}

/** Ends a hold; the bar hides after the usual short delay. A start that is not a hold is left alone. */
export function announceNavigationSettled() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MGM_NAVIGATION_SETTLED_EVENT));
}

/**
 * A path and query in one spelling, so two spellings of the same URL compare
 * equal: the query re-serialised by URLSearchParams, the hash dropped.
 */
export function locationKey(pathname: string, search: string): string {
  const query = new URLSearchParams(search).toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Whether `href` names the page already shown, path and query alike, so
 * following it would not navigate anywhere: a link to it must not start
 * the bar. `here` is the shown page's locationKey; it defaults to the
 * browser's address.
 */
export function isCurrentLocation(href: string, here?: string): boolean {
  if (typeof window === "undefined") return false;
  const to = new URL(href, window.location.href);
  if (to.origin !== window.location.origin) return false;
  const current = here ?? locationKey(window.location.pathname, window.location.search);
  return locationKey(to.pathname, to.search) === current;
}

// A modified or non-primary click opens the link in a new tab or window and
// leaves this page where it is, so it must not start the bar.
export function isSameTabClick(event: React.MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  const location = locationKey(pathname ?? "", search);
  const [visible, setVisible] = React.useState(false);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Location the in-flight navigation started from. The hide effect keys off
  // transitions AWAY from this value — never off `visible`, which would
  // re-fire the effect on show and strangle the 4s safety (pr-374 review).
  const startRef = React.useRef<string | null>(null);
  // Whether the bar is held (announceNavigationHold): only a settle or the
  // safety timeout hides it then, not a URL change.
  const heldRef = React.useRef(false);
  // Latest committed location, readable from the listeners below.
  // Synced in an effect (never during render): clicks only land on committed
  // UI, so this is always the location the announced navigation starts from.
  const locationRef = React.useRef(location);
  React.useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // Show immediately on any announced navigation start, and on back or
  // forward to another page. When popstate fires the address bar already
  // shows the entry being restored, while the committed location is still
  // the one being left; an entry that differs only in its hash is skipped,
  // since nothing will commit to hide the bar.
  React.useEffect(() => {
    const show = (held: boolean) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      heldRef.current = held;
      // A hold keys off no location, so a URL change does not end it.
      startRef.current = held ? null : locationRef.current;
      setVisible(true);
      // Safety: never trap the bar on screen if the route never settles.
      hideTimer.current = setTimeout(() => {
        startRef.current = null;
        heldRef.current = false;
        setVisible(false);
      }, 4000);
    };
    const onStart = () => show(false);
    const onHold = () => show(true);
    const onSettled = () => {
      if (!heldRef.current) return;
      heldRef.current = false;
      startRef.current = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setVisible(false), 350);
    };
    const onPopState = () => {
      if (locationKey(window.location.pathname, window.location.search) !== locationRef.current) onStart();
    };
    window.addEventListener(MGM_NAVIGATION_START_EVENT, onStart);
    window.addEventListener(MGM_NAVIGATION_HOLD_EVENT, onHold);
    window.addEventListener(MGM_NAVIGATION_SETTLED_EVENT, onSettled);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener(MGM_NAVIGATION_START_EVENT, onStart);
      window.removeEventListener(MGM_NAVIGATION_HOLD_EVENT, onHold);
      window.removeEventListener(MGM_NAVIGATION_SETTLED_EVENT, onSettled);
      window.removeEventListener("popstate", onPopState);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // Hide shortly after the URL settles onto a new location. Skips the
  // mount render so the bar doesn't flash on first load, and ignores
  // re-renders where the location hasn't moved away from the start.
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (startRef.current == null) return;
    if (location === startRef.current) return;
    startRef.current = null;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // No cleanup here: a second change within the 350ms (a redirect, or a
    // GUI writing its own query with replaceState) must not cancel the hide,
    // since startRef is already cleared and nothing would schedule it again.
    // A new start clears it, and the listener effect clears it on unmount.
    hideTimer.current = setTimeout(() => setVisible(false), 350);
  }, [location]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-label="Loading page"
      className="fixed inset-x-0 top-0 z-[60] h-0.5 bg-transparent"
    >
      <div className="h-full w-1/3 bg-primary motion-safe:animate-[mgm-nav-progress_1s_ease-in-out_infinite]" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
