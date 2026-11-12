/**
 * What a person can reach from the rendered document: activates every
 * control, breadth first, and collects the hrefs, labels and kit calls that
 * follow. Searches document.body, so portalled menus and sheets count.
 */
import { act, fireEvent, queryAllByRole } from "@testing-library/react";
import type { ActionRef } from "../contract";
import type { Recorded } from "./harness";

/** A kit.act call the crawl caused, with the name and description of the control it pressed. */
export interface Acted {
  ref: ActionRef;
  name: string;
  description: string;
}

export interface Reachable {
  /** Every anchor's href seen, plus every navigate() and open() the runtime recorded. */
  hrefs: Set<string>;
  /** The accessible name, text and aria-label of every control seen. */
  names: Set<string>;
  /** Every kit.act call a pressed control made. */
  acted: Acted[];
}

const ROLES = ["button", "link", "menuitem", "tab", "option", "combobox"] as const;
export const CONTROLS = ["button", "a[href]", "summary", "select", "select option"].concat(ROLES.map((role) => `[role="${role}"]`)).join(",");

const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
const nameOf = (el: Element) => squash(el.getAttribute("aria-label") ?? el.textContent);
const textOf = (ids: string | null) =>
  squash((ids ?? "").split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent : "")).join(" "));
/** A control's name: what aria-labelledby points at, else aria-label, else its text. */
export const controlName = (el: Element) => textOf(el.getAttribute("aria-labelledby")) || nameOf(el);
/** A control's description: what aria-describedby points at, and its title. */
export const controlDescription = (el: Element) => squash(`${textOf(el.getAttribute("aria-describedby"))} ${el.getAttribute("title") ?? ""}`);
const keyOf = (el: Element) =>
  [el.tagName, el.getAttribute("role") ?? "", nameOf(el), el.getAttribute("href") ?? ""].join("|");
export const enabled = (el: Element) =>
  !el.matches(":disabled") &&
  el.getAttribute("aria-disabled") !== "true" &&
  !(el instanceof HTMLOptionElement && el.closest("select:disabled, optgroup[disabled]"));

/**
 * A real mouse click's events. Enter is not sent: on a menu trigger it would close what pointerdown opened.
 * A native option is chosen instead, with the input and change events a browser sends; choosing the
 * option already selected sends none.
 */
async function activate(el: Element): Promise<void> {
  if (el instanceof HTMLOptionElement) {
    const select = el.closest("select");
    if (!select || el.selected) return;
    await act(async () => {
      fireEvent.input(select, { target: { value: el.value } });
      fireEvent.change(select);
    });
    return;
  }
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0 });
    fireEvent.mouseDown(el, { button: 0 });
    fireEvent.pointerUp(el, { button: 0 });
    fireEvent.mouseUp(el, { button: 0 });
    fireEvent.click(el, { button: 0 });
  });
}

export async function crawl(log: Recorded, opts: { depth?: number; max?: number } = {}): Promise<Reachable> {
  const { depth: maxDepth = 3, max = 300 } = opts;
  const hrefs = new Set<string>();
  const names = new Set<string>();
  const seen = new Set<string>();
  const queue: { key: string; path: string[] }[] = [];
  const named = new Set<string>();
  const acted: Acted[] = [];
  const record = (name: string) => {
    names.add(name);
    return false;
  };
  // A control's identity is fixed when it first appears. A link is its label and href. Any other
  // control is also told apart by what revealed it and its place among same-named controls revealed
  // with it, so two menus' "More" buttons are both explored.
  const ids = new WeakMap<Element, string>();
  const identify = (parent: string) => {
    const counts = new Map<string, number>();
    for (const el of document.body.querySelectorAll(CONTROLS)) {
      if (ids.has(el)) continue;
      const base = keyOf(el);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      ids.set(el, el.hasAttribute("href") ? base : `${parent} > ${base} #${n}`);
    }
  };
  const find = (key: string) => [...document.body.querySelectorAll(CONTROLS)].find((el) => ids.get(el) === key);
  // Every activation, reopening steps included, so a crawl of a GUI that remounts its controls stays bounded.
  let activations = 0;
  const limit = max * (maxDepth + 1);
  const press = async (el: Element, parent: string) => {
    activations++;
    const before = log.act.length;
    await activate(el);
    for (const ref of log.act.slice(before)) acted.push({ ref, name: controlName(el), description: controlDescription(el) });
    identify(parent);
  };
  const collect = (path: string[]) => {
    let fresh = false;
    for (const el of document.body.querySelectorAll(CONTROLS)) {
      const href = el.getAttribute("href");
      if (href !== null) hrefs.add(href);
      names.add(nameOf(el));
      const label = keyOf(el);
      if (!named.has(label)) {
        named.add(label);
        fresh = true;
      }
      const key = ids.get(el)!;
      if (!seen.has(key) && enabled(el)) {
        seen.add(key);
        queue.push({ key, path });
      }
    }
    // Computed accessible names too, so aria-labelledby and alt text count. Only
    // when a control appeared, because computing them is slow in jsdom.
    if (fresh) for (const role of ROLES) queryAllByRole(document.body, role, { hidden: true, name: record });
  };
  // Links and forms stay put: jsdom cannot load another page.
  const stay = (event: Event) => {
    if (event.type === "submit" || (event.target as Element | null)?.closest?.("a[href]")) event.preventDefault();
  };
  document.addEventListener("click", stay, true);
  document.addEventListener("submit", stay, true);
  try {
    identify("");
    collect([]);
    for (let done = 0; queue.length > 0 && done < max && activations < limit; ) {
      const { key, path } = queue.shift()!;
      if (path.length >= maxDepth) continue;
      // What revealed this control may have closed since: open it again.
      for (const step of path) {
        if (find(key)) break;
        const opener = find(step);
        if (opener) await press(opener, step);
      }
      const el = find(key);
      if (!el) continue;
      await press(el, key);
      done++;
      collect([...path, key]);
    }
  } finally {
    document.removeEventListener("click", stay, true);
    document.removeEventListener("submit", stay, true);
  }
  for (const href of log.navigate) hrefs.add(href);
  for (const link of log.open) hrefs.add(link.href);
  return { hrefs, names, acted };
}
