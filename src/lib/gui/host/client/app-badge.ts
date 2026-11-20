"use client";

/**
 * The installed app's icon badge (the Badging API). Browsers without it, or
 * a page not running as an installed app, simply show no badge: every call
 * is feature-detected and its rejection swallowed, so the badge can never
 * break a page. No service worker is involved; the page sets it while open.
 *
 * Once this page has signed the person out (markSignedOut), setAppBadge does
 * nothing for the rest of the page's life, so a signals answer that lands
 * after sign-out cannot put a count back on the icon; /login, which mounts
 * no signals feed, clears the badge again when it shows.
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

let signedOut = false;

/** This page signed the person out: clear the badge and set it no more. */
export function markSignedOut(): void {
  signedOut = true;
  clearAppBadge();
}

/** Whether this page has signed the person out. */
export const isSignedOut = (): boolean => signedOut;

/** Clears the badge. */
export function clearAppBadge(): void {
  const nav = badging();
  if (typeof nav?.clearAppBadge === "function") quietly(() => nav.clearAppBadge!());
  else if (typeof nav?.setAppBadge === "function") quietly(() => nav.setAppBadge!(0));
}

/** Shows `count` on the badge, or clears it at zero; nothing after markSignedOut. */
export function setAppBadge(count: number): void {
  if (signedOut) return;
  if (!Number.isFinite(count) || count <= 0) return clearAppBadge();
  const nav = badging();
  if (typeof nav?.setAppBadge === "function") quietly(() => nav.setAppBadge!(Math.floor(count)));
}
