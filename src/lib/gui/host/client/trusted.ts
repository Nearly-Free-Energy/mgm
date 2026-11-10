"use client";

/**
 * Whether input came from the person, the one place the action host checks
 * it. A script can dispatch a click or set a checkbox, but the browser marks
 * every such event untrusted; only real input carries `isTrusted`. Component
 * tests mock this module, because jsdom creates only untrusted events;
 * trusted.test.tsx runs it unmocked.
 */

/** True only for an event the browser created from real input. */
export function isTrusted(event: { nativeEvent: Event } | Event): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isTrusted === true;
}

/**
 * Whether the page has a fresh user gesture (navigator.userActivation). A
 * browser without the API is treated as active, so the check never blocks a
 * person; where it exists, a write started without a gesture gets a confirm
 * step (decision 5 on #115).
 */
export function hasUserActivation(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return activation?.isActive !== false;
}
