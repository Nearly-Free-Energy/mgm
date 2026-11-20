"use client";

/**
 * The installed app's icon badge (the Badging API). Browsers without it, or
 * a page not running as an installed app, simply show no badge: every call
 * is feature-detected and its rejection swallowed, so the badge can never
 * break a page. No service worker is involved; the page sets it while open.
 */

type Badging = { setAppBadge?(count?: number): Promise<void>; clearAppBadge?(): Promise<void> };

function badging(): Badging | null {
  return typeof navigator === "undefined" ? null : (navigator as Badging);
}

/** Calls `call` and drops what it throws or rejects with. */
function quietly(call: () => Promise<void> | undefined): void {
  try {
    call()?.catch(() => {});
  } catch {
    // A browser that throws synchronously (no permission, not installed) shows no badge.
  }
}

/** Clears the badge. */
export function clearAppBadge(): void {
  const nav = badging();
  if (typeof nav?.clearAppBadge === "function") quietly(() => nav.clearAppBadge!());
  else if (typeof nav?.setAppBadge === "function") quietly(() => nav.setAppBadge!(0));
}

/** Shows `count` on the badge, or clears it at zero. */
export function setAppBadge(count: number): void {
  if (!Number.isFinite(count) || count <= 0) return clearAppBadge();
  const nav = badging();
  if (typeof nav?.setAppBadge === "function") quietly(() => nav.setAppBadge!(Math.floor(count)));
}
