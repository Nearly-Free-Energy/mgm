// Setup for the "gui" Vitest project (vitest.config.ts), which runs
// interface code in jsdom.
//
// jsdom has no layout engine, so it leaves out browser APIs that dialogs,
// menus, command lists and virtual lists call as soon as they mount. This
// file installs inert stand-ins for them, once per test file, so tests do
// not each stub them by hand. Each stand-in is installed only where jsdom
// has none, so a jsdom release that implements one keeps its own.
//
// It also installs a matchMedia that answers from a viewport width and a
// few media features a test can set:
//
//   import { setViewportWidth, setMediaFeatures } from "@/test/gui-setup";
//
//   setViewportWidth(360);
//   setMediaFeatures({ pointer: "coarse" });
//
// Both reset after every test. Call them before rendering, or inside
// act() while something is mounted, because they notify listeners.
//
// This file imports nothing from the app.

import { afterEach } from "vitest";

// ── Inert stand-ins ──────────────────────────────────────────────────────────

class ResizeObserverStandIn {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverStandIn {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds: readonly number[] = [0];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStandIn as unknown as typeof ResizeObserver;
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver =
    IntersectionObserverStandIn as unknown as typeof IntersectionObserver;
}

const elementProto = Element.prototype;
if (typeof elementProto.hasPointerCapture !== "function") {
  elementProto.hasPointerCapture = () => false;
}
if (typeof elementProto.setPointerCapture !== "function") {
  elementProto.setPointerCapture = () => {};
}
if (typeof elementProto.releasePointerCapture !== "function") {
  elementProto.releasePointerCapture = () => {};
}
if (typeof elementProto.scrollIntoView !== "function") {
  elementProto.scrollIntoView = () => {};
}

// ── A settable matchMedia ────────────────────────────────────────────────────

/** The width each test starts at: whatever jsdom reports before any test runs. */
const DEFAULT_WIDTH = window.innerWidth;

/** The media features each test starts with: a mouse on a light screen. */
const DEFAULT_FEATURES: Readonly<Record<string, string>> = {
  pointer: "fine",
  "any-pointer": "fine",
  hover: "hover",
  "any-hover": "hover",
  "prefers-color-scheme": "light",
  "prefers-contrast": "no-preference",
  "prefers-reduced-motion": "no-preference",
};

const media = {
  width: DEFAULT_WIDTH,
  features: { ...DEFAULT_FEATURES } as Record<string, string>,
};

/** Lists something has listened to, so a change can reach their listeners. */
const subscribed = new Set<SettableMediaQueryList>();

class SettableMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  private last = false;
  private handler: MediaQueryList["onchange"] = null;
  /** Runs `onchange` from the listener list, in the order it was set, as a browser does. */
  private readonly runHandler = (event: Event) => {
    this.handler?.call(this, event as MediaQueryListEvent);
  };

  constructor(query: string) {
    super();
    this.media = query;
  }

  /** Live, as in a browser: read again after the viewport changes. */
  get matches(): boolean {
    return matchesMediaQuery(this.media);
  }

  get onchange(): MediaQueryList["onchange"] {
    return this.handler;
  }

  set onchange(handler: MediaQueryList["onchange"]) {
    const had = this.handler !== null;
    this.handler = handler ?? null;
    if (this.handler && !had) this.addEventListener("change", this.runHandler);
    if (!this.handler && had) this.removeEventListener("change", this.runHandler);
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "change") this.subscribe();
    super.addEventListener(type, listener, options);
  }

  /** The deprecated alias some libraries still call. */
  addListener(listener: Parameters<MediaQueryList["addListener"]>[0]): void {
    if (listener) this.addEventListener("change", listener as EventListener);
  }

  removeListener(listener: Parameters<MediaQueryList["removeListener"]>[0]): void {
    if (listener) this.removeEventListener("change", listener as EventListener);
  }

  /** Fires "change" if the last setting flipped this query's result. */
  notify(): void {
    const matches = this.matches;
    if (matches === this.last) return;
    this.last = matches;
    this.dispatchEvent(Object.assign(new Event("change"), { matches, media: this.media }));
  }

  private subscribe(): void {
    if (!subscribed.has(this)) this.last = this.matches;
    subscribed.add(this);
  }
}

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => new SettableMediaQueryList(query),
});

