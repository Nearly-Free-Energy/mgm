/**
 * What a person can reach from the rendered document: activates every
 * control, breadth first, and collects the hrefs, labels and kit calls that
 * follow. Searches document.body, so portalled menus and sheets count.
 */
import { act, fireEvent, queryAllByRole } from "@testing-library/react";
import type { Recorded } from "./harness";

export interface Reachable {
  /** Every anchor's href seen, plus every navigate() the runtime recorded. */
  hrefs: Set<string>;
  /** The accessible name, text and aria-label of every control seen. */
  names: Set<string>;
}

const ROLES = ["button", "link", "menuitem", "tab", "option", "combobox"] as const;
const CONTROLS = ["button", "a[href]", "summary", "select"].concat(ROLES.map((role) => `[role="${role}"]`)).join(",");

const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
const keyOf = (el: Element) =>
  [el.tagName, el.getAttribute("role") ?? "", nameOf(el), el.getAttribute("href") ?? ""].join("|");
const enabled = (el: Element) => !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true";

/** A real mouse click's events. Enter is not sent: on a menu trigger it would close what pointerdown opened. */
async function activate(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0 });
    fireEvent.mouseDown(el, { button: 0 });
    fireEvent.pointerUp(el, { button: 0 });
    fireEvent.mouseUp(el, { button: 0 });
    fireEvent.click(el, { button: 0 });
  });
}

const find = (key: string) => [...document.body.querySelectorAll(CONTROLS)].find((el) => keyOf(el) === key);

export async function crawl(log: Recorded, opts: { depth?: number; max?: number } = {}): Promise<Reachable> {
  const { depth: maxDepth = 3, max = 300 } = opts;
  const hrefs = new Set<string>();
  const names = new Set<string>();
  const seen = new Set<string>();
  const queue: { key: string; path: string[] }[] = [];
  const named = new Set<string>();
  const record = (name: string) => {
    names.add(name);
    return false;
  };
  const collect = (path: string[]) => {
    let fresh = false;
    for (const el of document.body.querySelectorAll(CONTROLS)) {
      const href = el.getAttribute("href");
      if (href !== null) hrefs.add(href);
      names.add(nameOf(el));
      const key = keyOf(el);
      if (!named.has(key)) {
        named.add(key);
        fresh = true;
      }
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
    collect([]);
    for (let done = 0; queue.length > 0 && done < max; ) {
      const { key, path } = queue.shift()!;
      if (path.length >= maxDepth) continue;
      // What revealed this control may have closed since: open it again.
      for (const step of path) {
        if (find(key)) break;
        const opener = find(step);
        if (opener) await activate(opener);
      }
      const el = find(key);
      if (!el) continue;
      await activate(el);
      done++;
      collect([...path, key]);
    }
  } finally {
    document.removeEventListener("click", stay, true);
    document.removeEventListener("submit", stay, true);
  }
  for (const href of log.navigate) hrefs.add(href);
  return { hrefs, names };
}
