"use client";

/**
 * Whether input came from the person, the one place the action host checks
 * it. A script can dispatch a click or set a checkbox, but the browser marks
 * every such event untrusted; only real input carries `isTrusted`. Component
 * tests mock isTrusted and hasUserActivation, because jsdom creates only
 * untrusted events; trusted.test.tsx runs them unmocked.
 */

type EventLike = { nativeEvent: Event } | Event;

const nativeOf = (event: EventLike): unknown =>
  event !== null && typeof event === "object" && "nativeEvent" in event ? event.nativeEvent : event;

/**
 * Whether `value` is an event the browser made, not an object shaped like
 * one: Event.prototype.composedPath throws for anything else, a prototype
 * copy or a plain object included.
 */
function isEvent(value: unknown): value is Event {
  if (typeof Event !== "function" || !(value instanceof Event)) return false;
  try {
    Event.prototype.composedPath.call(value);
    return true;
  } catch {
    return false;
  }
}

/** Reads an Event attribute through Event.prototype's own getter, so a property set on the object cannot answer for it. */
function attribute<K extends "type" | "target" | "eventPhase">(event: Event, key: K): Event[K] | undefined {
  const get = Object.getOwnPropertyDescriptor(Event.prototype, key)?.get;
  return get ? (get.call(event) as Event[K]) : undefined;
}

/** True only for an event the browser created from real input. */
export function isTrusted(event: EventLike): boolean {
  const native = nativeOf(event);
  // isTrusted is an own, non-configurable property of every real event.
  return isEvent(native) && native.isTrusted === true;
}

/** The native events React reports as a checkbox's onChange, and as a text input's. */
export const TICK_EVENTS = ["click", "change"] as const;
export const TYPING_EVENTS = ["input", "change"] as const;

/**
 * Whether `event` is one of `types` that the browser is dispatching right now
 * at `element` or inside it. An event kept from an earlier dispatch, an event
 * at anything else, or an object made to look like either answers false.
 */
export function isLiveEventOn(event: EventLike, element: Element | null, types: readonly string[]): boolean {
  const native = nativeOf(event);
  if (element === null || !isEvent(native)) return false;
  try {
    const target = attribute(native, "target");
    return (
      types.includes(attribute(native, "type") ?? "") &&
      attribute(native, "eventPhase") !== Event.NONE &&
      target instanceof Node &&
      element.contains(target)
    );
  } catch {
    return false;
  }
}

/** Whether `event` is a click the browser is dispatching right now at `element` or inside it. */
export const isClickOn = (event: EventLike, element: Element | null) => isLiveEventOn(event, element, ["click"]);

/**
 * An input's checked state and value, read through HTMLInputElement.prototype's
 * own getters, so a property set on the element cannot answer for either.
 */
export function readInput(input: HTMLInputElement): { checked: boolean; value: string } {
  const get = (key: "checked" | "value") => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, key)?.get;
  return { checked: get("checked")?.call(input) === true, value: String(get("value")?.call(input) ?? "") };
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