/**
 * Sets the viewport width that `window.innerWidth` and `matchMedia` report,
 * then fires `resize` if the width changed, and after it the `change`
 * listeners of every query whose result flipped.
 */
export function setViewportWidth(width: number): void {
  const changed = width !== media.width;
  media.width = width;
  window.innerWidth = width;
  if (changed) window.dispatchEvent(new Event("resize"));
  for (const list of subscribed) list.notify();
}

/**
 * Sets media features such as `pointer`, `hover`, `prefers-color-scheme`
 * or `prefers-reduced-motion`, then fires `change` listeners whose query
 * flipped. Values are compared as written in the query, so
 * `{ pointer: "coarse" }` makes `(pointer: coarse)` match.
 */
export function setMediaFeatures(features: Record<string, string>): void {
  Object.assign(media.features, features);
  for (const list of subscribed) list.notify();
}

afterEach(() => {
  media.features = { ...DEFAULT_FEATURES };
  setViewportWidth(DEFAULT_WIDTH);
});

// ── Media query evaluation ───────────────────────────────────────────────────
//
// Enough of Media Queries level 4 for component code: comma lists, `not` and
// `only`, the `all` and `screen` types, `and`, width as `min-width`,
// `max-width`, `width` or a range such as `(600px <= width < 1280px)` in px,
// rem or em (16px), and features compared by value. Anything else does not
// match, as an unknown feature does in a browser.

const ROOT_FONT_SIZE_PX = 16;
const COMPARISON = /\s*(<=|>=|<|>|=)\s*/;

function matchesMediaQuery(query: string): boolean {
  // An empty query list matches everything, as matchMedia("") does.
  if (query.trim() === "") return true;
  return query.split(",").some((part) => matchesOne(part.trim().toLowerCase()));
}

function matchesOne(query: string): boolean {
  let negate = false;
  let rest = query;
  if (rest.startsWith("not ")) {
    negate = true;
    rest = rest.slice(4).trim();
  } else if (rest.startsWith("only ")) {
    rest = rest.slice(5).trim();
  }
  if (rest === "") return false;
  const result = rest.split(/\s+and\s+/).every((term) => matchesTerm(term.trim()));
  return negate ? !result : result;
}

function matchesTerm(term: string): boolean {
  if (term === "all" || term === "screen") return true;
  if (!term.startsWith("(") || !term.endsWith(")")) return false;
  const inner = term.slice(1, -1).trim();

  const range = inner.split(COMPARISON);
  if (range.length === 3 || range.length === 5) {
    if (!range.includes("width")) return false;
    for (let i = 0; i + 2 < range.length; i += 2) {
      const left = rangeOperand(range[i]);
      const right = rangeOperand(range[i + 2]);
      if (!compare(left, range[i + 1], right)) return false;
    }
    return true;
  }

  const colon = inner.indexOf(":");
  if (colon === -1) {
    if (inner === "width") return media.width > 0;
    const value = media.features[inner];
    return value !== undefined && value !== "none" && value !== "no-preference";
  }
  const name = inner.slice(0, colon).trim();
  const value = inner.slice(colon + 1).trim();
  if (name === "min-width") return media.width >= toPx(value);
  if (name === "max-width") return media.width <= toPx(value);
  if (name === "width") return media.width === toPx(value);
  return media.features[name] === value;
}

function rangeOperand(operand: string): number {
  return operand === "width" ? media.width : toPx(operand);
}

function compare(left: number, operator: string, right: number): boolean {
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "=":
      return left === right;
    default:
      return false;
  }
}

/** A length in px, or NaN (which matches nothing) for a unit it does not read. */
function toPx(length: string): number {
  const match = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(length);
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  if (match[2] === "rem" || match[2] === "em") return amount * ROOT_FONT_SIZE_PX;
  if (match[2] === undefined && amount !== 0) return Number.NaN;
  return amount;
}
