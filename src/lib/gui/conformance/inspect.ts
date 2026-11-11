/**
 * What the checks read out of a model and out of the rendered document.
 * Models are walked as plain JSON, so a value, action or href nested in a
 * feed's embedded view counts like any other.
 */
import { queryAllByRole } from "@testing-library/react";
import type { CoreEntityKind, EntityRef, ActionRef, LinkRef, Manifest, Value } from "../contract";
import { fillNavHref } from "../host/client/kit-provider";
import type { ManifestFixture } from "./fixtures/manifests";

type Node = Record<string, unknown>;

function walk(root: unknown, visit: (node: Node) => void): void {
  const seen = new Set<unknown>();
  const go = (node: unknown) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node)) visit(node as Node);
    for (const child of Object.values(node)) go(child);
  };
  go(root);
}

function collect<T>(root: unknown, keep: (node: Node) => boolean): T[] {
  const out: T[] = [];
  walk(root, (node) => keep(node) && out.push(node as T));
  return out;
}

const isString = (v: unknown): v is string => typeof v === "string";

export const valuesOf = (root: unknown) => collect<Value>(root, (n) => isString(n.t) && isString(n.text));
export const refsOf = (root: unknown) =>
  collect<ActionRef>(root, (n) => isString(n.action) && isString(n.label) && typeof n.enabled === "boolean");
/** LinkRefs; an EntityRef also has an id, label and href, but it has a kind. */
export const linksOf = (root: unknown) =>
  collect<LinkRef>(root, (n) => isString(n.id) && isString(n.label) && isString(n.href) && !("kind" in n));

export function choicesOf(manifest: Manifest, kind: CoreEntityKind): EntityRef[] {
  if (kind === "organization") return manifest.orgs.map((o) => ({ kind, id: o.id, label: o.name, href: o.href }));
  return manifest.org.places.filter((place) => place.kind === kind);
}

/**
 * Every href the host hands a GUI on this page: those in the manifest, the
 * initial view, the signals and `extra` (a model), plus each nav entry filled
 * from the scope or from any one place, as ViewState.href() fills it.
 */
export function hostHrefs(fixture: ManifestFixture, ...extra: unknown[]): Set<string> {
  const hrefs = new Set<string>();
  walk([fixture.manifest, fixture.initial, fixture.signals, extra], (node) => {
    for (const key of ["href", "link", "open", "next"]) if (isString(node[key])) hrefs.add(node[key]);
  });
  const { manifest, initial } = fixture;
  for (const entry of manifest.org.nav) {
    const scoped = fillNavHref(manifest, entry, initial.scope);
    if (scoped) hrefs.add(scoped);
    for (const kind of entry.needs) {
      for (const choice of choicesOf(manifest, kind)) {
        const picked = fillNavHref(manifest, entry, initial.scope, { [kind]: choice });
        if (picked) hrefs.add(picked);
      }
    }
  }
  return hrefs;
}

export const pageText = () => document.body.textContent ?? "";

/** The innermost elements whose text contains `text`. */
export function holding(text: string, root: Element = document.body): Element[] {
  return [...root.querySelectorAll("*")].filter(
    (el) => el.textContent?.includes(text) && ![...el.children].some((child) => child.textContent?.includes(text)),
  );
}

/**
 * Whether `el` or an ancestor within two levels has text, an aria-label or a
 * title matching `re`. The climb stops below the first ancestor whose text
 * holds any of `others` (the other values' texts), so a mark can only be
 * found in the part of the page that holds this value alone, whether the GUI
 * lays values out as cells, fields, cards or tiles. Telling values apart by
 * text rests on each value's text being found in no other value of its model
 * (__tests__/fixtures.test.ts); if a fixture breaks that, revisit this.
 */
export function markedNear(el: Element, re: RegExp, others: readonly string[]): boolean {
  let at: Element | null = el;
  for (let level = 0; at && level <= 2; level++, at = at.parentElement) {
    const text = at.textContent ?? "";
    if (level > 0 && others.some((other) => text.includes(other))) return false;
    if ([text, at.getAttribute("aria-label"), at.getAttribute("title")].some((s) => s && re.test(s))) return true;
  }
  return false;
}

const NAMED_ROLES = ["button", "link", "menuitem", "tab", "checkbox", "textbox", "combobox"] as const;

/** The parts of check 8 that need no Shell: unnamed controls, a positive tabindex, a tab with an href. */
export function controlIssues(): string[] {
  const found: string[] = [];
  for (const role of NAMED_ROLES) {
    const unnamed = queryAllByRole(document.body, role, { name: "" }).length;
    if (unnamed > 0) found.push(`has ${unnamed} ${role} element(s) without an accessible name`);
  }
  for (const el of document.body.querySelectorAll("[tabindex]")) {
    if (Number(el.getAttribute("tabindex")) > 0) found.push(`sets tabindex="${el.getAttribute("tabindex")}" on a <${el.tagName.toLowerCase()}>`);
  }
  if (document.body.querySelector('[role="tab"][href]')) found.push('gives an element with role="tab" an href');
  return found;
}
